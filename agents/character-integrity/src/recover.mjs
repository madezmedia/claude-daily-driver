/**
 * recover.mjs — recover missing/corrupted character records.
 * FULLY IMPLEMENTED. Ports logic from recover-characters.js.
 * Idempotent: skips records that already exist and are valid.
 */

import { redis, tickEvent, alertBentley, nowMs, KEYS } from './acmi.mjs';

const CHARACTER_LIST_KEY = process.env.CHARACTER_LIST_KEY || 'ezi:characters:list';
const CHARACTER_PREFIX = process.env.CHARACTER_PREFIX || 'ezi:character:';
const SNAPSHOT_PREFIX = process.env.SNAPSHOT_PREFIX || 'ezi:character:snapshot:';

function isValidCharacter(obj) {
  return obj &&
    typeof obj.id === 'string' && obj.id.length > 0 &&
    typeof obj.name === 'string' && obj.name.length > 0;
}

async function getAllCharacterIds() {
  const members = await redis('SMEMBERS', CHARACTER_LIST_KEY);
  return Array.isArray(members) ? members : [];
}

async function getCharacter(id) {
  try {
    const raw = await redis('GET', `${CHARACTER_PREFIX}${id}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null; // treat parse failure as corrupt
  }
}

async function getSnapshot(id) {
  try {
    // Try latest snapshot first, then fallback list
    const raw = await redis('GET', `${SNAPSHOT_PREFIX}${id}:latest`);
    if (raw) return JSON.parse(raw);
    // Try LRANGE of snapshots
    const list = await redis('LRANGE', `${SNAPSHOT_PREFIX}${id}`, 0, 0);
    if (Array.isArray(list) && list[0]) return JSON.parse(list[0]);
    return null;
  } catch {
    return null;
  }
}

async function restoreCharacter(id, snapshot, reason) {
  const restored = { ...snapshot, recovered_at: nowMs(), recovery_reason: reason };
  await redis('SET', `${CHARACTER_PREFIX}${id}`, JSON.stringify(restored));
  // Ensure in list
  await redis('SADD', CHARACTER_LIST_KEY, id);
  await tickEvent('character-recovered', `id=${id} reason=${reason}`);
  return restored;
}

export async function recover({ dryRun = false } = {}) {
  await tickEvent('tick-start', `recover started dry_run=${dryRun}`);

  const ids = await getAllCharacterIds();
  const stats = { checked: 0, missing: 0, corrupt: 0, recovered: 0, no_snapshot: 0, skipped: 0 };
  const issues = [];

  for (const id of ids) {
    stats.checked++;
    const char = await getCharacter(id);
    let needsRecovery = false;
    let reason = null;

    if (char === null) {
      stats.missing++;
      needsRecovery = true;
      reason = 'missing';
    } else if (!isValidCharacter(char)) {
      stats.corrupt++;
      needsRecovery = true;
      reason = 'corrupt';
    }

    if (!needsRecovery) { stats.skipped++; continue; }

    const snapshot = await getSnapshot(id);
    if (!snapshot || !isValidCharacter(snapshot)) {
      stats.no_snapshot++;
      issues.push({ id, reason, severity: 'high', msg: 'no valid snapshot available' });
      await alertBentley('high', `character ${id} is ${reason} and has no snapshot`, { id, reason });
      continue;
    }

    if (!dryRun) {
      await restoreCharacter(id, snapshot, reason);
      stats.recovered++;
    } else {
      console.log(`[dry-run] would recover ${id} (${reason}) from snapshot`);
    }
  }

  // Alert if issues found
  if (issues.length > 0) {
    const severity = issues.some(i => i.severity === 'critical') ? 'critical' : 'high';
    await alertBentley(severity, `${issues.length} characters irrecoverable`, { issues });
  }

  const summary = `recover: ${stats.recovered} recovered, ${stats.no_snapshot} irrecoverable, ${stats.skipped} healthy (of ${stats.checked})`;
  await tickEvent('tick-end', summary, { stats });
  console.log(JSON.stringify({ ok: true, ...stats, summary }));
  return stats;
}
