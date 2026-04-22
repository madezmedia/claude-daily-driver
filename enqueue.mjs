#!/usr/bin/env node

/**
 * Inbox enqueue helper for acmi:inbox:claude-engineer.
 * Schema-validated producer-side ZADD. Invoked by other agents (Bentley, Gemini CLI, etc.)
 * to drop async work for Claude.
 *
 * Usage:
 *   node enqueue.mjs '<json-item>'
 *   echo '<json-item>' | node enqueue.mjs -
 *
 * Auto-fills: id, ts_enqueued_ms, retry_count. Validates required fields, rejects on
 * schema violation, computes score, ZADDs to :pending.
 */

import { randomBytes } from 'node:crypto';

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  console.error("ERROR: Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN.");
  process.exit(1);
}

async function redis(command, ...args) {
  const endpoint = `${url.replace(/\/$/, '')}/`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([command, ...args])
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

const K_PENDING = 'acmi:inbox:claude-engineer:pending';

const REQUIRED_FIELDS = [
  'priority',
  'from',
  'execution_target',
  'kind',
  'title',
  'brief',
  'deliverable',
  'budget',
  'protected_paths_ack',
];

const VALID_TARGETS = new Set(['cloud', 'local', 'any']);
const VALID_KINDS = new Set(['code-task', 'research', 'review', 'mcp-op', 'custom']);
const VALID_DELIVERABLE_TYPES = new Set(['acmi-event', 'file', 'pr', 'notion-page']);

function mkId() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hex = randomBytes(4).toString('hex');
  return `ibx_${y}-${m}-${day}_${hex}`;
}

function validate(item) {
  const errs = [];
  for (const f of REQUIRED_FIELDS) {
    if (item[f] === undefined || item[f] === null) errs.push(`missing required field: ${f}`);
  }
  if (errs.length) return errs;

  if (!Number.isInteger(item.priority) || item.priority < 0 || item.priority > 3) {
    errs.push('priority must be integer 0..3');
  }
  if (typeof item.from !== 'string' || !item.from.trim()) errs.push('from must be non-empty string');
  if (!VALID_TARGETS.has(item.execution_target)) {
    errs.push(`execution_target must be one of: ${[...VALID_TARGETS].join(', ')}`);
  }
  if (!VALID_KINDS.has(item.kind)) {
    errs.push(`kind must be one of: ${[...VALID_KINDS].join(', ')}`);
  }
  if (typeof item.title !== 'string' || !item.title.trim()) errs.push('title must be non-empty string');
  if (typeof item.brief !== 'string' || !item.brief.trim()) errs.push('brief must be non-empty string');

  if (typeof item.deliverable !== 'object' || item.deliverable === null) {
    errs.push('deliverable must be object');
  } else {
    if (!VALID_DELIVERABLE_TYPES.has(item.deliverable.type)) {
      errs.push(`deliverable.type must be one of: ${[...VALID_DELIVERABLE_TYPES].join(', ')}`);
    }
    if (typeof item.deliverable.target !== 'string' || !item.deliverable.target.trim()) {
      errs.push('deliverable.target must be non-empty string');
    }
  }

  if (typeof item.budget !== 'object' || item.budget === null) {
    errs.push('budget must be object');
  } else {
    if (!Number.isFinite(item.budget.max_minutes) || item.budget.max_minutes <= 0) {
      errs.push('budget.max_minutes must be positive number');
    }
    if (!Number.isInteger(item.budget.max_tool_calls) || item.budget.max_tool_calls <= 0) {
      errs.push('budget.max_tool_calls must be positive integer');
    }
  }

  if (item.protected_paths_ack !== true) {
    errs.push('protected_paths_ack must be literal true (producer must acknowledge protected-path policy)');
  }

  if (item.context_refs !== undefined) {
    if (!Array.isArray(item.context_refs)) {
      errs.push('context_refs must be array when present');
    } else {
      item.context_refs.forEach((ref, i) => {
        if (typeof ref !== 'object' || ref === null) {
          errs.push(`context_refs[${i}] must be object`);
          return;
        }
        if (ref.type === 'file') {
          if (typeof ref.path !== 'string' || !ref.path) errs.push(`context_refs[${i}].path required for type=file`);
        } else if (ref.type === 'acmi') {
          if (typeof ref.key !== 'string' || !ref.key) errs.push(`context_refs[${i}].key required for type=acmi`);
        } else if (ref.type === 'url') {
          if (typeof ref.url !== 'string' || !ref.url) errs.push(`context_refs[${i}].url required for type=url`);
        } else {
          errs.push(`context_refs[${i}].type must be file|acmi|url`);
        }
      });
    }
  }

  return errs;
}

async function readStdin() {
  return await new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node enqueue.mjs '<json>' | echo '<json>' | node enqueue.mjs -");
    process.exit(2);
  }

  const raw = arg === '-' ? (await readStdin()).trim() : arg;
  let item;
  try {
    item = JSON.parse(raw);
  } catch (e) {
    console.error(`ERROR: invalid JSON: ${e.message}`);
    process.exit(2);
  }

  const errs = validate(item);
  if (errs.length) {
    console.error('ERROR: schema validation failed:');
    for (const e of errs) console.error(`  - ${e}`);
    process.exit(2);
  }

  item.id = item.id || mkId();
  item.ts_enqueued_ms = Date.now();
  item.retry_count = 0;

  const score = item.priority * 1e13 + item.ts_enqueued_ms;
  const payload = JSON.stringify(item);

  await redis('ZADD', K_PENDING, score, payload);

  console.log(JSON.stringify({
    ok: true,
    id: item.id,
    priority: item.priority,
    execution_target: item.execution_target,
    score,
    queued_at: new Date(item.ts_enqueued_ms).toISOString(),
  }));
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
