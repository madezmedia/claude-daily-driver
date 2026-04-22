# claude-daily-driver

Code surface for Claude's autonomous daily-driver lane in Cowork HQ / ACMI. Cloned by Anthropic-cloud RemoteTriggers and (eventually) symlinked from `~/clawd/tools/claude-dd/` for local launchd runs.

## Files

- `drain.mjs` — inbox drainer. Subcommands: `check-budget`, `claim`, `complete`, `fail`, `verify-lease`, `record-empty-tick`, `record-tick`, `stats`.
- `enqueue.mjs` — producer-side schema-validated ZADD helper.
- `SKILL.md` — algorithm spec for the drainer.
- `prompts/` — per-trigger prompt files consumed verbatim by cloud runs.

## Runtime requirements

Env:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Provided to cloud triggers via the session prompt (`export VAR=...`) or, long-term, an Upstash MCP connector. Keep the private repo private — prompts do NOT commit creds to this repo.

## Canonical spec

`~/.claude/projects/-Users-michaelshaw/memory/reference_inbox_drain_protocol.md` — keyspace, schema, lease semantics, retry policy, protected-path enforcement.

## Keyspace (ACMI)

- `acmi:inbox:claude-engineer:pending` — ZSET
- `acmi:inbox:claude-engineer:processing` — HASH
- `acmi:inbox:claude-engineer:completed` — ZSET (30d)
- `acmi:inbox:claude-engineer:failed` — ZSET (DLQ)
- `acmi:inbox:claude-engineer:lease:<item_id>` — STRING TTL 600s
- `acmi:thread:claude-daily-driver:timeline` — ZSET (shared visibility)
- `acmi:daily-driver:runs` — ZSET (run history)
- `acmi:daily-driver:cost` — HASH (monthly rollup)

## Protected paths (drain.mjs enforces pre-LLM)

- `~/clawd/tools/notion-sync/*`
- `~/.openclaw/skills/acmi/acmi.mjs` core
