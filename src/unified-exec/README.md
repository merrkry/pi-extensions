# Unified Exec

Provides persistent, owned shell sessions through four model-facing tools:

- `exec_command` starts a pipe or PTY process and returns either its final exit state or a `session_id` when it outlives the bounded wait.
- `write_stdin` serializes input and polling for one session. Text accepts C-style escapes; `chars_b64` is binary-safe.
- `kill_session` terminates a process tree, escalating to `SIGKILL` on POSIX when needed.
- `list_sessions` reports owned sessions and reaps exited entries after reporting them once.

This is a product-focused Effect redesign derived from `pi-unified-exec`, not a line-for-line port. It also exposes the owned-process inventory to the user and Agent without making process state part of the conversation tree.

## Concurrency and lifetime

`UnifiedExec` is a scoped Effect service. A semaphore protects registry and capacity transitions, another bounds concurrent spawns, and each session serializes drains and stdin operations. Process callbacks publish wakeups through a one-element sliding Effect Queue, while Deferred values represent process and output closure. Tool-call cancellation interrupts waits and streaming fibers without discarding the owned process.

The service supports at most 64 registered or pending sessions. At capacity it first reaps exited sessions, then returns a typed capacity failure rather than silently killing a live process.

Processes belong to the current Pi session runtime rather than a single Agent turn or conversation branch. Cancelling a tool wait and navigating with `/tree` leave spawned processes running. Session replacement (`/new`, `/resume`, `/fork`, and `/clone`), extension reload, normal Pi shutdown, and Layer disposal terminate every owned process tree. Abrupt host termination cannot guarantee cleanup or recovery.

## Process inventory and management

The footer keeps an `exec N` status showing the number of running or stopping processes. `/processes` opens a live inventory with process state, total running time, pipe/TTY mode, command, and full working directory. `t` sends `SIGTERM` once without escalation; `k` confirms and sends `SIGKILL` immediately. The management interface observes metadata only and never drains process output or removes exited sessions behind the Agent's back.

At the beginning of each Agent run, a compact inventory is prepared and injected only into the next model context. The injection is not persisted and is consumed after that first request, so later tool-continuation contexts are not polluted. Every owned process is listed; commands are normalized and limited to 128 bytes while working directories remain complete.

Every pipe session may include recent output under per-session limits of 256 bytes and 4 lines, whichever limit is reached first. There is no second cross-process budget: the 64-session capacity and per-session limits already bound the inventory. PTY output is omitted because a raw terminal stream has no stable logical tail without maintaining a terminal-emulator screen model. The inventory is reconstructed from runtime state, so it stays current across `/tree` navigation without becoming tied to a conversation branch.

## Tool rendering

`exec_command` keeps the working directory on a dedicated line so streaming command arguments cannot push it horizontally. Collapsed tool rows retain the first four visual command lines (preserving the CLI name) and the last eight visual output lines. Pi's global `app.tools.expand` action (`Ctrl+O` by default) expands these views, with hard rendering limits of the first 80 command lines and the last 200 output lines. The complete process stream remains available through `log_path`; rendering never attempts to place an unbounded process output in the terminal.

## Output and PTY support

Each process has a bounded in-memory head/tail buffer and a complete log under the platform temporary directory. Tool responses use Pi's standard byte and line tail limits and include the log path for recovery.

Pipe mode uses Node child processes. PTY mode uses the optional official `node-pty` dependency; failure to load its native module affects only `tty: true`. The build keeps `node-pty` external, and `pnpm apply` copies the current platform runtime beside the extension bundle.
