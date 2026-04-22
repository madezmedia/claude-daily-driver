# ACMI Health Check

Weekly audit of the ACMI keyspace. Produces a health report and auto-enqueues P2 inbox items for each violation.

## Setup

```bash
test -n "$UPSTASH_REDIS_REST_URL" && test -n "$UPSTASH_REDIS_REST_TOKEN" || { echo "missing creds"; exit 2; }
```

## Checks

Use curl + jq against the Upstash REST endpoint (pattern: `curl -s -X POST -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" -H "Content-Type: application/json" -d '[<cmd>,<args>...]' "$UPSTASH_REDIS_REST_URL"`).

1. **Agent registry parity.** `SMEMBERS acmi:agent:list` → for each agent, verify `acmi:agent:<id>:profile` and `acmi:agent:<id>:signals` both exist (`EXISTS` returns 1). List missing.

2. **Timeline presence.** For each agent in the registry, `ZCARD acmi:agent:<id>:timeline` > 0. List empties.

3. **Stale agents.** For each agent, `ZREVRANGE acmi:agent:<id>:timeline 0 0` → parse ts from the returned JSON. If last event is >14 days old, list it.

4. **Orphan timelines.** Scan keys matching `acmi:agent:*:timeline` with `SCAN 0 MATCH acmi:agent:*:timeline COUNT 200`. For each, extract `<id>` and verify it's in `acmi:agent:list`. Orphans = timelines without a registry entry.

5. **Required onboarding fields.** For each agent, parse `signals` JSON and check required fields per `~/.claude/projects/-Users-michaelshaw/memory/reference_acmi_agent_onboarding.md` (this memory won't be available in cloud — check against a canonical list: `model_id`, `onboarding_status`, `collaboration_preferences`, `native_tools`, `best_used_for`).

## Output

Write a single summary event to `acmi:agent:claude-engineer:timeline` with source `self` and a bullet-list summary: `{total_agents}/{clean}, missing_fields: [...], stale: [...], orphans: [...]`.

For each violation, also enqueue a P2 inbox item via `node enqueue.mjs '<json>'` (the repo has it). Example:

```bash
node enqueue.mjs '{
  "priority": 2,
  "from": "claude-engineer",
  "execution_target": "any",
  "kind": "review",
  "title": "Backfill missing signals for agent <id>",
  "brief": "Agent <id> is missing required signals fields: <list>. Fill them in based on the agent'"'"'s most recent activity on their timeline.",
  "deliverable": {"type": "acmi-event", "target": "acmi:agent:<id>:timeline"},
  "budget": {"max_minutes": 5, "max_tool_calls": 10},
  "protected_paths_ack": true
}'
```

Total wall time: 8 minutes. Skip any check that exceeds 2 minutes on its own; note it in the summary.
