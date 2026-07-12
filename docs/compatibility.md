# Compatibility Notes

This document records the behavior of external extensions and CLIs that packages in this repository integrate with. Package-specific decisions—what an extension changes, preserves, or rejects in response—remain in each package's README.

These notes describe the contracts relied on by the current implementations. They are not general guarantees about similarly named tools or alternative extensions.

## `pi-unified-exec`

[`pi-unified-exec`](https://pi.dev/packages/pi-unified-exec) provides the `exec_command` shell tool. Its command text is passed as `input.cmd`, whereas Pi's built-in `bash` tool uses `input.command`.

An `exec_command` call with `tty: true` requests an interactive terminal session. Such calls preserve terminal-oriented behavior and may be continued through `write_stdin`; transforming their command text as if they were non-interactive commands can change those semantics.

The extension can be used in tool sets where `exec_command` takes the role otherwise served by `bash`. Both tools provide enough general shell and filesystem capability to overlap with Pi's dedicated `read`, `write`, `grep`, `find`, and `ls` tools. Neither can reproduce `view_image`'s model-facing image attachment.

## `@gotgenes/pi-subagents`

[`@gotgenes/pi-subagents`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents) creates each child as an in-process Pi session with the selected agent preset's tool allowlist. It loads the parent's extensions into that child and calls `bindExtensions()`, which fires their `session_start` handlers against the child session.

After extension binding, `pi-subagents` reads the resulting active tool set and applies its recursion guard by removing its own dispatch tools. It does not restore tools removed by another extension during binding.

Its built-in presets include `bash`. Custom presets may omit shell tools entirely, including by specifying `tools: none`. Each concurrently running child has separate session tool state, while process-global extension state is shared because the children run in-process.

These details are specific to this implementation. Another subagent extensions may bind extensions at a different point, overwrite active tools afterward, isolate process state, or not load parent extensions at all.

## RTK CLI

[`rtk`](https://github.com/rtk-ai/rtk) exposes `rtk rewrite` for converting supported commands to lower-output equivalents. The rewrite protocol uses these exit codes:

| Code | Meaning                                | Rewrite output               |
| ---: | -------------------------------------- | ---------------------------- |
|  `0` | allowed                                | rewritten command on stdout  |
|  `1` | unsupported / pass through             | no rewrite should be applied |
|  `2` | deny or defer the decision to the host | no rewrite should be applied |
|  `3` | advisory / ask                         | rewritten command on stdout  |

A successful protocol outcome still needs non-empty stdout to provide a usable command. A killed or failed rewrite process does not provide a valid rewrite.

`RTK_DISABLED=1` disables rewriting. It may be set in Pi's environment for a global bypass or prefixed to one command—for example, `RTK_DISABLED=1 git status`—for a one-call bypass recognized by `rtk rewrite`. Commands already beginning with `rtk ` are also intended to pass through rather than be recursively rewritten.
