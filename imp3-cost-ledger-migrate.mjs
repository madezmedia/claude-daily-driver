#!/usr/bin/env node
/**
 * imp3-cost-ledger-migrate.mjs — migrate cost_ledger from inline Signals JSON
 * to dedicated Redis LIST keys per agent.
 * Idempotent: agents with no cost_ledger in signals are skipped.
 * DO NOT RUN FROM CLOUD — run locally after pickup.
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

const dryRun = process.argv.includes('--dry-run');

// Scan all acmi:agent:*:signals keys
let cursor = '0';
const agentSignalKeys = [];
do {
  const [nextCursor, keys] = await redis('SCAN', cursor, 'MATCH', 'acmi:agent:*:signals', 'COUNT', '100');
  cursor = nextCursor;
  agentSignalKeys.push(...(Array.isArray(keys) ? keys : []));
} while (cursor !== '0');

const stats = { agents_scanned: agentSignalKeys.length, agents_migrated: 0, agents_skipped: 0, entries_moved: 0, errors: 0 };

for (const signalsKey of agentSignalKeys) {
  const agentId = signalsKey.replace('acmi:agent:', '').replace(':signals', '');
  const costLedgerKey = `acmi:agent:${agentId}:cost_ledger`;

  try {
    const raw = await redis('GET', signalsKey);
    if (!raw) { stats.agents_skipped++; continue; }

    const signals = JSON.parse(raw);
    if (!Array.isArray(signals.cost_ledger) || signals.cost_ledger.length === 0) {
      stats.agents_skipped++;
      continue;
    }

    const entries = signals.cost_ledger;
    console.log(`[migrate] ${agentId}: ${entries.length} entries → ${costLedgerKey}`);

    if (!dryRun) {
      for (const entry of entries) {
        await redis('LPUSH', costLedgerKey, typeof entry === 'string' ? entry : JSON.stringify(entry));
        stats.entries_moved++;
      }
      const { cost_ledger: _, ...trimmedSignals } = signals;
      await redis('SET', signalsKey, JSON.stringify(trimmedSignals));
    } else {
      console.log(`  [dry-run] would move ${entries.length} entries`);
      stats.entries_moved += entries.length;
    }

    stats.agents_migrated++;
  } catch (e) {
    console.error(`[error] ${agentId}: ${e.message}`);
    stats.errors++;
  }
}

console.log(JSON.stringify({ ok: true, dry_run: dryRun, ...stats }));
