#!/usr/bin/env node
/**
 * tracker-reaper.mjs
 * ACMI tracker maintenance — two modes:
 *   --reap   scan for stalled items (run every 6h via cron)
 *   --close  weekly closer: summarize + archive done trackers (Mon 11:00)
 *
 * Required env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */

const url = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '') + '/';
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  console.error('ERROR: Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  process.exit(1);
}

async function redis(cmd, ...args) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([cmd, ...args]),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

async function writeEvent(key, payload) {
  const ts = payload.ts ?? Date.now();
  await redis('ZADD', key, ts, JSON.stringify({ ts, ...payload }));
}

const STALLED_THRESHOLD_MS = 7 * 24 * 3600 * 1000;   // 7 days
const HITL_THRESHOLD_MS   = 14 * 24 * 3600 * 1000;  // 14 days

// ---- REAPER MODE ----
async function reap() {
  const trackers = await redis('SMEMBERS', 'acmi:tracker:list');
  if (!Array.isArray(trackers) || trackers.length === 0) {
    console.log('No trackers found — nothing to reap.');
    return;
  }

  const now = Date.now();
  const windowStart = now - STALLED_THRESHOLD_MS;
  let stalledTotal = 0;

  for (const tracker of trackers) {
    const profileRaw = await redis('GET', `acmi:tracker:${tracker}:profile`);
    if (!profileRaw) continue;

    let profile;
    try { profile = JSON.parse(profileRaw); } catch { continue; }

    const items = Array.isArray(profile.items) ? profile.items : [];
    const openItems = items.filter(i => ['open', 'in-progress', 'handoff-pending'].includes(i.status));
    if (openItems.length === 0) continue;

    // Pull tracker timeline events in the stall window
    const events = await redis('ZRANGEBYSCORE', `acmi:tracker:${tracker}:timeline`, windowStart, '+inf');
    const recentEventText = (events || []).join(' ');

    for (const item of openItems) {
      const itemId = item.id || item.title;
      const sentinelKey = `acmi:tracker-reaper:flagged:${tracker}:${itemId}:${isoWeek(now)}`;
      const alreadyFlagged = await redis('EXISTS', sentinelKey);
      if (alreadyFlagged) continue;

      const mentioned = recentEventText.includes(itemId);
      if (!mentioned) {
        const enqueueTs = item.enqueued_ms || item.ts || 0;
        const idleMs = now - enqueueTs;
        stalledTotal++;

        const eventPayload = {
          source: 'tracker-reaper',
          kind: 'stalled-item-detected',
          summary: `[stalled] ${tracker}/${itemId} — no progress event in 7d`,
          payload: { tracker, item_id: itemId, idle_ms: idleMs },
        };

        await writeEvent(`acmi:thread:bentley-pm:timeline`, eventPayload);
        await writeEvent(`acmi:tracker:${tracker}:timeline`, eventPayload);

        if (idleMs > HITL_THRESHOLD_MS) {
          const hitlDeadline = now + 3 * 24 * 3600 * 1000;
          await redis('ZADD', 'acmi:user:mikey:hitl-queue', hitlDeadline, JSON.stringify({
            kind: 'hitl-required',
            summary: `[HITL] tracker-reaper: ${tracker}/${itemId} idle >14d`,
            payload: { blocker: `Item idle for ${Math.round(idleMs / 86400000)}d`, tracker, item_id: itemId, deadline_ms: hitlDeadline, agent: 'tracker-reaper' },
          }));
        }

        await redis('SET', sentinelKey, '1', 'EX', 7 * 24 * 3600);
      }
    }
  }

  console.log(JSON.stringify({ mode: 'reap', trackers_checked: trackers.length, stalled_flagged: stalledTotal }));
}

// ---- CLOSER MODE ----
async function close() {
  const trackers = await redis('SMEMBERS', 'acmi:tracker:list');
  if (!Array.isArray(trackers) || trackers.length === 0) {
    console.log('No trackers — nothing to close.');
    return;
  }

  const now = Date.now();
  let archived = 0;

  for (const tracker of trackers) {
    const profileRaw = await redis('GET', `acmi:tracker:${tracker}:profile`);
    if (!profileRaw) continue;

    let profile;
    try { profile = JSON.parse(profileRaw); } catch { continue; }

    const items = Array.isArray(profile.items) ? profile.items : [];
    const done   = items.filter(i => i.status === 'done' || i.status === 'completed').length;
    const open   = items.filter(i => ['open', 'in-progress', 'handoff-pending'].includes(i.status)).length;
    const stalled = items.filter(i => i.status === 'stalled').length;

    const summaryPayload = {
      source: 'tracker-reaper',
      kind: 'tracker-summary',
      summary: `[weekly] ${tracker}: ${done} done / ${open} open / ${stalled} stalled`,
      payload: { tracker, items_done: done, items_open: open, items_stalled: stalled },
    };
    await writeEvent('acmi:thread:bentley-pm:timeline', summaryPayload);

    if (open === 0 && items.length > 0 && done === items.length) {
      await redis('SADD', 'acmi:tracker:archived', tracker);
      await redis('SREM', 'acmi:tracker:list', tracker);
      await writeEvent(`acmi:tracker:${tracker}:timeline`, {
        source: 'tracker-reaper',
        kind: 'tracker-archived',
        summary: `[archived] ${tracker} — all ${done} items complete`,
      });
      archived++;
    }
  }

  console.log(JSON.stringify({ mode: 'close', trackers_checked: trackers.length, archived }));
}

function isoWeek(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return `${d.getFullYear()}-W${String(1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
}

const mode = process.argv[2];
if (mode === '--reap') {
  reap().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
} else if (mode === '--close') {
  close().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
} else {
  console.error('Usage: tracker-reaper.mjs --reap | --close');
  process.exit(1);
}
