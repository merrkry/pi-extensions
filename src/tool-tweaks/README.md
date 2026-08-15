# Tool Tweaks

Adjusts Pi's active tools from the capabilities already available to the session:

- When `bash` or the bundled `exec_command` tool is active, removes the redundant built-in `read`, `write`, `grep`, `find`, and `ls` tools.
- Adds `view_image` when either shell tool is active because shell commands cannot attach an image for the model to inspect.
- When neither shell tool is active, preserves the original active tool set exactly, including `tools: none`.
- Preserves the complete unified-exec family and any unrelated tools already active.
- Restores Pi's available-skills section with shell-oriented loading guidance when `read` was replaced. If `read` remains active, Pi's native skills prompt is left untouched.

## Design rationale

The dedicated file-inspection tools duplicate operations available through shell commands such as `sed`, `rg`, `fd`, and `find`. Removing overlap reduces tool-selection ambiguity without removing the underlying capability.

Full-file `write` is intentionally removed for safety. New files can be created explicitly through the shell, while existing files should normally be modified with exact replacement. Exact replacement detects stale source text instead of silently overwriting external changes.

`view_image` is the exception because its model-facing image attachment semantics cannot be reproduced by shell output. The module delegates execution to Pi's own read-tool implementation so path handling remains host-compatible.

Pi normally includes discovered skill metadata only while the `read` tool is active. When this module replaces `read`, a `before_agent_start` handler formats the same discovered skills through Pi's public formatter, changes only the loading instruction to name `exec_command` (or `bash` when that is the available shell tool), and appends the section once. It skips injection when `read` is active or a skills section is already present.
