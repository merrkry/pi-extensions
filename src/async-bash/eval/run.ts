import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Duration, Effect, Fiber, FileSystem, Option, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Agent, codex, type Invocation, pi, providerKey } from "./agents.ts";
import {
  type Case,
  cases,
  type Check,
  type Run,
  SESSION_TOOLS,
  SHELL_TOOLS,
  SIGHTING_INTERVAL_MS,
  type Sighting,
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

/**
 * Records processes running one of the case's scripts from `workdir`, so checks need nothing from
 * the fixtures themselves. Only Python processes count, so a tracer or shell naming the script in
 * its arguments is not taken for it. Linux only.
 */
function watchFixtures(scripts: Set<string>, workdir: string, sightings: Map<number, Sighting>) {
  const look = async () => {
    const now = Date.now();
    for (const entry of await readdir("/proc").catch(() => [])) {
      if (!/^\d+$/u.test(entry)) continue;
      const pid = Number(entry);
      const known = sightings.get(pid);
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
      if (!stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) continue;
      if (known) {
        known.lastSeen = now;
        continue;
      }
      if (!stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")).startsWith("python")) continue;
      const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""))
        .split("\0")
        .filter(Boolean);
      const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => undefined);
      const script = argv.slice(1).find((arg) => scripts.has(basename(arg)));
      if (!script || !cwd || !resolve(cwd, script).startsWith(`${workdir}/`)) continue;
      sightings.set(pid, { name: basename(script, ".py"), pid, firstSeen: now, lastSeen: now });
    }
  };
  return Effect.promise(look).pipe(
    Effect.andThen(Effect.sleep(SIGHTING_INTERVAL_MS)),
    Effect.forever,
  );
}

/** Every fixture run: those the runner saw, and those that marked their start but ended unseen. */
const fixtureRuns = (
  fs: FileSystem.FileSystem,
  stateDirectory: string,
  sightings: Map<number, Sighting>,
) =>
  Effect.gen(function* () {
    const runs = [...sightings.values()].map((sighting) => ({ ...sighting }));
    for (const entry of yield* fs.readDirectory(join(stateDirectory, "started"))) {
      const pid = Number(entry.slice(entry.lastIndexOf(".") + 1));
      if (sightings.has(pid)) continue;
      const info = yield* fs.stat(join(stateDirectory, "started", entry));
      const at = Option.getOrElse(info.mtime, () => new Date(0)).getTime();
      runs.push({ name: entry.slice(0, entry.lastIndexOf(".")), pid, firstSeen: at, lastSeen: at });
    }
    return runs;
  });

/** A directory's files by path relative to it. */
const snapshot = (fs: FileSystem.FileSystem, directory: string) =>
  Effect.gen(function* () {
    const files = new Map<string, string>();
    for (const path of yield* fs.readDirectory(directory, { recursive: true })) {
      const info = yield* fs.stat(join(directory, path));
      if (info.type === "File") files.set(path, yield* fs.readFileString(join(directory, path)));
    }
    return files;
  });

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

/** Attempts run under bubblewrap, so that scores never come from an agent that read the cases. */
const bubblewrap = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("The eval runs attempts under bubblewrap; install bwrap (Linux only).");
  }
})();

const nodeInstallation = resolve(process.execPath, "../..");

/**
 * Hides the home directory, /tmp, the eval's sources and Git history, and results, including `out`
 * wherever it is, from the agent, so an attempt sees neither the cases' answers, earlier attempts, nor
 * credentials beyond its own, which models otherwise go looking for. The attempt's directory, the
 * repository and Node installation the agent runs from, and the extension under test stay visible.
 */
function sandboxed(
  invocation: Invocation,
  root: string,
  extension: string,
  out: string,
): Invocation {
  const hidden = [
    ...["src/async-bash/eval", ".eval", ".dev", ".git"].map((path) => join(repository, path)),
    out,
  ]
    .filter((path) => existsSync(path))
    // A worktree's .git is a file.
    .flatMap((path) =>
      statSync(path).isDirectory() ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path],
    );
  return {
    ...invocation,
    command: bubblewrap,
    args: [
      "--dev-bind",
      "/",
      "/",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      homedir(),
      "--ro-bind",
      repository,
      repository,
      "--ro-bind",
      nodeInstallation,
      nodeInstallation,
      ...hidden,
      "--ro-bind",
      dirname(extension),
      dirname(extension),
      "--bind",
      root,
      root,
      "--die-with-parent",
      "--",
      invocation.command,
      ...invocation.args,
    ],
  };
}

