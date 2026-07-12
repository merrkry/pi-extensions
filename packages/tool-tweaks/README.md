# Tool Tweaks

Adjusts Pi's active tools based on their existing capabilities:

- When `bash` or [`pi-unified-exec`](https://pi.dev/packages/pi-unified-exec)'s `exec_command` is active, removes the redundant built-in `read`, `write`, `grep`, `find`, and `ls` tools.
- Adds `view_image` when either shell tool is active, because shell commands cannot attach an image for the model to inspect.
- When neither shell tool is active, preserves the original active tool set exactly. This keeps restricted agents usable and does not grant tools to agents configured with `tools: none`.

## Design rationale

The dedicated `read`, `grep`, `find`, and `ls` tools duplicate operations the agent can perform with shell commands such as `sed`, `rg`, and `find`. Removing them reduces the number of overlapping tools the model must choose between without removing the underlying capability.

Full-file `write` is intentionally removed for safety. File creation can be performed explicitly through `bash`, while modifying an existing file should normally use `edit`. A full-file write can silently overwrite changes made externally after the agent last observed the file; exact replacements are guarded against stale content and therefore reduce accidental data loss.

`view_image` is the exception because `bash` cannot reproduce its model-facing image attachment semantics.

## Subagent compatibility

This handling targets the [`@gotgenes/pi-subagents`](../../docs/compatibility.md#gotgenespi-subagents) lifecycle described in the shared compatibility notes, rather than every possible subagent implementation.

`tool-tweaks` applies its transformation from `session_start`, so a child observes its own initial allowlist rather than its parent's final active tools. The resulting active set remains in place when `pi-subagents` subsequently applies its recursion guard.

Consequently, the built-in presets are reduced to the shell-oriented tool set and gain `view_image`. The same transformation applies when another extension replaces `bash` with `exec_command` during binding. A custom preset without either shell tool retains its original tools exactly, including `tools: none`. Concurrent children have separate session tool state and do not modify one another.

A different subagent implementation may not receive the same handling if it does not bind parent extensions into children, fires `session_start` at another point, or overwrites active tools after binding.
