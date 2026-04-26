/**
 * cost-ledger.mjs — helper module for per-entity cost ledgers.
 * Stores cost entries in Redis LIST keys: <entityKey>:cost_ledger
 * Importable as a Node module.
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

function ledgerKey(entityKey) {
  return `${entityKey}:cost_ledger`;
}

/**
 * Add a cost entry to the entity's ledger.
 * @param {string} entityKey — e.g. "acmi:agent:claude-engineer"
 * @param {object} costEntry — e.g. { ts, model, input_tokens, output_tokens, cost_usd }
 * @returns {number} new list length
 */
export async function addCost(entityKey, costEntry) {
  const entry = typeof costEntry === 'string' ? costEntry : JSON.stringify({
    ...costEntry,
    ts: costEntry.ts || Date.now(),
  });
  return redis('LPUSH', ledgerKey(entityKey), entry);
}

/**
 * Read the most recent cost entries.
 * @param {string} entityKey
 * @param {number} limit — default 50
 * @returns {object[]} parsed cost entries, newest first
 */
export async function readCosts(entityKey, limit = 50) {
  const raw = await redis('LRANGE', ledgerKey(entityKey), 0, limit - 1);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(r => { try { return [JSON.parse(r)]; } catch { return []; } });
}

/**
 * Trim the ledger to the most recent entries.
 * @param {string} entityKey
 * @param {number} keep — default 1000
 */
export async function trimCosts(entityKey, keep = 1000) {
  return redis('LTRIM', ledgerKey(entityKey), 0, keep - 1);
}

/**
 * Summarize costs for an entity over a time window.
 * @param {string} entityKey
 * @param {number} sinceMs — default last 24h
 */
export async function summarizeCosts(entityKey, sinceMs = Date.now() - 86400000) {
  const entries = await readCosts(entityKey, 10000);
  const inWindow = entries.filter(e => (e.ts || 0) >= sinceMs);
  const total_cost_usd = inWindow.reduce((s, e) => s + (e.cost_usd || 0), 0);
  const total_input_tokens = inWindow.reduce((s, e) => s + (e.input_tokens || 0), 0);
  const total_output_tokens = inWindow.reduce((s, e) => s + (e.output_tokens || 0), 0);
  return { entity: entityKey, entries_in_window: inWindow.length, total_cost_usd, total_input_tokens, total_output_tokens };
}
