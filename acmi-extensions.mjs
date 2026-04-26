#!/usr/bin/env node
/**
 * acmi-extensions.mjs — long-context + identity helpers for the ACMI system.
 * Importable as a Node module OR runnable as CLI.
 * Commands: bootstrap, spawn, active, rollup-set, cat, work
 * Backward compatible with acmi.mjs patterns.
 */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd, ...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('Missing Upstash creds');
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

// ---- bootstrap: seed an agent's identity profile ----
export async function bootstrap({ agentId, persona, capabilities = [], schedule = null }) {
  if (!agentId) throw new Error('agentId required');
  const profile = {
    id: agentId,
    persona: persona || `${agentId} agent`,
    capabilities,
    schedule,
    bootstrapped_at: nowMs(),
  };
  await redis('SET', `acmi:agent:${agentId}:identity`, JSON.stringify(profile));
  const ts = nowMs();
  await redis('ZADD', `acmi:agent:${agentId}:timeline`, ts, JSON.stringify({
    ts, source: agentId, kind: 'bootstrap', summary: `[bootstrap] ${agentId} identity profile seeded`,
  }));
  return profile;
}

// ---- spawn: enqueue a sub-task for another agent ----
export async function spawn({ fromAgent, toAgent, brief, priority = 2, correlationId = null }) {
  if (!fromAgent || !toAgent || !brief) throw new Error('fromAgent, toAgent, brief required');
  const id = `ibx_spawn_${nowMs()}_${Math.random().toString(36).slice(2, 8)}`;
  const item = {
    id, ts_enqueued_ms: nowMs(), priority,
    from: fromAgent, execution_target: 'any', kind: 'code-task',
    title: `Delegated task from ${fromAgent} to ${toAgent}`,
    brief, context_refs: [],
    deliverable: { type: 'acmi-event', target: `acmi:agent:${toAgent}:timeline` },
    budget: { max_minutes: 20, max_tool_calls: 50 },
    correlation_id: correlationId,
  };
  const score = priority * 1e13 + nowMs();
  await redis('ZADD', 'acmi:inbox:claude-engineer:pending', score, JSON.stringify(item));
  const ts = nowMs();
  await redis('ZADD', `acmi:agent:${toAgent}:timeline`, ts, JSON.stringify({
    ts, source: fromAgent, kind: 'handoff-request', item_id: id,
    summary: `[handoff-request] ${fromAgent} → ${toAgent}: ${brief.slice(0, 80)}`,
  }));
  return { id, enqueued: true };
}

// ---- active: get/set the active context for an agent ----
export async function getActive(agentId) {
  if (!agentId) throw new Error('agentId required');
  const raw = await redis('GET', `acmi:agent:${agentId}:active_context`);
  return raw ? JSON.parse(raw) : null;
}

export async function setActive(agentId, context) {
  if (!agentId) throw new Error('agentId required');
  await redis('SET', `acmi:agent:${agentId}:active_context`, JSON.stringify({ ...context, updated_at: nowMs() }));
  return true;
}

// ---- rollup-set: write a rollup entry for an agent ----
export async function rollupSet(agentId, { summary, data = {} }) {
  if (!agentId) throw new Error('agentId required');
  const entry = { ts: nowMs(), summary, data };
  await redis('LPUSH', `acmi:agent:${agentId}:rollups`, JSON.stringify(entry));
  await redis('LTRIM', `acmi:agent:${agentId}:rollups`, 0, 29); // keep last 30
  return entry;
}

// ---- cat: retrieve full content of an ACMI key ----
export async function cat(key) {
  if (!key) throw new Error('key required');
  const type = await redis('TYPE', key);
  switch (type) {
    case 'string': return redis('GET', key);
    case 'list':   return redis('LRANGE', key, 0, -1);
    case 'hash':   return redis('HGETALL', key);
    case 'zset':   return redis('ZRANGE', key, 0, -1, 'WITHSCORES');
    case 'set':    return redis('SMEMBERS', key);
    default:       return null;
  }
}

// ---- work: record a work-in-progress event ----
export async function work(agentId, { taskId, status, summary }) {
  if (!agentId) throw new Error('agentId required');
  const ts = nowMs();
  await redis('ZADD', `acmi:agent:${agentId}:timeline`, ts, JSON.stringify({
    ts, source: agentId, kind: `work-${status}`, task_id: taskId,
    summary: `[work-${status}] ${summary}`,
  }));
  return { ts, status };
}

// ---- CLI entry ----
if (process.argv[1] && process.argv[1].endsWith('acmi-extensions.mjs')) {
  const cmd = process.argv[2];
  const agentId = argOf('--agent') || argOf('--agent-id');

  try {
    let result;
    switch (cmd) {
      case 'bootstrap':
        result = await bootstrap({
          agentId,
          persona: argOf('--persona'),
          capabilities: (argOf('--capabilities') || '').split(',').filter(Boolean),
          schedule: argOf('--schedule'),
        });
        break;
      case 'spawn':
        result = await spawn({
          fromAgent: argOf('--from') || agentId,
          toAgent: argOf('--to'),
          brief: argOf('--brief'),
          priority: parseInt(argOf('--priority') || '2', 10),
          correlationId: argOf('--correlation-id'),
        });
        break;
      case 'active':
        result = await getActive(agentId);
        break;
      case 'rollup-set':
        result = await rollupSet(agentId, { summary: argOf('--summary'), data: {} });
        break;
      case 'cat':
        result = await cat(process.argv[3] || argOf('--key'));
        break;
      case 'work':
        result = await work(agentId, {
          taskId: argOf('--task-id'),
          status: argOf('--status') || 'update',
          summary: argOf('--summary') || '',
        });
        break;
      default:
        console.error('Usage: acmi-extensions.mjs <bootstrap|spawn|active|rollup-set|cat|work> [flags]');
        process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  }
}
