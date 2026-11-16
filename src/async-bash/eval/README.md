# Async bash eval

Runs Pi with a model on small tasks, each distilled from a tool-use failure seen
in a [Frontier Harness](https://frontierharness.org/) run with
`deepseek-flash` at thinking `max`, and checks the outcome and how the model
got there.

## Run

```sh
mise run eval:async-bash
mise run eval:async-bash -- --repeat 3 hung-run server
```

The eval builds the extension, copies `auth.json` from `.dev/agent` into a
temporary agent directory, and runs each attempt in its own working directory.
Options:

- `--extension <path>`: the built entry point to load, to compare builds.
- `--provider`, `--model`, `--thinking`: default to `deepseek`,
  `deepseek-flash`, and `max`.
- `--auth <path>`: provider logins to copy.
- `--repeat <n>`: attempts per case. Models vary between attempts, so compare
  builds over several.
- `--out <dir>`: where to keep `results.json` and each attempt's Pi session.
  Defaults to `.eval/async-bash/<time>`.

Attempts run one at a time, since they share the process table: a `pkill`
in one would reach another's processes.

## Cases

Each case passes when every check holds. Time limits allow a direct approach
plus a few turns, so a case also fails when the model gets the answer the long
way.

| Case             | Recorded failure                                                                                                                                                                          | Checks                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `hung-run`       | vpp-loss-divergence: a run deadlocked and ignored TERM inside `timeout 900`, with a 900 s wait, blocking for 15 minutes. chess-best-move: a hung analysis was polled blind for 6 minutes. | Within 90 s, says the run hangs, leaves no run behind.                                   |
| `watch-and-stop` | make-doom-for-mips: fixed `timeout 90s` runs checked for a first frame that took 3 s, and the run ended inside a final 100 s check.                                                       | Within 45 s, reports the delay, stops the program before answering.                      |
| `server`         | hf-model-inference, kv-store-grpc: `cd /app && setsid nohup server &` left a wrapper subshell that held each call for its whole wait, followed by turns spent on the session's state.     | Within 30 s and 6 calls, no call of 4 s or more, the server answers after Pi exits.      |
| `silent-stage`   | schemelike-metacircular-eval, circuit-fibsqrt, html-js-filter: Python buffered progress in the pipe, so polls showed nothing and a healthy run was nearly killed.                         | Within 60 s, names the stage that does not finish, leaves no run behind.                 |
| `restart-worker` | install-windows-3.11: `pkill -f qemu-system` matched its own bash command, which died with code 143 before starting the replacement, twice.                                               | Within 45 s, the old worker stops, one new worker outlives Pi, no command killed itself. |

`results.json` also records metrics per attempt: wall time, tool calls, the
slowest call, uses of the `timeout` utility and of `timeout_ms`, and bash
commands ended by a signal the model did not request.
