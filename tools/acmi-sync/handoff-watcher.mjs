#!/usr/bin/env node
/**
 * handoff-watcher.mjs
 * Scans ACMI timelines for unacked handoff-request events.
 * - age 12-24h: post pending-ack nudge to target agent timeline
 * - age >24h: ZADD hitl-required to acmi:user:mikey:hitl-queue
 * Idempotent via sentinel keys acmi:handoff-watcher:nudged:<correlation_id>
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

const SCAN_TIMELINES = [
  'acmi:thread:agent-coordination:timeline',
  'acmi:thread:bentley-pm:timeline',
  'acmi:thread:claude-daily-driver:timeline',
];

const ACK_KINDS = new Set(['handoff-ack', 'item-completed', 'fix-applied', 'fleet-N-complete']);
const NUDGE_WINDOW_MS  = 12 * 3600 * 1000;
const HITL_WINDOW_MS   = 24 * 3600 * 1000;

async function scanTimeline(key) {
  const raw = await redis('ZRANGE', key, '-inf', '+inf', 'BYSCORE', 'LIMIT', '0', '500');
  if (!Array.isArray(raw)) return [];
  return raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

async function run() {
  const now = Date.now();
  const allEvents = [];

  for (const tl of SCAN_TIMELINES) {
    const events = await scanTimeline(tl);
    allEvents.push(...events);
  }

  const handoffRequests = allEvents.filter(e => e.kind === 'handoff-request' && e.correlation_id);
  const ackEvents = allEvents.filter(e => ACK_KINDS.has(e.kind) && e.correlation_id);

  const ackedCorrelations = new Set(ackEvents.map(e => e.correlation_id));

  let nudged = 0, escalated = 0;

  for (const req of handoffRequests) {
    const corrId = req.correlation_id;
    if (ackedCorrelations.has(corrId)) continue;

    const ageMs = now - (req.ts || 0);
    if (ageMs < NUDGE_WINDOW_MS) continue;

    const sentinelKey = `acmi:handoff-watcher:nudged:${corrId}`;
    const alreadyNudged = await redis('EXISTS', sentinelKey);

    if (ageMs >= HITL_WINDOW_MS) {
      const hitlKey = `acmi:handoff-watcher:hitl:${corrId}`;
      const alreadyHitl = await redis('EXISTS', hitlKey);
      if (alreadyHitl) continue;

      const deadline = now + 3 * 24 * 3600 * 1000;
      const hitlPayload = {
        kind: 'hitl-required',
        summary: `[HITL] handoff-watcher: unacked handoff-request (corr=${corrId}) >24h`,
        payload: {
          blocker: `Handoff unacked for ${Math.round(ageMs / 3600000)}h`,
          correlation_id: corrId,
          tried: ['pending-ack nudge'],
          decision_needed: 'ack the handoff / re-route / cancel',
          deadline_ms: deadline,
          agent: 'handoff-watcher',
        },
      };
      await redis('ZADD', 'acmi:user:mikey:hitl-queue', deadline, JSON.stringify(hitlPayload));

      const targetAgent = req.target_agent || req.source || 'claude-engineer';
      await writeEvent(`acmi:agent:${targetAgent}:timeline`, { ...hitlPayload, source: 'handoff-watcher' });
      await writeEvent('acmi:thread:bentley-pm:timeline', { ...hitlPayload, source: 'handoff-watcher' });

      await redis('SET', hitlKey, '1', 'EX', 7 * 24 * 3600);
      escalated++;
    } else if (!alreadyNudged) {
      const targetAgent = req.target_agent || req.source || 'claude-engineer';
      const nudgePayload = {
        source: 'handoff-watcher',
        kind: 'pending-ack',
        summary: `[nudge] handoff-request unacked for ${Math.round(ageMs / 3600000)}h (corr=${corrId})`,
        payload: { correlation_id: corrId, age_h: Math.round(ageMs / 3600000) },
      };
      await writeEvent(`acmi:agent:${targetAgent}:timeline`, nudgePayload);
      await redis('SET', sentinelKey, '1', 'EX', 24 * 3600);
      nudged++;
    }
  }

  console.log(JSON.stringify({
    timelines_scanned: SCAN_TIMELINES.length,
    handoff_requests_found: handoffRequests.length,
    unacked: handoffRequests.filter(r => !ackedCorrelations.has(r.correlation_id)).length,
    nudged,
    escalated,
  }));
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
