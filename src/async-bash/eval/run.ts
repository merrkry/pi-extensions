import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Duration, Effect, Fiber, FileSystem, Option, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Agent, codex, type Invocation, pi } from "./agents.ts";
import {
  type Case,
  cases,
  type Check,
  registered,
  type Run,
  SESSION_TOOLS,
  SHELL_TOOLS,
  unrequestedSignalExits,
} from "./cases.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
// The agent gets this long after TERM to stop its own commands before it is killed.
const AGENT_TERMINATION_GRACE = Duration.seconds(10);
const DEBRIEF_BUDGET = Duration.minutes(5);
const DEBRIEF_PROMPT =
  "The task is over; do not run any more tools. Give a short retrospective on how you used the shell tools in this task: (1) where a tool result confused you or left you unsure what state a command was in, (2) where a tool behaved differently from what you expected, and (3) what tool behavior or wording would have let you finish with fewer calls or less waiting. Cite the specific calls. If nothing applies, say so.";

const { values: options, positionals: selected } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string", default: "pi" },
    extension: { type: "string", default: join(repository, "dist/index.js") },
    provider: { type: "string", default: "deepseek" },
    model: { type: "string", default: "deepseek-flash" },
    thinking: { type: "string", default: "max" },
    auth: { type: "string", default: join(repository, ".dev/agent/auth.json") },
    "base-url": { type: "string", default: "https://api.deepseek.com/v1" },
    "codex-template": { type: "string", default: "gpt-5.5" },
    repeat: { type: "string", default: "1" },
    debrief: { type: "boolean", default: false },
    out: { type: "string" },
  },
});

interface Result {
  case: string;
  attempt: number;
  passed: boolean;
  checks: Check[];
  metrics: Record<string, number>;
  transcript: string;
  debrief?: string;
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

function metrics(run: Run): Record<string, number> {
  const shell = run.calls.filter((call) => SHELL_TOOLS.has(call.name));
  const commands = shell.map((call) => {
    const command = call.args["command"] ?? call.args["cmd"];
    return typeof command === "string" ? command : "";
  });
  return {
    wall_seconds: Math.round(run.wallSeconds),
    tool_calls: run.calls.length,
    shell_calls: shell.length,
    session_calls: run.calls.filter((call) => SESSION_TOOLS.has(call.name)).length,
    slowest_call_seconds: Math.round(Math.max(0, ...run.calls.map((call) => call.seconds))),
    result_kilobytes: Math.round(run.calls.reduce((sum, call) => sum + call.text.length, 0) / 1024),
    timeout_utility_uses: commands.filter((command) => /\btimeout\s+(?:-\S+\s+)*\d/u.test(command))
      .length,
    unrequested_signal_exits: unrequestedSignalExits(run.calls),
    // Calls that looked into the eval's own bookkeeping rather than the task.
    state_reads: run.calls.filter((call) => {
      const args = JSON.stringify(call.args);
      return args.includes("EVAL_STATE") || args.includes(run.stateDirectory);
    }).length,
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

/** Runs one agent turn within `budget`; the result says whether it exited on its own. */
const invoke = (
  invocation: Invocation,
  cwd: string,
  env: Record<string, string>,
  budget: Duration.Duration,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(invocation.command, invocation.args, {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env, ...invocation.env },
        extendEnv: false,
      });
      const stdout = yield* Stream.mkString(Stream.decodeText(child.stdout)).pipe(
        Effect.forkScoped,
      );
      const stderr = yield* Stream.mkString(Stream.decodeText(child.stderr)).pipe(
        Effect.forkScoped,
      );
      const exit = yield* child.exitCode.pipe(Effect.timeoutOption(budget));
      if (Option.isNone(exit)) {
        yield* child.kill({ killSignal: "SIGTERM", forceKillAfter: AGENT_TERMINATION_GRACE });
      }
      return {
        finished: Option.isSome(exit),
        stdout: yield* Fiber.join(stdout),
        stderr: yield* Fiber.join(stderr),
      };
    }),
  );

