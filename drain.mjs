#!/usr/bin/env node
/**
 * Inbox drainer for acmi:inbox:claude-engineer.
 * Subcommands: check-budget, claim, complete, fail, verify-lease, record-empty-tick
 *
 * Reuses the redis() helper pattern from ~/.openclaw/skills/acmi/acmi.mjs:16-30.
 */

import { randomBytes, createHash } from 'node:crypto';
import os from 'node:os';

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  console.error('ERROR: Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN.');
  process.exit(1);
}

async function redis(command, ...args) {
  const endpoint = `${url.replace(/\/$/, '')}/`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// ---- Keys ----
const K = {
  pending: 'acmi:inbox:claude-engineer:pending',
  processing: 'acmi:inbox:claude-engineer:processing',
  completed: 'acmi:inbox:claude-engineer:completed',
  failed: 'acmi:inbox:claude-engineer:failed',
  lease: (id) => `acmi:inbox:claude-engineer:lease:${id}`,
  runs: 'acmi:daily-driver:runs',
  cost: 'acmi:daily-driver:cost',
  claudeTimeline: 'acmi:agent:claude-engineer:timeline',
  claudeSignals: 'acmi:agent:claude-engineer:signals',
  thread: 'acmi:thread:claude-daily-driver:timeline',
  bentleyTimeline: 'acmi:agent:bentley:timeline',
  agentTimeline: (id) => `acmi:agent:${id}:timeline`,
};

// ---- Protected paths (static pre-flight) ----
const HOME = os.homedir();
const PROTECTED_PREFIXES = [
  `${HOME}/clawd/tools/notion-sync/`,
  // core file itself — subcommand handlers in child scripts are allowed
  `${HOME}/.openclaw/skills/acmi/acmi.mjs`,
];

function violatesProtectedPath(item) {
  const targets = [item.brief || ''];
  if (Array.isArray(item.context_refs)) {
    for (const ref of item.context_refs) {
      if (ref?.type === 'file' && typeof ref.path === 'string') targets.push(ref.path);
    }
  }
  if (item.deliverable?.type === 'file' && typeof item.deliverable.target === 'string') {
    targets.push(item.deliverable.target);
  }
  const expand = (s) => (typeof s === 'string' ? s.replace(/^~/, HOME) : '');
  for (const t of targets) {
    const expanded = expand(t);
    for (const prefix of PROTECTED_PREFIXES) {
      if (expanded.includes(prefix)) return true;
    }
  }
  return false;
}

// ---- Args ----
function argOf(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx === process.argv.length - 1) return null;
  return process.argv[idx + 1];
}

