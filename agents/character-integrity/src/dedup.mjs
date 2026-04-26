/**
 * dedup.mjs — detect and merge duplicate character entries.
 * STUB: implement in next session.
 */
import { tickEvent } from './acmi.mjs';

export async function dedup(_opts = {}) {
  await tickEvent('tick-start', 'dedup started (stub)');
  // TODO: load all character records; group by normalized name + platform
  // TODO: for each group >1: merge fields (keep newest), delete extras, update list
  // TODO: report duplicates_found, merged, errors
  await tickEvent('tick-end', 'dedup stub — not yet implemented');
  console.log(JSON.stringify({ ok: true, status: 'stub' }));
}
