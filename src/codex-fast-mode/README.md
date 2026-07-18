# Codex Fast Mode

Adds a `/fast` command that toggles Codex fast mode. While enabled, requests from the `openai-codex` provider using OAuth subscription credentials include:

```json
{
  "service_tier": "priority"
}
```

The toggle is process-global through the shared [`FastMode`](../shared/README.md#fast-mode) capability, so every in-process session observes the same state. New sessions reflect the current state in their status line, and Better TUI Chrome includes it in its footer. Run `/fast` again to disable it.

Requests for other providers, API-key credentials, missing models, and non-object payloads are left unchanged.