function drainerId(runtime) {
  return `${runtime}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

function nowMs() {
  return Date.now();
}

function todayStartMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function todayEndMs() {
  return todayStartMs() + 24 * 3600 * 1000 - 1;
}

async function getSignals() {
  const raw = await redis('GET', K.claudeSignals);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function getBudgetCap(runtime) {
  const signals = await getSignals();
  const budget = signals.budget || {};
  if (runtime === 'cloud') return budget.cloud_runs_cap ?? 150;
  return budget.local_runs_cap ?? 80;
}

async function countRunsToday(runtime) {
  // runs are ZADD'd with score = ts_ms and JSON body containing runtime.
  // We ZRANGEBYSCORE today's range then JSON-parse-filter.
  const members = await redis('ZRANGEBYSCORE', K.runs, todayStartMs(), todayEndMs());
  if (!Array.isArray(members)) return 0;
  let n = 0;
  for (const m of members) {
    try {
      const r = JSON.parse(m);
      if (r.runtime === runtime) n++;
    } catch {}
  }
  return n;
}

async function writeEvent(key, payload) {
  const ts = payload.ts ?? nowMs();
  await redis('ZADD', key, ts, JSON.stringify({ ts, ...payload }));
}

async function redFlagToBentley(summary) {
  await writeEvent(K.bentleyTimeline, {
    source: 'claude-engineer',
    kind: 'red-flag',
    summary,
  });
}

// ---- Subcommand: check-budget ----
async function cmdCheckBudget() {
  const runtime = argOf('--runtime') || 'cloud';
  const cap = await getBudgetCap(runtime);
  const used = await countRunsToday(runtime);
  const result = { runtime, used, cap, over: used >= cap };
  if (result.over) {
    await redFlagToBentley(
      `[red-flag] Claude daily-driver ${runtime} drain hit daily cap (${used}/${cap}). Drainer exiting without LLM work until tomorrow.`
    );
  }
  console.log(JSON.stringify(result));
  if (result.over) process.exit(2);
}

// ---- Subcommand: claim ----
async function cmdClaim() {
  const runtime = argOf('--runtime') || 'cloud';
  const max = parseInt(argOf('--max') || '5', 10);
  const myId = drainerId(runtime);

  // Fetch pending (bounded). We over-fetch to allow filtering.
  const members = await redis('ZRANGE', K.pending, 0, 99, 'WITHSCORES');
  const items = [];
  if (Array.isArray(members)) {
    for (let i = 0; i < members.length; i += 2) {
      try {
        items.push({ payload: JSON.parse(members[i]), score: Number(members[i + 1]), raw: members[i] });
      } catch {
        // orphan non-JSON member — move to failed for later triage
        await redis('ZREM', K.pending, members[i]);
        await redis('ZADD', K.failed, nowMs(), JSON.stringify({ ts: nowMs(), reason: 'unparseable_member', raw: members[i] }));
      }
    }
  }

  const targetMatches = (item) => {
    const t = item.execution_target;
    if (runtime === 'cloud') return t === 'cloud' || t === 'any';
    return t === 'local' || t === 'any';
  };

  const claimed = [];
  for (const rec of items) {
    if (claimed.length >= max) break;
    const item = rec.payload;
    if (!targetMatches(item)) continue;

    // Protected-path static pre-flight
    if (violatesProtectedPath(item)) {
      await redis('ZREM', K.pending, rec.raw);
      await redis('ZADD', K.failed, nowMs(), JSON.stringify({ ts: nowMs(), item, reason: 'protected_path_violation' }));
      await writeEvent(K.thread, {
        source: 'claude-engineer',
        kind: 'item-failed',
        item_id: item.id,
        summary: `[protected-path] rejected ${item.id}: ${item.title}`,
      });
      continue;
    }

    // Acquire lease
    const lease = await redis('SET', K.lease(item.id), myId, 'NX', 'EX', 600);
    if (lease !== 'OK') continue; // someone else has it

    // Move to processing + remove from pending (within same tick — ZREM then HSET)
    const leaseExpires = nowMs() + 600 * 1000;
    await redis('HSET', K.processing, item.id, JSON.stringify({ leased_by: myId, lease_expires_ms: leaseExpires, started_at_ms: nowMs(), raw: rec.raw }));
    await redis('ZREM', K.pending, rec.raw);

    claimed.push({ ...item, _lease: { drainer_id: myId, expires_ms: leaseExpires } });
  }

  console.log(JSON.stringify({ runtime, drainer_id: myId, claimed_count: claimed.length, items: claimed }));
}

// ---- Subcommand: complete ----
async function cmdComplete() {
  const itemId = argOf('--item-id');
  const result = argOf('--result') || '(no result summary)';
  if (!itemId) { console.error('--item-id required'); process.exit(1); }

  const procRaw = await redis('HGET', K.processing, itemId);
  if (!procRaw) { console.error(`item ${itemId} not in processing`); process.exit(1); }
  const proc = JSON.parse(procRaw);
  const item = JSON.parse(proc.raw);

  const ts = nowMs();

  // Triple-write
  await writeEvent(K.claudeTimeline, {
    source: 'scheduled_run',
    kind: 'inbox_item_completed',
    item_id: item.id,
    from_agent: item.from,
    summary: `[done] ${item.title} — ${result}`,
  });
  await writeEvent(K.thread, {
    source: 'claude-engineer',
    kind: 'item-completed',
    item_id: item.id,
    from_agent: item.from,
    summary: `[done] ${item.title} — ${result}`,
  });
  if (item.from && item.from !== 'claude-engineer') {
    await writeEvent(K.agentTimeline(item.from), {
      source: 'claude-engineer',
      kind: 'inbox_task_done',
      item_id: item.id,
      correlation_id: item.correlation_id || null,
      summary: `[done] ${item.title} — ${result}`,
    });
  }

  // Move to completed, clear processing + lease
  await redis('ZADD', K.completed, ts, JSON.stringify({ ts, item, result }));
  await redis('HDEL', K.processing, item.id);
  await redis('DEL', K.lease(item.id));

  console.log(JSON.stringify({ ok: true, item_id: item.id }));
}

// ---- Subcommand: fail ----
async function cmdFail() {
  const itemId = argOf('--item-id');
  const reason = argOf('--reason') || 'unspecified';
  if (!itemId) { console.error('--item-id required'); process.exit(1); }

  const procRaw = await redis('HGET', K.processing, itemId);
  if (!procRaw) { console.error(`item ${itemId} not in processing`); process.exit(1); }
  const proc = JSON.parse(procRaw);
  const item = JSON.parse(proc.raw);
  const ts = nowMs();

  const retryCount = (item.retry_count || 0) + 1;
  const maxRetries = 3;

  if (retryCount < maxRetries && reason !== 'protected_path_violation') {
    // Re-enqueue with bumped retry
    const newItem = { ...item, retry_count: retryCount };
    const score = (newItem.priority ?? 2) * 1e13 + (newItem.ts_enqueued_ms || ts) + retryCount * 1e9;
    await redis('ZADD', K.pending, score, JSON.stringify(newItem));
    await writeEvent(K.thread, {
      source: 'claude-engineer',
      kind: 'item-retry',
      item_id: item.id,
      retry_count: retryCount,
      summary: `[retry ${retryCount}/${maxRetries}] ${item.title} — ${reason}`,
    });
  } else {
    // DLQ
    await redis('ZADD', K.failed, ts, JSON.stringify({ ts, item, reason, retry_count: retryCount }));
    await writeEvent(K.thread, {
      source: 'claude-engineer',
      kind: 'item-failed',
      item_id: item.id,
      summary: `[failed] ${item.title} — ${reason}`,
    });
    if (item.from && item.from !== 'claude-engineer') {
      await writeEvent(K.agentTimeline(item.from), {
        source: 'claude-engineer',
        kind: 'inbox_task_failed',
        item_id: item.id,
        correlation_id: item.correlation_id || null,
        summary: `[failed] ${item.title} — ${reason}`,
      });
    }
  }

  await redis('HDEL', K.processing, item.id);
  await redis('DEL', K.lease(item.id));

  console.log(JSON.stringify({ ok: true, item_id: item.id, outcome: retryCount < maxRetries && reason !== 'protected_path_violation' ? 'retry' : 'dlq' }));
}

// ---- Subcommand: verify-lease ----
async function cmdVerifyLease() {
  const itemId = argOf('--item-id');
  if (!itemId) { console.error('--item-id required'); process.exit(1); }
  const v = await redis('GET', K.lease(itemId));
  console.log(JSON.stringify({ item_id: itemId, lease_holder: v, held: v !== null }));
  if (v === null) process.exit(3);
}

// ---- Subcommand: record-empty-tick ----
async function cmdRecordEmptyTick() {
  const runtime = argOf('--runtime') || 'cloud';
  await recordRun({ runtime, items_processed: 0, items_failed: 0, status: 'empty' });
  console.log(JSON.stringify({ runtime, status: 'empty', recorded: true }));
}

async function recordRun({ runtime, items_processed, items_failed, status }) {
  const ts = nowMs();
  const runId = `run_${ts}_${randomBytes(3).toString('hex')}`;
  await redis('ZADD', K.runs, ts, JSON.stringify({
    ts, run_id: runId, runtime, items_processed, items_failed, status,
  }));
  // Also bump cost hash for current month
  const ym = new Date().toISOString().slice(0, 7);
  const field = runtime === 'cloud' ? 'cloud_runs' : 'local_runs';
  await redis('HINCRBY', K.cost, `${ym}:${field}`, 1);
}

// ---- Subcommand: record-tick ----
async function cmdRecordTick() {
  const runtime = argOf('--runtime') || 'cloud';
  const processed = parseInt(argOf('--processed') || '0', 10);
  const failed = parseInt(argOf('--failed') || '0', 10);
  const status = argOf('--status') || 'ok';
  await recordRun({ runtime, items_processed: processed, items_failed: failed, status });
  console.log(JSON.stringify({ runtime, processed, failed, status, recorded: true }));
}

// ---- Subcommand: stats ----
async function cmdStats() {
  const pending = await redis('ZCARD', K.pending);
  const processing = await redis('HLEN', K.processing);
  const completed = await redis('ZCARD', K.completed);
  const failed = await redis('ZCARD', K.failed);
  const cloudToday = await countRunsToday('cloud');
  const localToday = await countRunsToday('local');
  console.log(JSON.stringify({ pending, processing, completed, failed, runs_today: { cloud: cloudToday, local: localToday } }, null, 2));
}

// ---- Main ----
const cmd = process.argv[2];
const commands = {
  'check-budget': cmdCheckBudget,
  'claim': cmdClaim,
  'complete': cmdComplete,
  'fail': cmdFail,
  'verify-lease': cmdVerifyLease,
  'record-empty-tick': cmdRecordEmptyTick,
  'record-tick': cmdRecordTick,
  'stats': cmdStats,
};

if (!cmd || !commands[cmd]) {
  console.error(`Usage: drain.mjs <subcommand> [flags]
Subcommands:
  check-budget --runtime <cloud|local>
  claim --runtime <cloud|local> [--max 5]
  complete --item-id <id> --result "<summary>"
  fail --item-id <id> --reason "<short reason>"
  verify-lease --item-id <id>
  record-empty-tick --runtime <cloud|local>
  record-tick --runtime <cloud|local> --processed <N> --failed <M> [--status ok|partial]
  stats`);
  process.exit(1);
}

commands[cmd]().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
