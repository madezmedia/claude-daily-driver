/**
 * Upstash REST client for character-integrity agent.
 * Writes to acmi:agent:character-integrity:timeline.
 */

export const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
export const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export const KEYS = {
  timeline: 'acmi:agent:character-integrity:timeline',
  bentleyPm: 'acmi:thread:bentley-pm:timeline',
  signals: 'acmi:agent:character-integrity:signals',
};

export async function redis(cmd, ...args) {
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

export function nowMs() { return Date.now(); }

export async function tickEvent(kind, summary, extra = {}) {
  const ts = nowMs();
  await redis('ZADD', KEYS.timeline, ts, JSON.stringify({
    ts, source: 'character-integrity', kind, summary: `[${kind}] ${summary}`, ...extra,
  }));
}

export async function alertBentley(severity, summary, data = {}) {
  const ts = nowMs();
  await redis('ZADD', KEYS.bentleyPm, ts, JSON.stringify({
    ts, source: 'character-integrity', kind: 'integrity-issue',
    severity, summary: `[integrity-${severity}] ${summary}`, data,
  }));
}
