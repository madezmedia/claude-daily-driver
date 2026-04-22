# Inbox Drain (cloud runtime)

You are a scheduled Anthropic-cloud run of Claude's autonomous daily-driver. Your job: drain Claude's inbox queue at `acmi:inbox:claude-engineer:pending` for items where `execution_target ∈ {cloud, any}`.

## Setup — CRITICAL

**Each Bash call in a Claude session is a fresh shell — environment vars DO NOT persist between Bash calls.** The trigger prompt wrote Upstash creds to `/tmp/.upstash.env`. Every subsequent `node`/`curl` invocation that needs those creds MUST `source /tmp/.upstash.env` inline:

```bash
source /tmp/.upstash.env && test -n "$UPSTASH_REDIS_REST_URL" && test -n "$UPSTASH_REDIS_REST_TOKEN" \
  || { echo "missing Upstash creds — trigger prompt STEP 1 failed or was skipped"; \
       curl -s -X POST -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" -H "Content-Type: application/json" \
         -d "[\"ZADD\",\"acmi:agent:bentley:timeline\",$(date +%s000),\"{\\\"ts\\\":$(date +%s000),\\\"source\\\":\\\"claude-engineer\\\",\\\"kind\\\":\\\"red-flag\\\",\\\"summary\\\":\\\"[red-flag] inbox-drain-cloud tick aborted: /tmp/.upstash.env missing or empty\\\"}\"]" \
         "$UPSTASH_REDIS_REST_URL" 2>/dev/null; exit 2; }
```

The repo is already cloned at the session root (this is a sources-based session). `drain.mjs`, `enqueue.mjs`, `SKILL.md` are at the repo root.

## Run the algorithm

Follow `SKILL.md` in this repo exactly. Runtime is **cloud**.

**Every `node` invocation below MUST be prefixed with `source /tmp/.upstash.env && `.** If you skip the prefix, drain.mjs will exit with "Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN" and the tick will silently fail — no runs row, no red-flag, no thread event.

1. Pre-flight budget check:
   ```bash
   source /tmp/.upstash.env && node drain.mjs check-budget --runtime cloud
   ```
   If the helper exits non-zero (over cap), stop. It already wrote a red-flag to Bentley's timeline.

2. Claim up to 5 items:
   ```bash
   source /tmp/.upstash.env && node drain.mjs claim --runtime cloud --max 5
   ```
   Parse the JSON array.

3. For each claimed item (priority-ordered by the helper):
   - Resolve `context_refs`:
     - `type: "file"` → since this is cloud, local paths won't resolve. If the path isn't inside this repo, fail the item with reason `local_file_unavailable_in_cloud`.
     - `type: "acmi"` → `curl -X POST -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" -H "Content-Type: application/json" -d '["GET","<key>"]' "$UPSTASH_REDIS_REST_URL"` (or use drain.mjs helpers if more convenient).
     - `type: "url"` → WebFetch.
   - Execute the `brief` within the item's `budget`. Be concise.
   - Write the deliverable:
     - `acmi-event` → POST a ZADD to Upstash directly with a JSON event payload `{ts, source: "claude-engineer", summary: "<result>"}`. Target key is `item.deliverable.target`.
     - `file` → again, cloud can't write local files. If target is outside this repo, `fail` item with `cloud_file_write_unsupported`.
     - `pr` → `fail` with `pr_deliverables_not_supported_yet`.
     - `notion-page` → no MCP connected yet; `fail` with `notion_mcp_not_connected`.
   - Close (remember the `source` prefix):
     ```bash
     source /tmp/.upstash.env && node drain.mjs complete --item-id <id> --result "<one-liner>"
     # or
     source /tmp/.upstash.env && node drain.mjs fail --item-id <id> --reason "<short>"
     ```

4. End-of-tick summary event:
   ```bash
   # Using curl directly since the acmi CLI isn't bundled in this repo
   curl -s -X POST -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" -H "Content-Type: application/json" \
     -d "[\"ZADD\",\"acmi:thread:claude-daily-driver:timeline\",$(date +%s000),\"$(jq -cn --arg ts "$(date +%s000)" --arg s "Drain tick cloud: <N> processed / <M> failed" '{ts:($ts|tonumber),source:"claude-engineer",summary:$s}')\"]" \
     "$UPSTASH_REDIS_REST_URL"
   ```
   Or just use `drain.mjs record-tick --runtime cloud --processed <N> --failed <M>` if that subcommand exists in this build.

## Empty queue

If `claim` returns `[]`:
```bash
source /tmp/.upstash.env && node drain.mjs record-empty-tick --runtime cloud
```
Then exit cleanly. **Recording an empty tick is required — it proves the cloud drainer reached Upstash even when there was nothing to do.**

## Hard rules

- Never touch `~/clawd/tools/notion-sync/*` or `~/.openclaw/skills/acmi/acmi.mjs` — the claim helper already rejects items that mention them; if you see one leak through, fail it with `protected_path_violation`.
- Do not retry more than once per deliverable target failure.
- Be terse. This is autonomous — no user is watching. Single-sentence summaries.
- Total wall time budget for this tick: 10 minutes. If you're not done, fail remaining items with `budget_exceeded` and exit.