function attempt(agent: Agent, testCase: Case, index: number, out: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "async-bash-eval-" });
      const workdir = join(root, "work");
      const stateDirectory = join(root, "state");
      const home = join(root, "home");
      for (const directory of [workdir, stateDirectory, home]) {
        yield* fs.makeDirectory(directory, { mode: 0o700 });
      }
      yield* fs.makeDirectory(join(stateDirectory, "pids"));
      yield* fs.makeDirectory(join(stateDirectory, "secrets"));
      yield* agent.prepare(home);
      for (const [name, content] of Object.entries(testCase.files)) {
        yield* fs.makeDirectory(dirname(join(workdir, name)), { recursive: true });
        yield* fs.writeFileString(join(workdir, name), content);
      }
      for (const name of testCase.fifos ?? []) {
        yield* Effect.sync(() => execFileSync("mkfifo", [join(workdir, name)]));
      }
      const port = yield* freePort;
      const env = { EVAL_STATE: stateDirectory };
      if (testCase.prepare) {
        const script = testCase.prepare;
        yield* Effect.sync(() =>
          execFileSync("python3", ["-c", script], {
            cwd: workdir,
            env: { ...process.env, ...env },
          }),
        );
      }

      // Fixtures are stopped even when the attempt fails or is interrupted.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => registered(stateDirectory)).pipe(
          Effect.flatMap(killAll),
          Effect.ignore,
        ),
      );
      // The attempt's scope owns each fixture's process group from the start, so an attempt
      // interrupted before a fixture registers still stops it.
      for (const script of testCase.setup ?? []) {
        yield* ChildProcess.make("python3", [script], {
          cwd: workdir,
          env: { ...process.env, ...env },
          extendEnv: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          forceKillAfter: Duration.seconds(1),
        });
      }
      const setupPids = yield* Effect.promise(async () => {
        const expected = testCase.setup?.length ?? 0;
        for (let tries = 0; tries < 50; tries++) {
          const pids = await registered(stateDirectory);
          if (pids.length >= expected) return pids;
          await new Promise((wake) => setTimeout(wake, 100));
        }
        throw new Error(`${testCase.name}: setup fixtures did not start`);
      });

      const started = performance.now();
      const turn = yield* invoke(
        agent.start(home, workdir, testCase.prompt(port)),
        workdir,
        env,
        Duration.seconds(testCase.budgetSeconds),
      );
      const wallSeconds = (performance.now() - started) / 1000;

      const name = `${testCase.name}-${index}`;
      const transcript = yield* agent
        .transcript(home)
        .pipe(
          Effect.mapError(
            (error) => new Error(`${name}: no transcript (${String(error)})\n${turn.stderr}`),
          ),
        );
      yield* fs.copyFile(transcript.file, join(out, `${name}.jsonl`));
      const run: Run = {
        workdir,
        stateDirectory,
        port,
        finished: turn.finished,
        wallSeconds,
        setupPids,
        calls: transcript.calls,
        finalText: transcript.finalText,
        answerStartedAt: transcript.answerStartedAt,
      };
      // Let processes the agent stopped on exit finish dying before checks look at them.
      yield* Effect.sleep(Duration.seconds(1));
      // Checks read files the agent left behind, so a malformed one fails the attempt, not the eval.
      const checks = yield* Effect.tryPromise({
        try: () => testCase.check(run),
        catch: (cause) => (cause instanceof Error ? cause.message : JSON.stringify(cause)),
      }).pipe(
        Effect.catch((detail) =>
          Effect.succeed<Check[]>([{ name: "checks ran", ok: false, detail }]),
        ),
      );

      let debrief: string | undefined;
      if (options.debrief) {
        const invocation = agent.debrief(home, transcript, DEBRIEF_PROMPT);
        const reply = yield* invoke(invocation, workdir, env, DEBRIEF_BUDGET);
        debrief = invocation.answerFile
          ? yield* fs.readFileString(invocation.answerFile).pipe(Effect.orElseSucceed(() => ""))
          : reply.stdout.trim();
      }
      return {
        case: testCase.name,
        attempt: index,
        passed: checks.every((item) => item.ok),
        checks,
        metrics: metrics(run),
        transcript: `${name}.jsonl`,
        ...(debrief === undefined ? {} : { debrief }),
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
  const agentOptions = {
    provider: options.provider,
    model: options.model,
    thinking: options.thinking,
    auth: resolve(options.auth),
    extension: resolve(options.extension),
    baseUrl: options["base-url"],
    codexTemplate: options["codex-template"],
  };
  const agents: Record<string, () => Agent> = {
    pi: () => pi(agentOptions),
    codex: () => codex(agentOptions),
  };
  const makeAgent = agents[options.agent];
  if (!makeAgent) return yield* Effect.fail(new Error(`Unknown agent: ${options.agent}`));
  const agent = makeAgent();

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
      attempt(agent, testCase, index, out).pipe(
        Effect.tap((result) =>
          Effect.sync(() => console.error(summarize([result]).split("\n")[0])),
        ),
      ),
    // Attempts share the process table, e.g. pkill in one would stop another's fixtures.
    { concurrency: 1 },
  );
  const { auth: _auth, ...recorded } = agentOptions;
  const report = { agent: options.agent, ...recorded, results };
  yield* fs.writeFileString(join(out, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  yield* Effect.sync(() => console.log(`${summarize(results)}\nResults: ${out}`));
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
