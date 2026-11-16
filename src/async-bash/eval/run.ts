import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Duration, Effect, Fiber, FileSystem, Option, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type Case,
  cases,
  type Check,
  registered,
  type Run,
  type ToolCall,
  unrequestedSignalExits,
} from "./cases.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
// Pi gets this long after TERM to stop its bash sessions before it is killed.
const PI_TERMINATION_GRACE = Duration.seconds(10);

const { values: options, positionals: selected } = parseArgs({
  allowPositionals: true,
  options: {
    extension: { type: "string", default: join(repository, "dist/index.js") },
    provider: { type: "string", default: "deepseek" },
    model: { type: "string", default: "deepseek-flash" },
    thinking: { type: "string", default: "max" },
    auth: { type: "string", default: join(repository, ".dev/agent/auth.json") },
    repeat: { type: "string", default: "1" },
    out: { type: "string" },
  },
});

interface Result {
  case: string;
  attempt: number;
  passed: boolean;
  checks: Check[];
  metrics: Record<string, number>;
  session?: string;
}

const freePort = Effect.callback<number, Error>((resume) => {
  const server = createServer();
  server.once("error", (error) => resume(Effect.fail(error)));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() =>
      typeof address === "object" && address
        ? resume(Effect.succeed(address.port))
        : resume(Effect.fail(new Error("No port assigned"))),
    );
  });
});

type Entry = {
  type: string;
  timestamp?: string;
  message?: {
    role: string;
    content?: Array<Record<string, unknown>> | string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    durationMs?: number;
  };
};

const textOf = (content: Array<Record<string, unknown>>) =>
  content
    .filter((part) => part["type"] === "text")
    .map((part) => String(part["text"]))
    .join("");

/** Tool calls and the final answer, read from Pi's session file. */
function readSession(lines: string[]) {
  const calls = new Map<string, ToolCall>();
  let finalText = "";
  let finalAt: number | undefined;
  for (const line of lines) {
    const entry = JSON.parse(line) as Entry;
    const message = entry.message;
    if (entry.type !== "message" || !message || !Array.isArray(message.content)) continue;
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part["type"] !== "toolCall") continue;
        calls.set(String(part["id"]), {
          name: String(part["name"]),
          args: (part["arguments"] ?? {}) as Record<string, unknown>,
          text: "",
          isError: false,
          seconds: 0,
        });
      }
      const text = textOf(message.content);
      if (text.trim()) {
        finalText = text;
        finalAt = entry.timestamp ? Date.parse(entry.timestamp) : undefined;
      }
    } else if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId ?? "");
      if (!call) continue;
      call.text = textOf(message.content);
      call.isError = message.isError ?? false;
      call.seconds = (message.durationMs ?? 0) / 1000;
    }
  }
  return { calls: [...calls.values()], finalText, finalAt };
}

function metrics(run: Run): Record<string, number> {
  const bash = run.calls.filter((call) => call.name === "bash");
  const commands = bash.map((call) => {
    const command = call.args["command"];
    return typeof command === "string" ? command : "";
  });
  return {
    wall_seconds: Math.round(run.wallSeconds),
    tool_calls: run.calls.length,
    bash_calls: bash.length,
    process_calls: run.calls.filter((call) => call.name === "process").length,
    slowest_call_seconds: Math.round(Math.max(0, ...run.calls.map((call) => call.seconds))),
    timeout_utility_uses: commands.filter((command) => /\btimeout\s+(?:-\S+\s+)*\d/u.test(command))
      .length,
    timeout_ms_uses: bash.filter((call) => call.args["timeout_ms"] !== undefined).length,
    unrequested_signal_exits: unrequestedSignalExits(run.calls),
  };
}

