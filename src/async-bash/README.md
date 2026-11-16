# Async bash

Async bash overrides Pi's `bash` tool so slow commands do not block the model.
`bash` waits a few seconds for the command. If it is still running, the call
returns the output so far with a session ID, and the command keeps running.
The model then uses the `process` tool to check on the command, send it input,
or stop it. A command can also be given a time limit, after which it is
stopped.

## Principles

- **Results the model can rely on.** A result says whether the command is
  still running, which output it holds and how to get the rest, and whether
  written input may not have reached the command.
- **No forgotten work.** The model is reminded of sessions that are still
  running, and of finished sessions whose outcome it has not seen, by command
  and state. Without a reminder nothing is pending, and the prompt says so, so
  the model does not check for sessions it never started.
- **Nothing outlives Pi's session.** Commands and the processes they start end
  with Pi's session, and processes, logs, and memory stay bounded.
- **Like Pi's own bash.** Short commands behave as in Pi's bash, with the same
  output limits, environment, and shell settings.
- **Waiting never means losing control.** A call returns after its wait, which
  is capped, and the command keeps running. A time limit is opt-in and stops
  the command whether or not a call is waiting on it. There are no release
  calls; retention is bounded automatically.
- **Tuned on recorded model behavior.** The [eval](eval/README.md) replays
  tool-use failures seen in benchmark runs, and design changes are checked
  against it.

## Decisions

- **A command finishes with its process group, not its shell.** Background
  processes it started keep the session open, so their output is captured and
  `kill` stops them. Processes that leave the group, e.g. through `setsid`, are
  out of scope, as in Pi's bash, and the prompt says so.
- **The command's text stays out of every argv.** The shell evaluates the
  command from an environment variable that it removes first. A `pkill -f` or
  `pgrep -f` pattern in a command therefore never matches the shell running it;
  in recorded runs, models killed their own shell this way despite a warning in
  the prompt.
- **Waits are capped, not rejected.** Models size waits as if they were time
  limits, e.g. 15 minutes for a script that hung after 10 seconds. `bash`
  waits at most 30 seconds and `process` at most 5 minutes, so a hang is
  noticed at the next result.
- **`timeout_ms` stops the process group.** Models expect a time limit, and the
  `timeout` utility signals only its child, and escalates to KILL only with
  `-k`, so a program that ignores TERM outlives it. The limit starts with the
  command, and expiry escalates from TERM to KILL like `process kill`. Results
  state the limit while the command runs and while it is being stopped.
- **A wait ends once the shell has exited.** It continues for two seconds, so
  short-lived descendants still report a final state; background processes
  that remain, such as a server started with `&`, then leave the session
  draining rather than holding the call to its full wait. A wait that starts
  while the session drains lasts until they exit.
- **Results show runtime, silence, and what remains.** A running session
  reports how long it has run and how long it has gone without output. Once it
  has been silent for 10 seconds, and whenever it drains, the result lists the
  processes still running with the kernel function each waits in, so a run
  blocked opening a FIFO can be told from one that sleeps. Python output is
  unbuffered for the same reason; other programs may still buffer output to
  the pipe.
- **Carriage-return redraws show their last frame.** Progress bars that redraw
  a line otherwise fill a page with frames. Only returned text is collapsed;
  the log keeps every byte.
- **Output is a log read by byte cursor.** Reading never consumes output, so a
  repeated or lost call loses nothing. `poll`, `write`, and `kill` continue
  after the output that returned results showed, and a cursor of 0 shows it
  again. Each result holds one page within Pi's output limits; the rest can be
  paged or opened from the log.
- **A requested kill is not an error.** The result reports the signal, but
  only a timeout or a failure the model did not ask for marks it as an error.
- **Only results returned to the model count as seen.** Streaming updates,
  cancelled calls, and cleanup leave the reminder unchanged.
- **Input results report what was observed, not a delivery guarantee.**
  Refused input was not written. Input followed by a stdin failure may have
  been partly read.
- **Stdin is a pipe, not a terminal.** Terminal emulation needs a native
  pseudo-terminal binding, which is hard to distribute and to get right across
  runtimes. Programs that need a terminal run under one the model starts, such
  as `script` or a terminal multiplexer, and Ctrl-C is sent as SIGINT. In the
  eval, models handled the terminal cases this way.
- **Retention is bounded, not managed.** Sessions last until Pi's session ends.
  Only the 64 finished sessions whose outcome the model saw most recently
  are kept, and the prompt states this bound.

## Limitations

- Bun reports no failure when writing to a pipe whose reader has closed, so
  such input is lost without an error
  ([oven-sh/bun#45882](https://github.com/oven-sh/bun/issues/45882)).
- Windows has no process groups: a session ends with its shell, and `kill`
  stops the process tree with `taskkill`.
