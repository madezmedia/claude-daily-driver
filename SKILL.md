---
name: inbox-drain
description: >
  Drain Claude's autonomous work queue at acmi:inbox:claude-engineer. Use when
  invoked by a scheduled run (RemoteTrigger OR launchd → `claude --print`) or
  manually to process pending items. Reads ACMI via Upstash Redis REST, claims
  items with SET NX leases, executes the brief, and triple-writes results to
  ACMI. Do NOT use for one-off tasks — use this ONLY as part of the
  daily-driver schedule or manual queue processing.
---

# Inbox Drain

You are processing items from Claude's autonomous work queue. Contract and schema live at `~/.claude/projects/-Users-michaelshaw/memory/reference_inbox_drain_protocol.md` — read it if you need the full spec.

## Runtime detection

First determine which mode you're in:
- If `PAPERCLIP_*` env vars are set, or you were invoked with `--runtime=local`, you're in **local** mode. Drain items where `execution_target ∈ {local, any}`.
- Otherwise you're in **cloud** mode. Drain items where `execution_target ∈ {cloud, any}`.

You can also be told explicitly via the prompt: "drain cloud items only" or "drain local items only".

## Algorithm

1. **Pre-flight budget check.** Before any work:
   ```bash
   node ~/.claude/skills/inbox-drain/drain.mjs check-budget --runtime <cloud|local>
   ```
   If over cap, the helper writes a `[red-flag]` to Bentley's timeline and exits. You should also stop.

2. **Claim up to 5 items** for your runtime:
   ```bash
   node ~/.claude/skills/inbox-drain/drain.mjs claim --runtime <cloud|local> --max 5
   ```
   Output: JSON array of claimed items (empty array if nothing pending or all leased). Each item has `id`, `brief`, `context_refs`, `deliverable`, `budget`.

3. **For each claimed item**, in priority order (already sorted by the helper):
   a. Read any `context_refs` — for `type: "file"` use Read tool; for `type: "acmi"` use `node ~/.openclaw/skills/acmi/acmi.mjs get <namespace> <id>`; for `type: "url"` use WebFetch.
   b. Execute the `brief` within the item's `budget.max_minutes` and `budget.max_tool_calls`. Be concise — this is autonomous work, no user waiting.
   c. Write the deliverable:
      - `acmi-event` → `node ~/.openclaw/skills/acmi/acmi.mjs event <parsed from target> claude-engineer "<result summary>"`
      - `file` → `Write` tool to the target path
      - `notion-page` → Notion MCP `create_page` or `update_page`
      - `pr` → out of scope for Phase 1, mark item as `failed` with reason `pr_deliverables_not_supported_yet`
   d. Close the item:
      ```bash
      node ~/.claude/skills/inbox-drain/drain.mjs complete --item-id <id> --result "<1-line summary>"
      ```
      OR on failure:
      ```bash
      node ~/.claude/skills/inbox-drain/drain.mjs fail --item-id <id> --reason "<short reason>"
      ```

4. **Record the tick**: the `claim` and `complete`/`fail` helpers handle per-item ACMI writes + `acmi:daily-driver:runs` row. You don't need to manually ZADD.

## Protected paths — REFUSE if encountered

The `claim` helper already rejects items whose `brief` or `context_refs` mention these. If you somehow see an item touching these paths, immediately `fail` it with reason `protected_path_violation`:
- `~/clawd/tools/notion-sync/*`
- `~/.openclaw/skills/acmi/acmi.mjs` core (extending with new subcommands is fine; modifying existing `redis()` / `main()` is not)

## Failure modes to handle

- **Lease lost mid-execution**: if you've been running >9 minutes on a single item, the 600s lease has expired. Another drainer may have claimed the item. Before writing the deliverable, re-check lease: `node ~/.claude/skills/inbox-drain/drain.mjs verify-lease --item-id <id>`. If not held, abandon and don't write.
- **Deliverable target unreachable**: e.g., ACMI offline, Notion API 5xx. Retry once with 2s backoff. If still failing, `fail` item with `reason: "deliverable_target_error: <short>"`.
- **Budget exceeded mid-execution**: stop, `fail` item with `reason: "budget_exceeded"`. It goes to DLQ on retry 3 or back to pending.

## Output

At end of drain, write ONE event to `acmi:thread:claude-daily-driver:timeline` summarizing the tick:
```bash
node ~/.openclaw/skills/acmi/acmi.mjs event thread claude-daily-driver claude-engineer "Drain tick <runtime>: <N processed> / <M failed>. Budget: <used>/<cap>."
```

## Empty queue behavior

If `claim` returns `[]`, still record the tick (so `acmi:daily-driver:runs` accurately reflects when the drainer fired) and exit cleanly:
```bash
node ~/.claude/skills/inbox-drain/drain.mjs record-empty-tick --runtime <cloud|local>
```

## Environment

Required env vars (source from `~/clawd/.env` via `set -a; source ~/clawd/.env; set +a` at shell start):
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

If missing, `drain.mjs` exits 1 with clear error. Don't proceed.