/** What agents see of the host's environment: enough to run programs, and none of its credentials. */
const hostEnvironment = Object.fromEntries(
  ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TZ", "LOCALE_ARCHIVE"]
    .map((name) => [name, process.env[name]])
    .filter((entry): entry is [string, string] => entry[1] !== undefined),
);

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
        env: { ...hostEnvironment, ...env, ...invocation.env },
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

/** Results never hold the API key, even where the model printed it, e.g. after reading auth.json. */
type Redact = (text: string) => string;

function attempt(
  agent: Agent,
  testCase: Case,
  index: number,
  out: string,
  extension: string,
  redact: Redact,
) {
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
      yield* fs.makeDirectory(join(stateDirectory, "started"));
      yield* agent.prepare(home);
      for (const [name, content] of Object.entries(testCase.files)) {
        yield* fs.makeDirectory(dirname(join(workdir, name)), { recursive: true });
        yield* fs.writeFileString(join(workdir, name), content);
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

      const inputs = yield* snapshot(fs, workdir);
      const sightings = new Map<number, Sighting>();
      // Fixtures are stopped even when the attempt fails or is interrupted, including those meant
      // to outlive the agent. Finalizers run in reverse, so the watcher has stopped by then.
      yield* Effect.addFinalizer(() => killAll([...sightings.keys()]));
      const scripts = new Set(Object.keys(testCase.files).filter((file) => file.endsWith(".py")));
      yield* watchFixtures(
        new Set([...scripts].map((file) => basename(file))),
        workdir,
        sightings,
      ).pipe(Effect.forkScoped);

      const started = performance.now();
      const turn = yield* invoke(
        sandboxed(agent.start(home, workdir, testCase.prompt(port)), root, extension, out),
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
      yield* fs.writeFileString(
        join(out, `${name}.jsonl`),
        redact(yield* fs.readFileString(transcript.file)),
      );
      // Let processes the agent stopped on exit finish dying before checks look at them.
      yield* Effect.sleep(Duration.seconds(1));
      const run: Run = {
        workdir,
        inputs,
        stateDirectory,
        port,
        finished: turn.finished,
        wallSeconds,
        fixtures: yield* fixtureRuns(fs, stateDirectory, sightings),
        calls: transcript.calls,
        finalText: transcript.finalText,
        answerStartedAt: transcript.answerStartedAt,
      };
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
        const reply = yield* invoke(
          sandboxed(invocation, root, extension, out),
          workdir,
          env,
          DEBRIEF_BUDGET,
        );
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
  // Agents load a copy under a neutral name, so its path does not tell them which build it is.
  const built = resolve(options.extension);
  const staged = yield* fs.makeTempDirectoryScoped({ prefix: "pi-extension-" });
  for (const file of yield* fs.readDirectory(dirname(built))) {
    if (file.endsWith(".js")) yield* fs.copyFile(join(dirname(built), file), join(staged, file));
  }
  const extension = join(staged, basename(built));
  const modelsCache = yield* fs.makeTempDirectoryScoped({ prefix: "async-bash-eval-models-" });
  const agentOptions = {
    provider: options.provider,
    model: options.model,
    thinking: options.thinking,
    key: yield* Effect.promise(() =>
      providerKey(resolve(options.auth), options.provider, join(modelsCache, "models.json")),
    ),
    extension,
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

  const redact: Redact = (text) => text.replaceAll(agentOptions.key, "[API key]");
  const attempts = chosen.flatMap((testCase) =>
    Array.from({ length: Number(options.repeat) }, (_, index) => ({ testCase, index: index + 1 })),
  );
  const results = yield* Effect.forEach(
    attempts,
    ({ testCase, index }) =>
      attempt(agent, testCase, index, out, extension, redact).pipe(
        Effect.tap((result) =>
          Effect.sync(() => console.error(summarize([result]).split("\n")[0])),
        ),
      ),
    // Attempts share the process table, e.g. pkill in one would stop another's fixtures.
    { concurrency: 1 },
  );
  const { key: _key, ...recorded } = { ...agentOptions, extension: built };
  const report = { agent: options.agent, ...recorded, results };
  yield* fs.writeFileString(
    join(out, "results.json"),
    redact(`${JSON.stringify(report, null, 2)}\n`),
  );
  yield* Effect.sync(() => console.log(`${summarize(results)}\nResults: ${out}`));
});

NodeRuntime.runMain(main.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
