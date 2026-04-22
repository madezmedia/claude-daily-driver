# Integration Smoke Test

Twice-weekly ping of external integrations. Posts a pass/fail matrix on Bentley's timeline; red-flags any failures.

## Setup

```bash
test -n "$UPSTASH_REDIS_REST_URL" && test -n "$UPSTASH_REDIS_REST_TOKEN" || { echo "missing creds"; exit 2; }
```

If `POSTIZ_API_URL` and `POSTIZ_API_KEY` are in the env (passed via the trigger prompt), include Postiz. If `GITHUB_TOKEN` is present, include GitHub rate-limit. Otherwise skip those checks and note them as `skipped_no_creds` in the output.

## Checks

1. **Upstash Redis** — `["PING"]` via REST. Expected: `"PONG"`.
2. **GitHub API rate limit** — `curl -s -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/rate_limit` → extract `.resources.core.remaining`. Red-flag if <500.
3. **Postiz** — `curl -s -H "Authorization: $POSTIZ_API_KEY" "$POSTIZ_API_URL/integrations/list"` → should return JSON with integration records. Red-flag on 5xx or empty.

MCP-based checks (Notion DB list, Gmail unread count, Slack `auth.test`) require MCP connectors on the trigger. The user hasn't connected any yet — skip them and note `requires_mcp_setup`.

## Output

Write a matrix event to `acmi:agent:bentley:timeline` with source `claude-engineer`. Format:

```
[smoke-test] Integration status: upstash=pass github=<remaining>/<limit> postiz=<pass|fail> notion=skip gmail=skip slack=skip
```

If any check fails, also ZADD a `[red-flag]` event to `acmi:agent:bentley:timeline`:

```
[red-flag] Integration <name> failed: <short reason>
```

Total wall time: 5 minutes.
