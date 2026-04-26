/**
 * sync.mjs — sync character data across storage systems (DB ↔ cache ↔ ACMI).
 * STUB: implement in next session.
 */
import { tickEvent } from './acmi.mjs';

export async function sync(_opts = {}) {
  await tickEvent('tick-start', 'sync started (stub)');
  // TODO: iterate ezi:characters:list; for each id, compare DB record vs cache vs ACMI
  // TODO: apply writes in the direction DB → cache → ACMI (DB is source of truth)
  // TODO: track sync_count, conflict_count, error_count
  await tickEvent('tick-end', 'sync stub — not yet implemented');
  console.log(JSON.stringify({ ok: true, status: 'stub' }));
}
