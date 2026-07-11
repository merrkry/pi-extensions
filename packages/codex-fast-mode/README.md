# Codex Fast Mode

Adds a `/fast` command that toggles Codex fast mode. While enabled, requests from the `openai-codex` provider using OAuth subscription credentials include:

```json
{
  "service_tier": "priority"
}
```

Run `/fast` again to disable it.
