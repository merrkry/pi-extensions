# Unified Exec

Provides persistent, owned shell sessions through four model-facing tools:

- `exec_command` starts a pipe or PTY process and returns either its final exit state or a `session_id` when it outlives the bounded wait.
- `write_stdin` serializes input and polling for one session. Text accepts C-style escapes; `chars_b64` is binary-safe.
- `kill_session` terminates a process tree, escalating to `SIGKILL` on POSIX when needed.
- `list_sessions` reports owned sessions and reaps exited entries after reporting them once.

This is a product-focused Effect redesign derived from `pi-unified-exec`, not a line-for-line port. Session-management widgets and an interactive session command remain deferred while their user interaction is redesigned.

## Concurrency and lifetime

`UnifiedExec` is a scoped Effect service. A semaphore protects registry and capacity transitions, another bounds concurrent spawns, and each session serializes drains and stdin operations. Process callbacks publish wakeups through a one-element sliding Effect Queue, while Deferred values represent process and output closure. Tool-call cancellation interrupts waits and streaming fibers without discarding the owned process.

The service supports at most 64 registered or pending sessions. At capacity it first reaps exited sessions, then returns a typed capacity failure rather than silently killing a live process. Session shutdown and Layer disposal terminate every owned process tree.

## Tool rendering

`exec_command` keeps the working directory on a dedicated line so streaming command arguments cannot push it horizontally. Collapsed tool rows retain the first four visual command lines (preserving the CLI name) and the last eight visual output lines. Pi's global `app.tools.expand` action (`Ctrl+O` by default) expands these views, with hard rendering limits of the first 80 command lines and the last 200 output lines. The complete process stream remains available through `log_path`; rendering never attempts to place an unbounded process output in the terminal.

## Output and PTY support

Each process has a bounded in-memory head/tail buffer and a complete log under the platform temporary directory. Tool responses use Pi's standard byte and line tail limits and include the log path for recovery.

Pipe mode uses Node child processes. PTY mode uses the optional official `node-pty` dependency; failure to load its native module affects only `tty: true`. The build keeps `node-pty` external, and `pnpm apply` copies the current platform runtime beside the extension bundle.
