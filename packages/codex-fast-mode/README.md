# Codex Fast Mode

Adds a `/fast` command that toggles Codex fast mode. While enabled, requests from the `openai-codex` provider using OAuth subscription credentials include:

```json
{
  "service_tier": "priority"
}
```

The toggle is process-global, so in-process child sessions use the same state. This includes children created by [`@gotgenes/pi-subagents`](../../docs/compatibility.md#gotgenespi-subagents). New sessions also reflect the current state in their status line. Run `/fast` again to disable it.
