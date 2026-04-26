#!/usr/bin/env node
/**
 * skill-extractor.mjs — weekly skill extraction from completed work items.
 * Schedule: Sun 04:00 UTC (cron: "0 4 * * 0")
 * - Scans completed items across trackers (last 7d)
 * - Extracts reusable PATTERN from each substantive item
 * - SET acmi:skill:<slug>:profile
 * - SADD acmi:skill:list <slug>
 * Idempotent via content-hash check before write.
 */

import { createHash } from 'node:crypto';

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

const DAYS = parseInt(argOf('--days') || '7', 10);
const DRY_RUN = process.argv.includes('--dry-run');
const sinceMs = nowMs() - DAYS * 24 * 3600 * 1000;

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function contentHash(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

function isSubstantive(item) {
  return item.brief && item.brief.length > 100 && item.result && item.result.length > 20;
}

function extractPattern(item) {
  return {
    slug: slugify(item.title || item.id),
    title: item.title || item.id,
    ask: (item.brief || '').slice(0, 200),
    approach: item.kind || 'code-task',
    deliverable_shape: item.deliverable?.type || 'unknown',
    result_summary: item.result || '',
    example_refs: [{ item_id: item.id, ts: item.ts || 0 }],
  };
}

// Fetch completed items in window
const completedRaw = await redis('ZRANGEBYSCORE', 'acmi:inbox:claude-engineer:completed', sinceMs, '+inf');
const stats = { scanned: 0, substantive: 0, written: 0, skipped_duplicate: 0 };
const completedItems = [];

if (Array.isArray(completedRaw)) {
  for (const raw of completedRaw) {
    try {
      const rec = JSON.parse(raw);
      const item = { ...(rec.item || {}), result: rec.result };
      if (item.id) completedItems.push(item);
    } catch {}
  }
}

stats.scanned = completedItems.length;

for (const item of completedItems) {
  if (!isSubstantive(item)) continue;
  stats.substantive++;

  const pattern = extractPattern(item);
  const profileKey = `acmi:skill:${pattern.slug}:profile`;

  // Idempotency: check content hash
  const existing = await redis('GET', profileKey);
  if (existing) {
    const existingParsed = JSON.parse(existing);
    const newHash = contentHash(pattern);
    if (existingParsed._hash === newHash) { stats.skipped_duplicate++; continue; }
  }

  const profile = { ...pattern, _hash: contentHash(pattern), updated_at: nowMs(), applies_to: [item.execution_target || 'any'] };

  if (!DRY_RUN) {
    await redis('SET', profileKey, JSON.stringify(profile));
    await redis('SADD', 'acmi:skill:list', pattern.slug);
    stats.written++;
  } else {
    console.log(`[dry-run] would write skill: ${pattern.slug}`);
    stats.written++;
  }
}

const summary = `skill-extractor: scanned=${stats.scanned} substantive=${stats.substantive} written=${stats.written} skipped_dup=${stats.skipped_duplicate}`;
const ts = nowMs();
if (!DRY_RUN) {
  await redis('ZADD', 'acmi:thread:claude-daily-driver:timeline', ts, JSON.stringify({
    ts, source: 'skill-extractor', kind: 'extraction-complete', summary,
  }));
}

console.log(JSON.stringify({ ok: true, dry_run: DRY_RUN, ...stats }));
