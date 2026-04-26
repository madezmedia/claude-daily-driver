/**
 * normalize.mjs — normalize inconsistent field values (casing, arrays, nulls).
 * STUB: implement in next session.
 */
import { tickEvent } from './acmi.mjs';

export async function normalize(_opts = {}) {
  await tickEvent('tick-start', 'normalize started (stub)');
  // TODO: for each character record, apply field normalization rules:
  //   - name: trim + title-case
  //   - tags: ensure array, lowercase, dedup
  //   - null fields: replace with canonical defaults
  //   - date strings: normalize to ISO8601
  await tickEvent('tick-end', 'normalize stub — not yet implemented');
  console.log(JSON.stringify({ ok: true, status: 'stub' }));
}
