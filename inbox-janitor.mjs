#!/usr/bin/env node
/**
 * inbox-janitor.mjs — daily inbox maintenance agent.
 * Schedule: 06:00 UTC daily (cron: "0 6 * * *")
 * - Re-prioritizes pending items idle > 48h
 * - Retries failed items with retry_count < 3 and expired lease
 * - Archives completed items older than 30d
 * - Posts daily summary to gene + claude-daily-driver timelines
 * Idempotent.
 */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('ERROR: Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN.');
  process.exit(1);
}

async function redis(cmd, ...args) {
  const res = await fetch(`${UPSTASH_URL.replace(/\/$/, '')}/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([cmd, ...args]),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

const K = {
  pending:   'acmi:inbox:claude-engineer:pending',
  processing:'acmi:inbox:claude-engineer:processing',
  completed: 'acmi:inbox:claude-engineer:completed',
  failed:    'acmi:inbox:claude-engineer:failed',
  archive:   'acmi:inbox:claude-engineer:completed-archive',
  lease:     (id) => `acmi:inbox:claude-engineer:lease:${id}`,
  gene:      'acmi:agent:gene:timeline',
  thread:    'acmi:thread:claude-daily-driver:timeline',
};

function nowMs() { return Date.now(); }
const dryRun = process.argv.includes('--dry-run');
const IDLE_THRESHOLD_MS = 48 * 3600 * 1000;
const ARCHIVE_THRESHOLD_MS = 30 * 24 * 3600 * 1000;
const stats = { reprioritized: 0, retried: 0, archived: 0 };

// ---- 1. Re-prioritize idle pending items ----
const pendingRaw = await redis('ZRANGE', K.pending, 0, -1, 'WITHSCORES');
const now = nowMs();
if (Array.isArray(pendingRaw)) {
  for (let i = 0; i < pendingRaw.length; i += 2) {
    try {
      const item = JSON.parse(pendingRaw[i]);
      const score = Number(pendingRaw[i + 1]);
      const enqueued = item.ts_enqueued_ms || score;
      if (now - enqueued < IDLE_THRESHOLD_MS) continue;
      if ((item.priority || 2) <= 1) continue; // already max priority

      const newPriority = Math.max(1, (item.priority || 2) - 1);
      const newItem = { ...item, priority: newPriority, reprioritized_at: now };
      const newScore = newPriority * 1e13 + enqueued;

      if (!dryRun) {
        await redis('ZREM', K.pending, pendingRaw[i]);
        await redis('ZADD', K.pending, newScore, JSON.stringify(newItem));
      }
      stats.reprioritized++;
    } catch {}
  }
}

// ---- 2. Retry eligible failed items ----
const failedRaw = await redis('ZRANGE', K.failed, 0, -1, 'WITHSCORES');
if (Array.isArray(failedRaw)) {
  for (let i = 0; i < failedRaw.length; i += 2) {
    try {
      const rec = JSON.parse(failedRaw[i]);
      const item = rec.item || rec;
      if (!item.id) continue;
      const retryCount = rec.retry_count || item.retry_count || 0;
      if (retryCount >= 3) continue;
      if (rec.reason === 'protected_path_violation') continue;

      // Check if lease expired
      const leaseHolder = await redis('GET', K.lease(item.id));
      if (leaseHolder) continue; // still leased

      const newItem = { ...item, retry_count: retryCount, retry_by_janitor: true, ts_enqueued_ms: now };
      const score = (newItem.priority ?? 2) * 1e13 + now;

      if (!dryRun) {
        await redis('ZREM', K.failed, failedRaw[i]);
        await redis('ZADD', K.pending, score, JSON.stringify(newItem));
      }
      stats.retried++;
    } catch {}
  }
}

// ---- 3. Archive old completed items ----
const archiveBefore = now - ARCHIVE_THRESHOLD_MS;
const oldCompleted = await redis('ZRANGEBYSCORE', K.completed, 0, archiveBefore, 'WITHSCORES');
if (Array.isArray(oldCompleted)) {
  for (let i = 0; i < oldCompleted.length; i += 2) {
    const score = Number(oldCompleted[i + 1]);
    if (!dryRun) {
      await redis('ZADD', K.archive, score, oldCompleted[i]);
      await redis('ZREM', K.completed, oldCompleted[i]);
    }
    stats.archived++;
  }
}

// ---- 4. Post summary ----
const summary = `inbox-janitor: reprioritized=${stats.reprioritized} retried=${stats.retried} archived=${stats.archived} dry_run=${dryRun}`;
const ts = nowMs();
if (!dryRun) {
  await redis('ZADD', K.gene, ts, JSON.stringify({ ts, source: 'inbox-janitor', kind: 'daily-summary', summary }));
  await redis('ZADD', K.thread, ts, JSON.stringify({ ts, source: 'inbox-janitor', kind: 'daily-summary', summary }));
}

console.log(JSON.stringify({ ok: true, dry_run: dryRun, ...stats }));
