# Async bash eval

Runs a coding agent with a model on tasks distilled from tool-use failures seen
in a [Frontier Harness](https://frontierharness.org/) run with `deepseek-flash`
at thinking `max`, and checks the outcome and how the model got there. A case
belongs here only if the tools decide it: a model that overcomes weaker tools
on its own makes the case measure the model instead. The agent is Pi with this extension, or Codex as a reference for another
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

The runner tracks fixture processes itself, by looking every 200 ms for Python
processes running a case's script from the working directory. Fixtures also
mark their start in a state directory named by `EVAL_STATE`, for runs too short
to be seen; `state_reads` counts the calls that looked into it.

## Cases

Each case passes when every check holds. Time limits allow a direct approach
plus a few turns, so a case also fails when the model gets the answer the long
way.

"Stopped it before answering" holds when the model ran the fixture and the
runner last saw it before the last tool result preceding the final answer: Pi
stops its sessions when it exits, so a fixture being gone at check time proves
nothing.

| Case       | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Checks                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `hung-run` | vpp-loss-divergence: a run deadlocked and ignored TERM inside `timeout 900`, with a 900 s wait, blocking for 15 minutes. chess-best-move: a hung analysis was polled blind for 6 minutes. The prompt, like those tasks, expects a run of minutes. Epochs compute silently for up to 14 s, so silence alone shows no hang, and the hang shows only at run time: one shard's warnings fill the loader's stderr pipe, which `train.py` reads only after stdout ends. | Within 150 s, reports the final loss or that the run cannot finish, edits nothing, stopped it before answering. |
| `server`   | hf-model-inference, kv-store-grpc: `cd /app && setsid nohup server &` left a wrapper subshell that held each call for its whole wait, followed by turns spent on the session's state. The service must start from its directory.                                                                                                                                                                                                                                  | Within 30 s and 6 calls, no call of 4 s or more, the server answers after the agent exits.                      |

`results.json` also records metrics per attempt: wall time, tool calls, shell
and session calls, the slowest call, kilobytes of tool results, uses of the
`timeout` utility, shell commands ended by a signal the model did not request,
and `state_reads`.
