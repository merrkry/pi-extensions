# Async bash

Async bash overrides Pi's `bash` tool so slow commands do not block the model.
`bash` waits a few seconds for the command. If it is still running, the call
returns the output so far with a session ID, and the command keeps running.
The model then uses the `process` tool to check on the command, send it input,
or stop it.

## Principles

- **Results the model can rely on.** A result says whether the command is
  still running, which output it holds and how to get the rest, and whether
  written input may not have reached the command.
- **No forgotten work.** The model is reminded of sessions that are still
  running, and of finished sessions whose outcome it has not seen.
- **Nothing outlives Pi's session.** Commands and the processes they start end
  with Pi's session, and processes, logs, and memory stay bounded.
- **Like Pi's own bash.** Short commands behave as in Pi's bash, with the same
  output limits, environment, and shell settings.
- **The model decides when to wait and stop.** There are no execution timeouts
  and no release calls; retention is bounded automatically.

## Decisions

- **A command finishes with its process group, not its shell.** Background
  processes it started keep the session open, so their output is captured and
  `kill` stops them. Processes that leave the group, e.g. through `setsid`, are
  out of scope, as in Pi's bash, and the prompt says so.
- **Output is a log read by byte cursor.** Reading never consumes output, so a
  repeated or lost call loses nothing. Each result holds one page within Pi's
  output limits; the rest can be paged or opened from the log.
- **Only results returned to the model count as seen.** Streaming updates,
  cancelled calls, and cleanup leave the reminder unchanged.
- **Input results report what was observed, not a delivery guarantee.**
  Refused input was not written. Input followed by a stdin failure may have
  been partly read.
- **Stdin is a pipe, not a terminal.** Programs that need terminal features run
  in an external terminal multiplexer.
- **Retention is bounded, not managed.** Sessions last until Pi's session ends.
  Only the 64 finished sessions whose outcome the model saw most recently
  are kept, and the prompt states this bound.

## Limitations

- Bun reports no failure when writing to a pipe whose reader has closed, so
  such input is lost without an error
  ([oven-sh/bun#45882](https://github.com/oven-sh/bun/issues/45882)).
- Windows has no process groups: a session ends with its shell, and `kill`
  stops the process tree with `taskkill`.
