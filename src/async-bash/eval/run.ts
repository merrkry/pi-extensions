import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Duration, Effect, FileSystem, Option } from "effect";
import { ChildProcess } from "effect/process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Agent, codex, type Invocation, pi, providerKey } from "./agents.ts";
import { onlyTranscript, readAttemptFile } from "./artifacts.ts";
import { type Case, cases, SESSION_TOOLS, SHELL_TOOLS, type ToolCall } from "./cases.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
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

const repetitions = Number(options.repeat);
if (!/^\d+$/u.test(options.repeat) || !Number.isSafeInteger(repetitions) || repetitions < 1) {
  throw new Error("--repeat must be a positive integer");
}

interface Result {
  case: string;
  attempt: number;
  observation?: string;
  metrics: Record<string, number>;
  transcript: string;
  turn_error?: string;
  debrief?: string;
  debrief_error?: string;
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

function metrics(calls: ToolCall[], wallSeconds: number): Record<string, number> {
  return {
    wall_seconds: Math.round(wallSeconds),
    tool_calls: calls.length,
    shell_calls: calls.filter((call) => SHELL_TOOLS.has(call.name)).length,
    session_calls: calls.filter((call) => SESSION_TOOLS.has(call.name)).length,
    slowest_call_seconds: Math.round(Math.max(0, ...calls.map((call) => call.seconds))),
    result_kilobytes: Math.round(calls.reduce((sum, call) => sum + call.text.length, 0) / 1024),
  };
}

/** Runs agents with isolated files and process namespaces. */
const bubblewrap = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("The eval runs attempts under bubblewrap; install bwrap (Linux only).");
  }
})();

const runtimePaths = [
  "/bin",
  "/lib",
  "/lib64",
  "/usr/bin",
  "/usr/lib",
  "/usr/lib64",
  "/usr/share",
  "/etc/ld.so.cache",
  "/etc/localtime",
  "/etc/nsswitch.conf",
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/pki/tls/certs",
  "/etc/ssl/certs",
  "/etc/ssl/openssl.cnf",
  "/nix/store",
  "/etc/profiles/per-user",
  "/run/current-system/sw",
  "/nix/var/nix/profiles/default",
  process.execPath,
  join(repository, "node_modules"),
];

function sandboxed(invocation: Invocation, root: string, extension: string): Invocation {
  const readOnly = [
    ...new Set([...runtimePaths, dirname(extension), ...(invocation.readOnly ?? [])]),
  ]
    .filter((path) => existsSync(path))
    .flatMap((path) => ["--ro-bind", path, path]);
  return {
    ...invocation,
    command: bubblewrap,
    args: [
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--new-session",
      "--dir",
      homedir(),
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      ...readOnly,
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

const hostEnvironment = Object.fromEntries(
  ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TZ", "LOCALE_ARCHIVE"]
    .map((name) => [name, process.env[name]])
    .filter((entry): entry is [string, string] => entry[1] !== undefined),
);

/**
 * Wraps a sandboxed agent so that its sandbox outlives it: a process namespace ends with the
 * command bubblewrap runs, and processes the agent started to keep running, such as a server, must
 * survive until the checks have looked at them. The wrapper reports the agent's output and exit
 * code in `files`, then waits until the attempt ends and stops the sandbox.
 */
function outliving(invocation: Invocation, files: { out: string; err: string; code: string }) {
  return {
    ...invocation,
    command: "sh",
    args: [
      "-c",
      'out=$1 err=$2 code=$3; shift 3; "$@" >"$out" 2>"$err"; echo $? >"$code.part"; mv "$code.part" "$code"; exec sleep infinity',
      "sh",
      files.out,
      files.err,
      files.code,
      invocation.command,
      ...invocation.args,
    ],
  };
}

/**
 * Runs one agent turn within `budget`; the result says whether it exited on its own. The sandbox
 * stays until the caller's scope closes; see `outliving`.
 */
const invoke = (
  invocation: Invocation,
  root: string,
  extension: string,
  cwd: string,
  budget: Duration.Duration,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectory({ directory: root, prefix: "turn-" });
    const files = {
      out: join(directory, "stdout"),
      err: join(directory, "stderr"),
      code: join(directory, "exit-code"),
    };
    const sandboxedInvocation = sandboxed(outliving(invocation, files), root, extension);
    const child = yield* ChildProcess.make(sandboxedInvocation.command, sandboxedInvocation.args, {
      cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
      env: { ...hostEnvironment, ...invocation.env },
      extendEnv: false,
    });
    const read = (file: string) =>
      Effect.tryPromise(() =>
        readAttemptFile(root, file).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }),
      );
    const exitCode = Effect.gen(function* () {
      let code = yield* read(files.code);
      while (code === undefined) {
        yield* Effect.sleep(Duration.millis(100));
        code = yield* read(files.code);
      }
      return code.trim();
    });
    // The sandbox ending first, e.g. when bubblewrap fails, ends the turn unfinished.
    const sandboxEnded = child.exitCode.pipe(
      Effect.as("sandbox"),
      Effect.orElseSucceed(() => "sandbox"),
    );
    const exit = yield* Effect.raceFirst(exitCode, sandboxEnded).pipe(Effect.timeoutOption(budget));
    const status = Option.getOrUndefined(exit);
    if (status === undefined) {
      yield* child.kill({ killSignal: "SIGKILL" });
    }
    let failure: string | undefined;
    if (status === undefined) failure = "Agent turn exceeded its time budget";
    else if (status === "sandbox") failure = "Sandbox exited before the agent returned";
    else if (status !== "0") failure = `Agent exited with status ${status}`;
    const stderr = (yield* read(files.err)) ?? "";
    if (failure && stderr.trim()) failure += `\n${stderr.trim()}`;
    return {
      failure,
      stdout: (yield* read(files.out)) ?? "",
      stderr,
    };
  });

