# Async bash eval

Runs a coding agent with a model on small tasks, each distilled from a tool-use
failure seen in a [Frontier Harness](https://frontierharness.org/) run with
`deepseek-flash` at thinking `max`, or from a Terminal-Bench task whose
difficulty lies in tool mechanics, and checks the outcome and how the model got
there. The agent is Pi with this extension, or Codex as a reference for another
harness's shell tools.

## Run

```sh
mise run eval:async-bash
mise run eval:async-bash -- --repeat 3 hung-run server
mise run eval:async-bash -- --agent codex --debrief
```

The eval builds the extension, gives each attempt a temporary home for the
agent and its own working directory, and reads the API key from `auth.json` in
`.dev/agent`. Options:

- `--agent pi|codex`: the agent to run. Defaults to `pi`.
- `--extension <path>`: Pi only; the built entry point to load, to compare
  builds.
- `--provider`, `--model`, `--thinking`: default to `deepseek`,
  `deepseek-flash`, and `max`.
- `--auth <path>`: Pi's `auth.json`, which holds the provider's API key.
- `--base-url <url>`: Codex only; the provider's Responses API. Defaults to
  DeepSeek's.
- `--codex-template <slug>`: Codex only; the bundled model whose prompt and
  tools the eval model gets. Defaults to `gpt-5.5`, the latest one that calls
  `exec_command` and `write_stdin` directly rather than through code mode.
- `--repeat <n>`: attempts per case. Models vary between attempts, so compare
  builds over several.
- `--debrief`: after each attempt, ask the model in the same session where the
  shell tools confused it or could have saved calls, and keep the answer in
  `results.json`. Pi answers without tools.
- `--out <dir>`: where to keep `results.json` and each attempt's transcript.
  Defaults to `.eval/async-bash/<time>`.

Attempts run one at a time, since they share the process table: a `pkill`
in one would reach another's processes. On Linux with bubblewrap, each runs
with the home directory, `/tmp`, and the eval's sources and results hidden, so
models cannot read the cases, earlier attempts, or other credentials.

Fixtures record digests of per-run values, such as a token the answer must
contain, in a state directory named by `EVAL_STATE`. Models find it, so it
holds nothing that answers a task; `state_reads` counts the calls that looked.
The runner tracks fixture processes itself, by looking every 200 ms for Python
processes running a case's script from the working directory; fixtures also
mark their start there, for runs too short to be seen.

## Cases

Each case passes when every check holds. Time limits allow a direct approach
plus a few turns, so a case also fails when the model gets the answer the long
way.

"Stopped it before answering" holds when the model ran the fixture and the
runner last saw it before the last tool result preceding the final answer: Pi
stops its sessions when it exits, so a fixture being gone at check time proves
nothing.

| Case               | Source                                                                                                                                                                                                                                                                                                                                         | Checks                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hung-run`         | vpp-loss-divergence: a run deadlocked and ignored TERM inside `timeout 900`, with a 900 s wait, blocking for 15 minutes. chess-best-move: a hung analysis was polled blind for 6 minutes. The prompt, like those tasks, expects a run of minutes, and the hang shows only at run time: a shard without parts makes `zcat` read the open stdin. | Within 120 s, says the run cannot finish, edits nothing, stopped it before answering.                                                                       |
| `watch-and-stop`   | make-doom-for-mips: fixed `timeout 90s` runs checked for a first frame that took 3 s, and the run ended inside a final 100 s check.                                                                                                                                                                                                            | Within 45 s, reports the delay, stopped it before answering.                                                                                                |
| `server`           | hf-model-inference, kv-store-grpc: `cd /app && setsid nohup server &` left a wrapper subshell that held each call for its whole wait, followed by turns spent on the session's state. The service must start from its directory.                                                                                                               | Within 30 s and 6 calls, no call of 4 s or more, the server answers after the agent exits.                                                                  |
| `service-cycle`    | hf-model-inference, kv-store-grpc, install-windows-3.11: a service started from its directory, checked, then reconfigured and restarted by the model that started it, where `cd /app && setsid nohup server &` held calls and `pkill -f` killed its own command. One route blocks the single-threaded service, so the check hangs.             | Within 180 s, names the blocking route, one service with the new greeting outlives the agent, no command killed itself, the check stopped before answering. |
| `silent-stage`     | schemelike-metacircular-eval, circuit-fibsqrt, html-js-filter: Python buffered progress in the pipe, so polls showed nothing and a healthy run was nearly killed.                                                                                                                                                                              | Within 60 s, names the stage that does not finish, stopped it before answering.                                                                             |
| `restart-worker`   | install-windows-3.11: after starting qemu itself, the model restarted it with `pkill -f qemu-system` in the same command, which matched its own bash command and died with code 143 before starting the replacement, twice.                                                                                                                    | Within 60 s, the worker it started is replaced by one in fast mode that outlives the agent, no command killed itself.                                       |
| `test-timeout`     | vpp-loss-divergence, Terminal-Bench cancel-async-tasks: a test that deadlocked and ignored TERM inside `timeout`, which moves its command out of the session's process group, with a helper that waits for its clients on TERM.                                                                                                                | Within 90 s, names the hanging test, stopped both processes before answering.                                                                               |
| `debugger-repl`    | Terminal-Bench custom-memory-heap-crash, play-zork: a debugger prompt without a newline, then input that depends on earlier output.                                                                                                                                                                                                            | Within 90 s, reaches the ready state, reports the token, edits nothing, stopped it before answering.                                                        |
| `overwrite-prompt` | Terminal-Bench crack-7z-hash, openssl-selfsigned-cert: a second, unexpected prompt, which piped input answers with end of input.                                                                                                                                                                                                               | Within 60 s, the extracted secret, not the stale decoy, is in `answer.txt`, the extractor stopped before answering.                                         |
| `needs-tty`        | Terminal-Bench play-zork, headless-terminal: a program that refuses to run without a terminal and reads a single key.                                                                                                                                                                                                                          | Within 90 s, writes the unlock code, edits nothing, stopped it before answering.                                                                            |
| `ctrl-c-summary`   | Terminal-Bench cancel-async-tasks: results are written only on a keyboard interrupt, which TERM does not deliver.                                                                                                                                                                                                                              | Within 60 s, `summary.json` from a run of 5 s or more, reports the mean, stopped it before answering.                                                       |
| `flood-once`       | Terminal-Bench large-scale-text-editing, pretrain-shard-corruption: 400,000 lines in 20 s from an expensive run, with the one failure in the middle.                                                                                                                                                                                           | Within 75 s, reports the failing test and message, runs the suite once.                                                                                     |
| `redraw-stall`     | Terminal-Bench hf-model-inference, caffe-cifar-10: a progress bar that redraws with carriage returns and keeps printing after the download stalls.                                                                                                                                                                                             | Within 90 s, reports the checksum of a finished download, stopped it before answering.                                                                      |

`results.json` also records metrics per attempt: wall time, tool calls, shell
and session calls, the slowest call, kilobytes of tool results, uses of the
`timeout` utility, shell commands ended by a signal the model did not request,
and `state_reads`.
