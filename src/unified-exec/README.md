# Unified Exec

Pipe sessions advertise a non-interactive, colorless terminal environment (`TERM=dumb`,
`NO_COLOR=1`, and the common color-force variables disabled). PTY sessions advertise a
usable terminal type. Output sanitization remains a final safety boundary for programs that
ignore those conventions.

Provides persistent, owned shell sessions through four model-facing tools:

- `exec_command` runs a pipe or PTY command and yields a session id when it remains active.
- `write_stdin` writes input or polls an existing session.
- `kill_session` terminates a process tree.
- `list_sessions` reports live sessions.

## Product shape

Background processes remain available across Agent turns and `/tree` navigation. Better TUI Chrome shows the active count near the editor, while `/processes` provides a live, height-aware management view with process details, interrupt, and kill actions. Each `/processes` invocation hides sessions that had already exited when it opened; processes that exit while the view is open remain visible.

Processes that finish before becoming background sessions are removed immediately. Once a session id has been returned, exit produces a retained tombstone regardless of whether the process exits naturally or is ended by the user or Agent. Tombstones use a bounded FIFO. They are omitted from `list_sessions` but remain addressable by known session id, allowing `write_stdin` to collect the final result.

## Lifetime

Processes belong to the current Pi session runtime, not to a turn or conversation branch. Turn cancellation does not terminate them. Session replacement, reload, normal shutdown, and Effect Layer disposal terminate all owned process trees.

Each runtime lazily creates a private temporary log directory. Process logs are bounded rather than guaranteed complete: the default limit is 32 MiB per session and 256 MiB across one runtime. `PI_UNIFIED_EXEC_SESSION_LOG_MAX_BYTES` and `PI_UNIFIED_EXEC_RUNTIME_LOG_MAX_BYTES` accept byte limits, including zero to disable payload logging. Responses and process inventory report whether a log was capped, lost bytes to backpressure, or encountered a write error.

Normal shutdown closes process streams and removes the directory. Each directory has an owner marker; a later runtime removes marked directories older than 24 hours only when their recorded process is no longer alive. Cleanup failures produce one controlled process warning.

## Internal decisions

`UnifiedExec` is a scoped Effect service. Semaphores protect registry transitions, bound concurrent spawning, and serialize per-session input/output operations. Queues and Deferred values bridge process callbacks into interruptible Effects, so cancelling a tool wait does not discard the process.

Live capacity and exited history are bounded independently: up to 64 live or pending sessions and 64 FIFO tombstones. Capacity pressure never evicts a live process.

Pipe mode uses Node child processes. PTY mode uses the optional `@homebridge/node-pty-prebuilt-multiarch` package and fails explicitly when its native module is unavailable. Pi warns at session start when the PTY provider cannot load or the runtime is Bun; pipe mode remains available. Interrupt maps to `SIGINT` on POSIX and terminal Ctrl-C input for Windows PTY sessions; Windows pipe sessions do not expose a reliable graceful interrupt.

Tool and management rendering is always bounded. Unread output is retained in a fixed 64 KiB tail ring with absolute cursors, so one long poll cannot accumulate unbounded memory and an interrupted wait does not commit consumption. Streaming uses a separate fixed 32 KiB tail ring. If either the in-memory capture or bounded log omits data, the response reports that explicitly.

TTY output is never streamed into Pi's update renderer. Pipe updates are output-driven,
coalesced to at most four updates per second, and deduplicated after terminal sanitization;
silent processes therefore cause no periodic TUI work. Log writes honor Node stream backpressure by pausing and resuming both pipe and PTY output; any output that still arrives while the sink is blocked is dropped from the log and counted instead of entering an unbounded queue.
