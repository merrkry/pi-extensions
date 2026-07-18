# Compatibility Notes

This document records the external contracts used by the root Pi extension bundle. They are not general guarantees about similarly named tools or alternative extensions.

## Pi host

Pi supplies `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `typebox` to loaded extensions. Following Pi's package guidance, imported host modules remain external to the bundle and are declared as `"*"` peer dependencies rather than installed by Pi's extension package manager.

The `"*"` peer range is a loading convention, not a compatibility guarantee. Pi is pre-1.0 and its changelog includes extension-facing breaking changes in patch releases. This bundle is developed and tested against the versions resolved in `pnpm-lock.yaml`; support for another Pi host version must be established by testing the APIs used here.

Development uses Pi-compatible TypeBox because runtime schemas are created and validated with the host-provided TypeBox implementation.

## `pi-unified-exec`

[`pi-unified-exec`](https://github.com/merrkry/pi-unified-exec/commits/prod/) provides `exec_command`, whose command text is `input.cmd`; Pi's built-in `bash` uses `input.command`.

An `exec_command` call with `tty: true` requests an interactive terminal session and may be continued with `write_stdin`. RTK never transforms these calls. Non-interactive calls, including calls where `tty` is omitted, may be offered to RTK.

The tool policy treats active `bash` and `exec_command` as equivalent shell capabilities. When either is active, it removes only `read`, `write`, `grep`, `find`, and `ls`, and adds `view_image`. It does not remove `exec_command`, `write_stdin`, `kill_session`, or `list_sessions`; any registered unified-exec family members already active remain active. When neither shell tool is active, the original active set is preserved exactly.

## RTK CLI

[`rtk`](https://github.com/rtk-ai/rtk) exposes `rtk rewrite` for converting supported commands to lower-output equivalents. The bundle requires `rtk >= 0.23.0` in `PATH` and disables only the RTK feature when the executable is missing, too old, or its version check fails.

The rewrite protocol uses these exit codes:

| Code | Meaning                                | Rewrite output               |
| ---: | -------------------------------------- | ---------------------------- |
|  `0` | allowed                                | rewritten command on stdout  |
|  `1` | unsupported / pass through             | no rewrite should be applied |
|  `2` | deny or defer the decision to the host | no rewrite should be applied |
|  `3` | advisory / ask                         | rewritten command on stdout  |

A rewrite is applied only for exit code 0 or 3 with non-empty stdout. Killed processes, cancellation, rejected `pi.exec` calls, and all other outcomes fail open and leave the original tool input unchanged. Failures in RTK setup or rewriting do not prevent the other five features from loading or running.

`RTK_DISABLED=1` disables rewriting. It may be set in Pi's environment for a global bypass or prefixed to one command for a one-call bypass recognized by `rtk rewrite`. Commands already beginning with `rtk ` pass through to avoid recursive rewriting.
