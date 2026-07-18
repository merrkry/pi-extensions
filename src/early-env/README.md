# Early Env

Loads process environment variables from the agent-level `env.json` before the rest of the bundled extension is installed.

The file is resolved under `${PI_CODING_AGENT_DIR}` when set, otherwise under `${PI_CONFIG_DIR:-$HOME/.pi}/agent`. It must contain a JSON object whose values are strings. Invalid keys, non-string values, and values containing NUL bytes are ignored rather than assigned to `process.env`.

Loading happens once during module evaluation—the earliest point an extension can affect the process environment—and once again during application installation. A missing file is allowed. Parse, validation, and assignment problems are summarized as a bounded warning when a UI session starts.
