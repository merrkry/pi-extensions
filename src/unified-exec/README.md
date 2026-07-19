# Unified Exec

Pipe sessions advertise a non-interactive, colorless terminal environment (`TERM=dumb`,
`NO_COLOR=1`, and the common color-force variables disabled). PTY sessions advertise a
usable terminal type. Output sanitization remains a final safety boundary for programs that
ignore those conventions.

Provides persistent, owned shell sessions through four model-facing tools:

- `exec_command` runs a pipe or PTY command and yields a session id when it remains active.
- `write_stdin` writes input or polls an existing session.
- `kill_session` terminates a process tree.
- `list_sessions` reports live sessions and recent exited-session tombstones.

## Product shape

Background processes remain available across Agent turns and `/tree` navigation. Better TUI Chrome shows the active count near the editor, while `/processes` provides a live, height-aware management view with process details, interrupt, and kill actions.

A compact process inventory is injected once at the start of each Agent run without being persisted in the conversation tree. Pipe sessions may include a bounded output tail; raw PTY tails are omitted because the module does not maintain a terminal-emulator screen model.

Processes that finish before becoming background sessions are removed immediately. Once a session id has been returned, exit produces a retained tombstone regardless of whether the process exits naturally or is ended by the user or Agent. Tombstones use a bounded FIFO.

## Lifetime

Processes belong to the current Pi session runtime, not to a turn or conversation branch. Turn cancellation does not terminate them. Session replacement, reload, normal shutdown, and Effect Layer disposal terminate all owned process trees.

Each runtime owns a temporary log directory containing complete process output. Normal shutdown closes process streams and removes the directory; abrupt host termination leaves cleanup to the operating system.

## Internal decisions

`UnifiedExec` is a scoped Effect service. Semaphores protect registry transitions, bound concurrent spawning, and serialize per-session input/output operations. Queues and Deferred values bridge process callbacks into interruptible Effects, so cancelling a tool wait does not discard the process.

Live capacity and exited history are bounded independently: up to 64 live or pending sessions and 64 FIFO tombstones. Capacity pressure never evicts a live process.

Pipe mode uses Node child processes. PTY mode uses the optional `@homebridge/node-pty-prebuilt-multiarch` package and fails explicitly when its native module is unavailable. Pi warns at session start when the PTY provider cannot load or the runtime is Bun; pipe mode remains available. Interrupt maps to `SIGINT` on POSIX and terminal Ctrl-C input for Windows PTY sessions; Windows pipe sessions do not expose a reliable graceful interrupt.

Tool and management rendering is always bounded. Full output remains available through the runtime log while in-memory buffers and Agent-facing tails stay capped.

TTY output is never streamed into Pi's update renderer. Pipe updates are output-driven,
coalesced to at most four updates per second, and deduplicated after terminal sanitization;
silent processes therefore cause no periodic TUI work.