const killAll = (pids: number[]) =>
  Effect.sync(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

function attempt(testCase: Case, index: number, out: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "async-bash-eval-" });
      const workdir = join(root, "work");
      const pidDirectory = join(root, "pids");
      const agentDirectory = join(root, "agent");
      const sessionDirectory = join(root, "sessions");
      for (const directory of [workdir, pidDirectory, agentDirectory, sessionDirectory]) {
        yield* fs.makeDirectory(directory, { mode: 0o700 });
      }
      yield* fs.copyFile(resolve(options.auth), join(agentDirectory, "auth.json"));
      for (const [name, content] of Object.entries(testCase.files)) {
        yield* fs.makeDirectory(dirname(join(workdir, name)), { recursive: true });
        yield* fs.writeFileString(join(workdir, name), content);
      }
      for (const name of testCase.fifos ?? []) {
        yield* Effect.sync(() => execFileSync("mkfifo", [join(workdir, name)]));
      }
      const port = yield* freePort;
      const env = { ...process.env, EVAL_PIDS: pidDirectory };

      // Fixtures are stopped even when the attempt fails or is interrupted.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => registered(pidDirectory)).pipe(Effect.flatMap(killAll), Effect.ignore),
      );
      for (const script of testCase.setup ?? []) {
        yield* Effect.sync(() =>
          spawn("python3", [script], {
            cwd: workdir,
            env,
            detached: true,
            stdio: "ignore",
          }).unref(),
        );
      }
      const setupPids = yield* Effect.promise(async () => {
        const expected = testCase.setup?.length ?? 0;
        for (let tries = 0; tries < 50; tries++) {
          const pids = await registered(pidDirectory);
          if (pids.length >= expected) return pids;
          await new Promise((wake) => setTimeout(wake, 100));
        }
        throw new Error(`${testCase.name}: setup fixtures did not start`);
      });

      const cli = fileURLToPath(
        new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
      );
      const started = performance.now();
      const pi = yield* ChildProcess.make(
        process.execPath,
        [
          cli,
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--no-mcp",
          "--no-approve",
          "--extension",
          resolve(options.extension),
          "--provider",
          options.provider,
          "--model",
          options.model,
          "--thinking",
          options.thinking,
          "--session-dir",
          sessionDirectory,
          "--print",
          "--mode",
          "json",
          "--",
          testCase.prompt(port),
        ],
        {
          cwd: workdir,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          env: {
            ...env,
            PI_CODING_AGENT_DIR: agentDirectory,
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0",
          },
          extendEnv: false,
        },
      );
      const stderr = yield* Stream.mkString(Stream.decodeText(pi.stderr)).pipe(Effect.forkScoped);
      const exit = yield* pi.exitCode.pipe(
        Effect.timeoutOption(Duration.seconds(testCase.budgetSeconds)),
      );
      const finished = Option.isSome(exit);
      if (!finished) {
        yield* pi.kill({ killSignal: "SIGTERM", forceKillAfter: PI_TERMINATION_GRACE });
      }
      const wallSeconds = (performance.now() - started) / 1000;

      const name = `${testCase.name}-${index}`;
      const sessions = yield* fs.readDirectory(sessionDirectory);
      const sessionFile = sessions[0];
      if (sessionFile === undefined) {
        const log = yield* Fiber.join(stderr);
        return yield* Effect.fail(new Error(`${name}: Pi wrote no session\n${log}`));
      }
      yield* fs.copyFile(join(sessionDirectory, sessionFile), join(out, `${name}.jsonl`));
      const content = yield* fs.readFileString(join(sessionDirectory, sessionFile));
      const session = readSession(content.split("\n").filter(Boolean));

      const run: Run = {
        workdir,
        pidDirectory,
        port,
        finished,
        wallSeconds,
        setupPids,
        ...session,
      };
      // Let processes Pi stopped on exit finish dying before checks look at them.
      yield* Effect.sleep(Duration.seconds(1));
      const checks = yield* Effect.promise(() => testCase.check(run));
      return {
        case: testCase.name,
        attempt: index,
        passed: checks.every((item) => item.ok),
        checks,
        metrics: metrics(run),
        session: `${name}.jsonl`,
      } satisfies Result;
    }),
  );
}

function summarize(results: Result[]): string {
  const lines = [];
  for (const result of results) {
    const failed = result.checks.filter((item) => !item.ok);
    const detail = failed
      .map((item) => `${item.name}${item.detail ? ` (${item.detail})` : ""}`)
      .join("; ");
    const { wall_seconds, tool_calls, slowest_call_seconds } = result.metrics;
    lines.push(
      `${result.passed ? "PASS" : "FAIL"} ${result.case}#${result.attempt} ${wall_seconds} s, ${tool_calls} calls, slowest ${slowest_call_seconds} s${detail ? ` — ${detail}` : ""}`,
    );
  }
  const passed = results.filter((result) => result.passed).length;
  lines.push(`${passed}/${results.length} passed`);
  return lines.join("\n");
}

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const unknown = selected.filter((name) => !cases.some((item) => item.name === name));
  if (unknown.length) {
    return yield* Effect.fail(new Error(`Unknown cases: ${unknown.join(", ")}`));
  }
  const chosen = selected.length ? cases.filter((item) => selected.includes(item.name)) : cases;
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const out = resolve(options.out ?? join(repository, ".eval/async-bash", stamp));
  yield* fs.makeDirectory(out, { recursive: true });

  const attempts = chosen.flatMap((testCase) =>
    Array.from({ length: Number(options.repeat) }, (_, index) => ({ testCase, index: index + 1 })),
  );
  const results = yield* Effect.forEach(
    attempts,
    ({ testCase, index }) =>
      attempt(testCase, index, out).pipe(
        Effect.tap((result) =>
          Effect.sync(() => console.error(summarize([result]).split("\n")[0])),
        ),
      ),
    // Attempts share the process table, e.g. pkill in one would stop another's fixtures.
    { concurrency: 1 },
  );
  const report = {
    extension: resolve(options.extension),
    provider: options.provider,
    model: options.model,
    thinking: options.thinking,
    results,
  };
  yield* fs.writeFileString(join(out, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  yield* Effect.sync(() => console.log(`${summarize(results)}\nResults: ${out}`));
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
