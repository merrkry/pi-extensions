# Async bash

Async bash overrides Pi's `bash` tool so slow commands do not block the model.
`bash` waits a few seconds for the command. If it is still running, the call
returns the output so far with a session ID, and the command keeps running.
The model then uses the `process` tool to check on the command, send it input,
or stop it.

## Principles

- **Results the model can rely on.** A result says whether the command is
  still running and, while it is, how long it has run and gone without output.
  It also says which output it holds and how to get the rest, and whether
  written input may not have reached the command.
- **No forgotten work.** The model is reminded of sessions that are still
  running, and of finished sessions whose outcome it has not seen.
- **A session is its shell.** A command is finished when its shell exits, and
  commands still running end with Pi's session.
- **Like Pi's own bash.** Short commands behave as in Pi's bash, with the same
  output limits, environment, and shell settings.
- **The model decides when to wait and stop.** A command runs until it exits,
  the model stops it, or a time limit the model set runs out. There are no
  release calls; retention is bounded automatically.

## Decisions

- **A command finishes with its shell, not its process group.** Processes it
  left in the background keep running and are outside the session, as in Pi's
  bash. Commands routinely start servers this way, and waiting for such
  processes would hold the call that started them.
- **A finished command's output is complete.** A command writes to its log
  itself, so once a result reports it finished, everything it wrote is in the
  log, in the order it was written.
- **Output is a log read by byte cursor.** Reading never consumes output, so a
  repeated or lost call loses nothing. Each result holds one page within Pi's
  output limits; the rest can be paged or opened from the log. `poll`, `write`,
  and `kill` continue after the output earlier results showed.
- **Only results returned to the model count as seen.** Streaming updates,
  cancelled calls, and cleanup leave the reminder and the default cursor
  unchanged.
- **The wait is a request.** A call returns as soon as the command finishes.
  `yield_time_ms` asks when to get control back from a command that is still
  running. Pi keeps it within bounds instead of rejecting it: long enough
  for a quick command to finish within its call, short enough for the model's
  next request to still reach the provider's prompt cache.
- **A stop asks, then forces.** `kill`, the time limit, and the end of Pi's
  session ask the command and the processes in its group to end, so that they
  can clean up, and end by force what is left of them after a grace period.
  Cancelling a call only ends its wait, since the command may be work that
  should not be cut short.
- **Input results report what was observed, not a delivery guarantee.**
  Refused input was not written. Input followed by a stdin failure may have
  been partly read.
- **Stdin is a pipe, not a terminal.** Programs that need terminal features run
  in an external terminal multiplexer.
- **Retention is bounded, not managed.** Sessions last until Pi's session ends,
  except that only the finished sessions whose outcome the model saw most
  recently are kept. The prompt states the bound.

## Limitations

- A process left in the background keeps writing to the command's log unless
  its output is redirected, also after Pi has removed the session, and the log
  takes space until that process ends.
- A command that opens its own output by path, e.g. with `> /dev/stderr`,
  fails, as it does in Pi's bash. Run by a privileged user, it truncates the
  log instead.
- Bun reports no failure when writing to a pipe whose reader has closed, so
  such input is lost without an error
  ([oven-sh/bun#45882](https://github.com/oven-sh/bun/issues/45882)).
- Windows has no process groups: a stop ends the command's process tree by
  force at once.
