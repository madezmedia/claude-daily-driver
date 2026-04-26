#!/usr/bin/env node
/**
 * rollup-cron.mjs — synthesizes a daily/weekly rollup from agent timelines + signals.
 * Reads last N days of acmi:agent:*:timeline + signals + active_context.
 * Writes rollup to acmi:rollup:claude-engineer:summary (LPUSH, capped at 90).
 * Empty-window safe, missing-key tolerant.
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

function nowMs() { return Date.now(); }

function argOf(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx < process.argv.length - 1 ? process.argv[idx + 1] : null;
}

const AGENTS = (argOf('--agents') || 'claude-engineer,bentley,gene,gemini-cli').split(',');
const DAYS = parseInt(argOf('--days') || '7', 10);
const ROLLUP_KEY = argOf('--out') || 'acmi:rollup:claude-engineer:summary';
const ROLLUP_CAP = 90;

async function fetchTimelineWindow(agentId, sinceMs) {
  try {
    const members = await redis('ZRANGEBYSCORE', `acmi:agent:${agentId}:timeline`, sinceMs, '+inf');
    if (!Array.isArray(members)) return [];
    return members.flatMap(m => { try { return [JSON.parse(m)]; } catch { return []; } });
  } catch {
    return [];
  }
}

async function fetchSignals(agentId) {
  try {
    const raw = await redis('GET', `acmi:agent:${agentId}:signals`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchActiveContext(agentId) {
  try {
    const raw = await redis('GET', `acmi:agent:${agentId}:active_context`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function summarizeEvents(events) {
  const byKind = {};
  for (const e of events) {
    const k = e.kind || 'unknown';
    byKind[k] = (byKind[k] || 0) + 1;
  }
  const completed = events.filter(e => e.kind === 'inbox_item_completed' || e.kind === 'item-completed').length;
  const failed = events.filter(e => e.kind === 'item-failed').length;
  const redFlags = events.filter(e => e.kind === 'red-flag').length;
  return { total: events.length, completed, failed, red_flags: redFlags, by_kind: byKind };
}

// ---- main ----
const sinceMs = nowMs() - DAYS * 24 * 3600 * 1000;
const rollupData = { ts: nowMs(), window_days: DAYS, agents: {} };

for (const agentId of AGENTS) {
  const [events, signals, context] = await Promise.all([
    fetchTimelineWindow(agentId, sinceMs),
    fetchSignals(agentId),
    fetchActiveContext(agentId),
  ]);

  rollupData.agents[agentId] = {
    event_summary: summarizeEvents(events),
    has_signals: signals !== null,
    has_context: context !== null,
    recent_summaries: events
      .filter(e => e.summary)
      .slice(-5)
      .map(e => ({ ts: e.ts, summary: e.summary })),
    signals_snapshot: signals ? {
      budget: signals.budget,
      mode: signals.mode,
      last_active: signals.last_active,
    } : null,
  };
}

// Synthesize top-level narrative
const allCompleted = Object.values(rollupData.agents).reduce((s, a) => s + (a.event_summary?.completed || 0), 0);
const allFailed = Object.values(rollupData.agents).reduce((s, a) => s + (a.event_summary?.failed || 0), 0);
const allRedFlags = Object.values(rollupData.agents).reduce((s, a) => s + (a.event_summary?.red_flags || 0), 0);

rollupData.summary = {
  total_completed: allCompleted,
  total_failed: allFailed,
  total_red_flags: allRedFlags,
  narrative: `Last ${DAYS}d: ${allCompleted} tasks completed, ${allFailed} failed, ${allRedFlags} red-flags across ${AGENTS.length} agents.`,
};

// Write rollup
await redis('LPUSH', ROLLUP_KEY, JSON.stringify(rollupData));
await redis('LTRIM', ROLLUP_KEY, 0, ROLLUP_CAP - 1);

// Timeline event
const ts = nowMs();
await redis('ZADD', 'acmi:thread:claude-daily-driver:timeline', ts, JSON.stringify({
  ts, source: 'rollup-cron', kind: 'rollup-complete',
  summary: rollupData.summary.narrative,
}));

console.log(JSON.stringify({ ok: true, rollup_key: ROLLUP_KEY, ...rollupData.summary }));
