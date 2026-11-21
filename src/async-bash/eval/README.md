# Async bash eval

The eval runs two tasks drawn from [Frontier Harness](https://frontierharness.org/)
tool-use failures. Use their transcripts and timing to compare shell behavior
across builds or with Codex. Read the transcripts to judge how the agent
handled each task.

## Run

```sh
mise run eval:async-bash
mise run eval:async-bash -- --repeat 3 hung-run server
mise run eval:async-bash -- --agent codex --debrief
```

The runner uses the selected provider's key from `.dev/agent/auth.json` and
redacts that key from saved output. Each attempt runs under bubblewrap on
Linux with a temporary home, working directory, and process namespace.
It shares the host network for provider requests and the local service
check. The runner stops the namespace when the attempt reaches its time
budget or the runner finishes collecting results.

- `--agent pi|codex` selects the agent. The default is Pi.
- `--extension <path>` selects the built extension for Pi.
- `--provider`, `--model`, and `--thinking` default to `deepseek`,
  `deepseek-flash`, and `max`.
- `--auth <path>` selects the Pi credentials file.
- `--base-url <url>` sets the Responses API endpoint for Codex.
- `--codex-template <slug>` selects the bundled prompt and tools for Codex.
  It defaults to `gpt-5.5`.
- `--repeat <n>` runs each selected case a positive number of times.
- `--debrief` asks the agent which tool behavior caused extra calls or waiting.
- `--out <dir>` changes where the runner saves results and transcripts. The
  default is `.eval/async-bash/<time>`.

## Cases

- `hung-run` starts training that eventually blocks and ignores TERM. It
  comes from `vpp-loss-divergence` and `chess-best-move`, where a stalled
  command held a long wait or caused repeated polling.
- `server` starts a service from a subdirectory and asks the agent to leave
  it running. It comes from `hf-model-inference` and `kv-store-grpc`, where
  background launch commands held tools open. The runner records the HTTP
  status it observes on the supplied port after the agent returns.

`results.json` records elapsed time, call counts, the slowest tool call,
and result size for each attempt. It also links the saved transcript.
If decoding fails, the report keeps the transcript, elapsed time, and HTTP
observation. `turn_error` records setup, agent, and decoding failures.
An optional debrief appears as `debrief` or `debrief_error`.