/** Removes the selected provider's key from agent-produced text. */
type Redact = (text: string) => string;

function redactTranscript(raw: string, redact: Redact) {
  return raw
    .split("\n")
    .map((line) => {
      const redacted = redact(line);
      if (redacted === line) return line;
      try {
        return JSON.stringify(JSON.parse(line), (_key, value: unknown) => {
          if (typeof value === "string") return redact(value);
          if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
          return Object.fromEntries(
            Object.entries(value).map(([key, field]) => [redact(key), field]),
          );
        });
      } catch {
        return redacted;
      }
    })
    .join("\n");
}

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
      const home = join(root, "home");
      for (const directory of [workdir, home]) {
        yield* fs.makeDirectory(directory, { mode: 0o700 });
      }
      yield* agent.prepare(home);
      for (const [name, content] of Object.entries(testCase.files)) {
        yield* fs.makeDirectory(dirname(join(workdir, name)), { recursive: true });
        yield* fs.writeFileString(join(workdir, name), content);
      }
      const port = yield* freePort;
      if (testCase.prepare) {
        const script = testCase.prepare;
        yield* Effect.try({
          try: () => execFileSync("python3", ["-c", script], { cwd: workdir }),
          catch: (error) =>
            new Error(`Could not prepare the ${testCase.name} fixture. ${String(error)}`),
        });
      }

      const started = performance.now();
      const turn = yield* invoke(
        agent.start(home, workdir, testCase.prompt(port)),
        root,
        extension,
        workdir,
        Duration.seconds(testCase.budgetSeconds),
      );
      const wallSeconds = (performance.now() - started) / 1000;

      const name = `${testCase.name}-${index}`;
      const { observe } = testCase;
      const observation = observe && (yield* Effect.promise(() => observe(port)));
      const result: Result = {
        case: testCase.name,
        attempt: index,
        metrics: { wall_seconds: Math.round(wallSeconds) },
        transcript: "",
        ...(observation ? { observation } : {}),
        ...(turn.failure ? { turn_error: redact(turn.failure) } : {}),
      };
      const sessionFile = yield* Effect.gen(function* () {
        const file = yield* Effect.tryPromise(() => onlyTranscript(home, join(home, "sessions")));
        const raw = yield* Effect.tryPromise(() => readAttemptFile(home, file));
        const saved = `${name}.jsonl`;
        yield* fs.writeFileString(join(out, saved), redactTranscript(raw, redact));
        result.transcript = saved;
        const summary = yield* agent.decodeTranscript(raw);
        result.metrics = metrics(summary.calls, wallSeconds);
        if (summary.failure) {
          result.turn_error = redact([turn.failure, summary.failure].filter(Boolean).join("\n"));
        }
        return file;
      }).pipe(
        Effect.catch((error) => {
          const phase = result.transcript ? "decode" : "save";
          const detail = `Could not ${phase} the transcript. ${String(error)}`;
          result.turn_error = redact(
            [turn.failure ?? turn.stderr.trim(), detail].filter(Boolean).join("\n"),
          );
          return Effect.succeed(undefined);
        }),
      );
      if (!options.debrief || sessionFile === undefined) return result;

      const debrief = Effect.gen(function* () {
        const invocation = agent.debrief(home, sessionFile, DEBRIEF_PROMPT);
        const reply = yield* invoke(invocation, root, extension, workdir, DEBRIEF_BUDGET);
        const stderr = reply.stderr.trim();
        if (reply.failure) return yield* Effect.fail(new Error(reply.failure));

        const answerFile = invocation.answerFile;
        const answer = answerFile
          ? yield* Effect.tryPromise(() => readAttemptFile(root, answerFile))
          : reply.stdout;
        const text = answer.trim();
        if (!text)
          return yield* Effect.fail(new Error(stderr || "Agent returned an empty debrief"));
        return text;
      }).pipe(Effect.scoped);
      return yield* debrief.pipe(
        Effect.map((text): Result => ({ ...result, debrief: redact(text) })),
        Effect.catch((error) =>
          Effect.succeed({ ...result, debrief_error: redact(String(error)) }),
        ),
      );
    }),
  );
}

