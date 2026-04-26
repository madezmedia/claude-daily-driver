#!/usr/bin/env node
/**
 * quota-monitor.mjs — monitors API quota usage across providers.
 * Paths: anthropic-via-headers, gemini-via-gcloud-cli.
 * Writes: acmi:quota:{provider}:signals
 * Alerts: acmi:thread:bentley-pm:timeline on yellow/red.
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

function nowMs() { return Date.now(); }

async function writeSignals(provider, signals) {
  await redis('SET', `acmi:quota:${provider}:signals`, JSON.stringify({ ...signals, updated_at: nowMs() }));
}

async function alertBentley(provider, level, msg) {
  const ts = nowMs();
  await redis('ZADD', 'acmi:thread:bentley-pm:timeline', ts, JSON.stringify({
    ts, source: 'quota-monitor', kind: `quota-${level}`, provider,
    summary: `[quota-${level}] ${provider}: ${msg}`,
  }));
}

// ---- anthropic-via-headers ----
// Wraps an Anthropic API call and captures ratelimit headers from the response.
async function checkAnthropicViaHeaders() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.warn('[anthropic] ANTHROPIC_API_KEY not set — skipping'); return null; }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    const headers = {};
    for (const [k, v] of res.headers.entries()) {
      if (k.startsWith('anthropic-ratelimit-')) {
        headers[k.replace('anthropic-ratelimit-', '')] = v;
      }
    }

    const reqLimit = parseInt(headers['requests-limit'] || '0', 10);
    const reqRemaining = parseInt(headers['requests-remaining'] || '0', 10);
    const tokLimit = parseInt(headers['tokens-limit'] || '0', 10);
    const tokRemaining = parseInt(headers['tokens-remaining'] || '0', 10);
    const resetReq = headers['requests-reset'] || null;
    const resetTok = headers['tokens-reset'] || null;

    const signals = {
      provider: 'anthropic',
      requests: { limit: reqLimit, remaining: reqRemaining, reset: resetReq },
      tokens: { limit: tokLimit, remaining: tokRemaining, reset: resetTok },
      raw_headers: headers,
    };

    await writeSignals('anthropic', signals);

    // Alert thresholds
    const reqPct = reqLimit > 0 ? reqRemaining / reqLimit : 1;
    const tokPct = tokLimit > 0 ? tokRemaining / tokLimit : 1;
    const minPct = Math.min(reqPct, tokPct);

    if (minPct < 0.1) {
      await alertBentley('anthropic', 'red', `only ${Math.round(minPct * 100)}% quota remaining`);
    } else if (minPct < 0.25) {
      await alertBentley('anthropic', 'yellow', `${Math.round(minPct * 100)}% quota remaining`);
    }

    console.log('[anthropic] signals written', signals);
    return signals;
  } catch (e) {
    console.error('[anthropic] error:', e.message);
    return null;
  }
}

// ---- gemini-via-gcloud-cli ----
// Uses gcloud CLI to check Vertex AI / Gemini quota usage.
import { execSync } from 'node:child_process';

async function checkGeminiViaGcloud() {
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) { console.warn('[gemini] GCLOUD_PROJECT not set — skipping'); return null; }

  try {
    // Fetch quota metrics via gcloud
    const raw = execSync(
      `gcloud compute project-info describe --project=${project} --format=json 2>/dev/null`,
      { timeout: 15000, encoding: 'utf8' }
    );
    const info = JSON.parse(raw);
    const quotas = (info.quotas || []).filter(q =>
      q.metric && (q.metric.includes('aiplatform') || q.metric.includes('ml_engine'))
    );

    const signals = {
      provider: 'gemini',
      project,
      quotas: quotas.map(q => ({
        metric: q.metric,
        limit: q.limit,
        usage: q.usage,
        pct_used: q.limit > 0 ? q.usage / q.limit : 0,
      })),
    };

    await writeSignals('gemini', signals);

    const maxUsage = Math.max(...signals.quotas.map(q => q.pct_used || 0), 0);
    if (maxUsage > 0.9) {
      await alertBentley('gemini', 'red', `quota usage at ${Math.round(maxUsage * 100)}%`);
    } else if (maxUsage > 0.75) {
      await alertBentley('gemini', 'yellow', `quota usage at ${Math.round(maxUsage * 100)}%`);
    }

    console.log('[gemini] signals written', { project, quota_count: quotas.length });
    return signals;
  } catch (e) {
    console.warn('[gemini] gcloud error (non-fatal):', e.message);
    // Write empty signals rather than leaving stale
    await writeSignals('gemini', { provider: 'gemini', error: e.message, quotas: [] });
    return null;
  }
}

// ---- main ----
const provider = process.argv[2] || 'all';
const results = {};

if (provider === 'all' || provider === 'anthropic') {
  results.anthropic = await checkAnthropicViaHeaders();
}
if (provider === 'all' || provider === 'gemini') {
  results.gemini = await checkGeminiViaGcloud();
}

console.log(JSON.stringify({ ok: true, providers_checked: Object.keys(results), ts: nowMs() }));
