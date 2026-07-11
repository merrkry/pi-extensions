# Tool Tweaks

Adjusts Pi's active tools based on their existing capabilities:

- When `bash` is active, removes the redundant built-in `read`, `write`, `grep`, `find`, and `ls` tools.
- Adds `view_image` when `bash` is active, because shell commands cannot attach an image for the model to inspect.
- When `bash` is not active, preserves the original active tool set exactly. This keeps restricted agents usable and does not grant tools to agents configured with `tools: none`.

## Design rationale

The dedicated `read`, `grep`, `find`, and `ls` tools duplicate operations the agent can perform with shell commands such as `sed`, `rg`, and `find`. Removing them reduces the number of overlapping tools the model must choose between without removing the underlying capability.

Full-file `write` is intentionally removed for safety. File creation can be performed explicitly through `bash`, while modifying an existing file should normally use `edit`. A full-file write can silently overwrite changes made externally after the agent last observed the file; exact replacements are guarded against stale content and therefore reduce accidental data loss.

`view_image` is the exception because `bash` cannot reproduce its model-facing image attachment semantics.

## Subagent compatibility

The subagent behavior documented here specifically assumes [`@gotgenes/pi-subagents`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents), rather than every possible subagent implementation.

That extension creates each child as an in-process Pi session with the agent preset's tool allowlist, loads the parent's extensions into the child, and calls `bindExtensions()`. Binding fires this extension's `session_start` handler against the child session, so `getActiveTools()` observes that child's own initial allowlist and the transformation is applied independently. After binding, `pi-subagents` reads the resulting active set and applies only its recursion guard, removing its own dispatch tools without restoring the built-in tools removed here.

Consequently, its built-in presets, which all include `bash`, are reduced to the shell-oriented tool set and gain `view_image`. A custom preset without `bash` retains its original tools exactly, including `tools: none`. Concurrent children have separate session tool state and do not modify one another.

This compatibility relies on that loading order and post-bind behavior. A different subagent extension that does not bind parent extensions into child sessions, fires `session_start` at another point, or overwrites active tools after binding may not receive the same behavior.