function summarize(results: Result[]): string {
  const lines = [];
  for (const result of results) {
    const detail = [result.observation, result.turn_error].filter(Boolean).join(". ");
    const { wall_seconds, tool_calls, slowest_call_seconds } = result.metrics;
    let stats = wall_seconds === undefined ? "" : ` ${wall_seconds} s`;
    if (tool_calls !== undefined)
      stats += `, ${tool_calls} calls, slowest ${slowest_call_seconds} s`;
    lines.push(
      `${result.turn_error ? "ERROR" : "FINISHED"} ${result.case}#${result.attempt}${stats}${detail ? ` — ${detail}` : ""}`,
    );
  }
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
  const auth = resolve(options.auth);
  const agentOptions = {
    provider: options.provider,
    model: options.model,
    thinking: options.thinking,
    key: yield* Effect.promise(() =>
      providerKey(auth, options.provider, join(modelsCache, "models.json")),
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
  const probeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "async-bash-eval-probe-" });
  const version = sandboxed(agent.version, probeDirectory, extension);
  yield* Effect.try({
    try: () =>
      execFileSync(version.command, version.args, {
        cwd: probeDirectory,
        env: hostEnvironment,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    catch: (cause) =>
      new Error(`${options.agent} cannot start inside bubblewrap: ${String(cause)}`),
  });

  const chosen = selected.length ? cases.filter((item) => selected.includes(item.name)) : cases;
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const out = resolve(options.out ?? join(repository, ".eval/async-bash", stamp));
  yield* fs.makeDirectory(out, { recursive: true });
  const redact: Redact = (text) => text.replaceAll(agentOptions.key, "[API key]");
  const attempts = chosen.flatMap((testCase) =>
    Array.from({ length: repetitions }, (_, index) => ({ testCase, index: index + 1 })),
  );
  const results = yield* Effect.forEach(
    attempts,
    ({ testCase, index }) =>
      attempt(agent, testCase, index, out, extension, redact).pipe(
        // One attempt's failure, e.g. an agent that left no transcript, leaves the others to run.
        Effect.catch((error) =>
          Effect.succeed<Result>({
            case: testCase.name,
            attempt: index,
            turn_error: redact(String(error)),
            metrics: {},
            transcript: "",
          }),
        ),
        Effect.tap((result) =>
          Effect.sync(() => console.error(summarize([result]).split("\n")[0] ?? "")),
        ),
      ),
    { concurrency: 1 },
  );
  const { key: _key, ...recorded } = { ...agentOptions, extension: built };
  const report = { agent: options.agent, ...recorded, results };
  yield* fs.writeFileString(join(out, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  yield* Effect.sync(() => console.log(`${summarize(results)}\nResults: ${out}`));
});

NodeRuntime.runMain(main.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
