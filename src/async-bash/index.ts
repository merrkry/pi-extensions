import {
  createBashToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  getAgentDir,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Exit } from "effect";
import { delimiter, join } from "node:path";
import { Type, type Static } from "typebox";
import {
  MAX_REPORTED_SESSIONS,
  makeProcesses,
  TERMINATION_GRACE_MS,
  type ProcessResult,
  type Processes,
  type TaskSummary,
} from "./processes.ts";

// One default for bash, poll and write: waits end as soon as the command finishes, and callers
// that do not need the result pass 0.
const DEFAULT_WAIT_MS = 5_000;
/**
 * Caps how long one call holds control. Models size waits as if they were time limits, so a hung
 * command could otherwise block for as long as they guessed. The first wait is shorter: a call
 * returning while the command runs is when a hang can still be noticed cheaply.
 */
const MAX_BASH_WAIT_MS = 30_000;
const MAX_PROCESS_WAIT_MS = 300_000;
// Node and Bun timers cap delays at the largest signed 32-bit integer.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// Runs without output this long are worth pointing out; shorter pauses are ordinary.
const NOTABLE_IDLE_SECONDS = 10;
const PAGE_LIMIT = `${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB`;
const MAX_LISTED_COMMAND_CHARS = 200;

/** Waits above the cap are shortened rather than rejected, so an oversized wait costs no turn. */
function waitTime(value: number | undefined, max: number): number {
  const duration = value ?? DEFAULT_WAIT_MS;
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error("yield_time_ms must be a finite, non-negative number of milliseconds");
  }
  return Math.min(duration, max);
}

function timeLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`timeout_ms must be a number between 1 and ${MAX_TIMER_DELAY_MS}`);
  }
  return value;
}

async function run<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  const error = Cause.squash(exit.cause);
  if (Cause.isUnknownError(error)) throw error.cause;
  throw error;
}

type Observation = Omit<ProcessResult, "session_id" | "full_output_path"> &
  Partial<Pick<ProcessResult, "session_id" | "full_output_path">>;

type Status = Pick<
  TaskSummary,
  "state" | "exit_code" | "signal" | "stdin" | "stopped_by" | "runtime_seconds" | "idle_seconds"
>;

function stopNote(value: Pick<TaskSummary, "stopped_by" | "runtime_seconds">): string {
  if (value.stopped_by === "kill") return "stopped by process kill, ";
  if (value.stopped_by === "timeout") {
    return `stopped by timeout_ms after ${value.runtime_seconds} s, `;
  }
  return "";
}

function status(value: Status): string {
  const code = `code ${value.exit_code}${value.signal ? ` (${value.signal})` : ""}`;
  const runtime = `${value.runtime_seconds} s`;
  switch (value.state) {
    case "running": {
      const notes = [`running for ${runtime}`];
      if (value.idle_seconds >= NOTABLE_IDLE_SECONDS) {
        notes.push(`no output for ${value.idle_seconds} s`);
      }
      if (value.stdin === "closed") notes.push("stdin closed");
      return notes.join(", ");
    }
    case "draining":
      return `${stopNote(value)}shell exited with ${code} after ${runtime}; processes it started in the background still run (poll waits for them, kill stops them)`;
    case "exited":
      return `${stopNote(value)}exited with ${code} after ${runtime}`;
    case "failed":
      return "failed to start";
  }
}

/** A requested kill is the outcome the model asked for, not a failure. */
function failed(value: Observation): boolean {
  if (value.error || value.input_error || value.input_refused) return true;
  return Boolean(value.exit_code) && value.stopped_by !== "kill";
}

function firstLine(command: string): string {
  const [line = ""] = command.split("\n", 1);
  const shortened = line.length > MAX_LISTED_COMMAND_CHARS;
  const more = shortened || line.length < command.length;
  return `${line.slice(0, MAX_LISTED_COMMAND_CHARS)}${more ? " …" : ""}`;
}

function inputNotes(value: Pick<ProcessResult, "input_error" | "input_refused">): string[] {
  const notes = [];
  if (value.input_refused) notes.push(`Input not written: ${value.input_refused}.`);
  if (value.input_error) {
    notes.push(
      `Stdin failed after accepting input; the command may have read part of it: ${value.input_error}.`,
    );
  }
  return notes;
}

/** Renders output first, followed by the facts needed to continue from it. */
function render(value: Observation, cursor: number, startedAt: number) {
  const output = value.output || (cursor ? `(no output after byte ${cursor})` : "(no output)");
  const notes = [];
  if (value.error) notes.push(value.error);
  notes.push(...inputNotes(value));
  if (value.session_id === undefined) {
    if (value.stopped_by === "timeout") {
      notes.push(`Command stopped by timeout_ms after ${value.runtime_seconds} s`);
    } else if (value.exit_code) {
      notes.push(`Command exited with code ${value.exit_code}`);
    }
  } else {
    const range = `bytes ${value.output_start_bytes}-${value.cursor_bytes} of ${value.total_bytes}`;
    let next = "";
    if (value.output_start_bytes > cursor) {
      next = ` Bytes ${cursor}-${value.output_start_bytes} omitted; page them with process read or open ${value.full_output_path}.`;
    } else if (value.cursor_bytes < value.total_bytes) {
      next = ` Continue with process read cursor_bytes=${value.cursor_bytes}.`;
    } else if (value.state === "running" || value.state === "draining") {
      next = " Poll for new output.";
    }
    notes.push(`[Session ${value.session_id} ${status(value)}; ${range}.${next}]`);
  }
  const text = notes.length
    ? `${output}${output.endsWith("\n") ? "" : "\n"}\n${notes.join("\n")}`
    : output;
  return {
    content: [{ type: "text" as const, text }],
    details: undefined,
    structuredContent: {
      ...value,
      wall_time_seconds: (performance.now() - startedAt) / 1000,
    },
    ...(failed(value) ? { isError: true } : {}),
  };
}

/**
 * Returns a session's result to the model. Acknowledging here, and nowhere else, keeps the status
 * reminder accurate: streaming updates and cancelled calls render without reaching this point.
 */
async function reply(manager: Processes, value: ProcessResult, cursor: number, startedAt: number) {
  await run(manager.acknowledge(value));
  return render(value, cursor, startedAt);
}

const state = Type.Union(
  [
    Type.Literal("running"),
    Type.Literal("draining"),
    Type.Literal("exited"),
    Type.Literal("failed"),
  ],
  {
    description:
      "Observed when the call returned. draining: the shell has exited, but processes it started in the background are still running or output can still arrive. exited and failed are final, and output up to total_bytes is complete.",
  },
);

const summaryFields = {
  session_id: Type.String({ description: "Session identifier for the process tool." }),
  state,
  command: Type.String(),
  cwd: Type.String(),
  pid: Type.Optional(Type.Number()),
  exit_code: Type.Optional(Type.Number({ description: "Shell exit code, once it has exited." })),
  signal: Type.Optional(Type.String()),
  error: Type.Optional(Type.String({ description: "Launch or output capture failure." })),
  input_error: Type.Optional(
    Type.String({
      description:
        "Stdin failed after accepting input, and the command may have read part of it. Results report it until one returns it, also after the write call has returned.",
    }),
  ),
  stopped_by: Type.Optional(
    Type.Union([Type.Literal("kill"), Type.Literal("timeout")], {
      description: "Set once process kill or timeout_ms started stopping the process group.",
    }),
  ),
  stdin: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  total_bytes: Type.Number({ description: "UTF-8 bytes of combined output logged so far." }),
  runtime_seconds: Type.Number({ description: "Since the command started, until it finished." }),
  idle_seconds: Type.Number({
    description: "Since the last output, or since the start when there was none.",
  }),
  full_output_path: Type.String({
    description: "Log of the combined output, removed at session shutdown.",
  }),
};

const processOutput = Type.Object({
  ...summaryFields,
  input_refused: Type.Optional(
    Type.String({ description: "write: why this call wrote no input." }),
  ),
  output: Type.String({
    description: "Combined stdout and stderr in bytes [output_start_bytes, cursor_bytes).",
  }),
  output_start_bytes: Type.Number({
    description:
      "Above the requested cursor when earlier bytes were omitted; up to 3 bytes below it when the cursor pointed inside a character.",
  }),
  cursor_bytes: Type.Number({ description: "Pass as cursor_bytes to continue after output." }),
  wall_time_seconds: Type.Number({ description: "Time spent in this call, in seconds." }),
});

const bashOutput = Type.Object({
  ...processOutput.properties,
  session_id: Type.Optional(
    Type.String({
      description:
        "Absent when the command finished with its whole output returned; no session is kept.",
    }),
  ),
  full_output_path: Type.Optional(summaryFields.full_output_path),
});

const cursorParameter = Type.Optional(
  Type.Integer({
    minimum: 0,
    description:
      "UTF-8 byte offset to return output from. poll, write, and kill default to the end of the output earlier results showed; read defaults to 0. Pass 0 to see all output again.",
  }),
);

const processParameters = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("poll"),
    Type.Literal("write"),
    Type.Literal("read"),
    Type.Literal("kill"),
  ]),
  session_id: Type.Optional(Type.String({ description: "Required except for list." })),
  cursor_bytes: cursorParameter,
  yield_time_ms: Type.Optional(
    Type.Number({
      minimum: 0,
      description: `poll and write: wait up to this long for the command to finish; it keeps running afterwards. Defaults to ${DEFAULT_WAIT_MS} ms, at most ${MAX_PROCESS_WAIT_MS} ms; 0 returns immediately.`,
    }),
  ),
  chars: Type.Optional(Type.String({ description: "write: text for stdin, including newlines." })),
  eof: Type.Optional(
    Type.Boolean({ description: "write: close stdin after chars. Cannot be reopened." }),
  ),
});

type ProcessParameters = Static<typeof processParameters>;

const actionParameters: Record<ProcessParameters["action"], readonly string[]> = {
  list: [],
  poll: ["session_id", "cursor_bytes", "yield_time_ms"],
  write: ["session_id", "cursor_bytes", "yield_time_ms", "chars", "eof"],
  read: ["session_id", "cursor_bytes"],
  kill: ["session_id", "cursor_bytes"],
};

function environment(ctx: ExtensionToolContext): NodeJS.ProcessEnv {
  // Match Pi's bash, which puts its managed tools such as rg and fd on PATH.
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const path = process.env[pathKey] ?? "";
  const bin = join(getAgentDir(), "bin");
  return {
    ...process.env,
    [pathKey]: path.split(delimiter).includes(bin)
      ? path
      : [bin, path].filter(Boolean).join(delimiter),
    PI_SESSION_ID: ctx.sessionManager.getSessionId(),
    PI_SESSION_FILE: ctx.sessionManager.getSessionFile(),
    PI_PROVIDER: ctx.model?.provider,
    PI_MODEL: ctx.model?.id,
    PI_REASONING_LEVEL: ctx.thinkingLevel,
  };
}

export default function (pi: ExtensionAPI): void {
  let runtime: Promise<Processes> | undefined;
  const processes = () => (runtime ??= run(makeProcesses));
  const piBash = createBashToolDefinition(process.cwd());

  pi.on("session_shutdown", async () => {
    if (runtime) await run((await runtime).shutdown);
    runtime = undefined;
  });

  // Background work is surfaced on the model's next request; a command finishing after the final
  // response starts no new turn.
  pi.on("context", async (event) => {
    if (!runtime) return;
    const { running, unreported } = await run((await runtime).pending);
    const parts = [];
    if (running.length) parts.push(`running: ${running.join(", ")}`);
    if (unreported.length) parts.push(`finished since last checked: ${unreported.join(", ")}`);
    if (!parts.length) return;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom" as const,
          customType: "async-bash-status",
          content: `Bash sessions ${parts.join("; ")}.`,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: `Execute a bash command in the current working directory. Returns stdout and stderr, limited to the last ${PAGE_LIMIT}. A command still running after yield_time_ms continues in a session; the result then names the session for the process tool, as it does when output was omitted. timeout_ms stops the command once it has run that long.`,
    ...(piBash.promptSnippet ? { promptSnippet: piBash.promptSnippet } : {}),
    promptGuidelines: [
      ...(piBash.promptGuidelines ?? []),
      "Before finishing, account for bash sessions: collect needed results, wait or stop as appropriate, and report anything intentionally left running.",
      `yield_time_ms only sets how long a call waits before returning; the command keeps running in its session. The call returns as soon as the command finishes, so set it near the expected runtime. bash waits at most ${MAX_BASH_WAIT_MS / 1000} s and process at most ${MAX_PROCESS_WAIT_MS / 1000} s per call.`,
      `To limit how long a command may run, set timeout_ms instead of using the timeout utility: it stops the whole process group, escalating from TERM to KILL after ${TERMINATION_GRACE_MS / 1000} s.`,
      "To watch a long-running program, start it with a short yield_time_ms, poll its session, and stop it with process kill. The session keeps all output and poll shows it as it arrives, so do not pipe long commands through tail or redirect their output to a file just to follow it.",
      "Tool calls in one response run concurrently and return together: put dependent steps in one command, and keep yield_time_ms short for calls batched with others.",
      "A command's session stays draining while processes it started in its process group run, and Pi stops them when its session ends. Start a process that must outlive Pi, such as a server, with `setsid -f` and redirected output; it is then neither tracked nor stopped.",
      "pkill -f and pgrep -f patterns also match the bash command line that contains them; match a pid file or the exact process name instead.",
      "Output reads never consume output. poll, write, and kill continue after the output earlier results showed; pass cursor_bytes=0 to see it again.",
      `Only the ${MAX_REPORTED_SESSIONS} finished sessions whose final state was returned most recently keep their logs; save output needed later instead of relying on older sessions.`,
      "Use a terminal multiplexer for programs that require terminal features.",
    ],
    parameters: Type.Object({
      command: piBash.parameters.properties.command,
      yield_time_ms: Type.Optional(
        Type.Number({
          minimum: 0,
          description: `Wait up to this long for the command to finish; it keeps running afterwards. Defaults to ${DEFAULT_WAIT_MS} ms, at most ${MAX_BASH_WAIT_MS} ms; 0 returns immediately.`,
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          exclusiveMinimum: 0,
          maximum: MAX_TIMER_DELAY_MS,
          description:
            "Stop the command and its process group once it has run this long, also after this call has returned. No limit by default.",
        }),
      ),
    }),
    outputSchema: bashOutput,
    ...(piBash.constrainedSampling ? { constrainedSampling: piBash.constrainedSampling } : {}),
    ...(piBash.renderCall ? { renderCall: piBash.renderCall } : {}),
    ...(piBash.renderResult ? { renderResult: piBash.renderResult } : {}),
    async execute(_id, params, signal, onUpdate, ctx) {
      const startedAt = performance.now();
      const wait = waitTime(params.yield_time_ms, MAX_BASH_WAIT_MS);
      const timeoutMs = timeLimit(params.timeout_ms);
      if (!params.command.trim()) throw new Error("command must not be empty");
      if (signal?.aborted) throw new Error("Bash call aborted");
      const manager = await processes();
      const { shellPath, shellCommandPrefix } = pi.getSettings();
      const value = await run(
        Effect.acquireUseRelease(
          manager.start({
            command: params.command,
            cwd: ctx.cwd,
            env: environment(ctx),
            ...(shellPath ? { shellPath } : {}),
            ...(shellCommandPrefix ? { shellCommandPrefix } : {}),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          }),
          (task) =>
            manager.poll(
              task.id,
              wait,
              0,
              onUpdate ? (update) => onUpdate(render(update, 0, startedAt)) : undefined,
            ),
          (task, exit) =>
            Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
              ? manager.kill(task.id, 0).pipe(Effect.ignore)
              : Effect.void,
        ),
        signal,
      );
      if (
        (value.state === "exited" || value.state === "failed") &&
        value.output_start_bytes === 0
      ) {
        await run(manager.discard(value.session_id));
        const { session_id: _id, full_output_path: _path, ...complete } = value;
        return render(complete, 0, startedAt);
      }
      return reply(manager, value, 0, startedAt);
    },
  });

  pi.registerTool({
    name: "process",
    label: "process",
    description: `Manage bash sessions. poll: wait for the command to finish, then return the latest output after cursor_bytes. write: send stdin, then wait like poll. read: return output forward from cursor_bytes, one page of ${PAGE_LIMIT}, to recover omitted output. kill: stop the process tree and return its final output. list: show all sessions. Sessions remain until Pi's session ends, except that only the ${MAX_REPORTED_SESSIONS} finished sessions whose final state was returned most recently are kept.`,
    promptSnippet: "Wait for, read, write to, or stop bash sessions",
    parameters: processParameters,
    outputSchema: Type.Union([
      processOutput,
      Type.Object({ sessions: Type.Array(Type.Object(summaryFields)) }),
    ]),
    async execute(_id, params, signal, onUpdate) {
      const startedAt = performance.now();
      if (signal?.aborted) throw new Error("Process call aborted");
      for (const key of Object.keys(params)) {
        if (key !== "action" && !actionParameters[params.action].includes(key)) {
          throw new Error(`${key} is not supported for action ${params.action}`);
        }
      }
      const manager = await processes();
      if (params.action === "list") {
        const sessions = await run(manager.list, signal);
        await run(Effect.forEach(sessions, manager.acknowledge, { discard: true }));
        const text = sessions
          .map((task) =>
            [
              `${task.session_id}: ${status(task)}${task.error ? ` (${task.error})` : ""}, ${task.total_bytes} bytes`,
              ...inputNotes(task),
              firstLine(task.command),
            ].join("\n  "),
          )
          .join("\n");
        return {
          content: [{ type: "text", text: text || "No bash sessions." }],
          details: undefined,
          structuredContent: { sessions },
        };
      }
      const id = params.session_id;
      if (!id) throw new Error(`session_id is required for action ${params.action}`);
      const cursor =
        params.cursor_bytes ?? (params.action === "read" ? 0 : await run(manager.shownCursor(id)));
      const update = onUpdate
        ? (value: ProcessResult) => onUpdate(render(value, cursor, startedAt))
        : undefined;
      const effect = {
        poll: () =>
          manager.poll(id, waitTime(params.yield_time_ms, MAX_PROCESS_WAIT_MS), cursor, update),
        write: () =>
          manager.write(
            id,
            params.chars ?? "",
            params.eof ?? false,
            waitTime(params.yield_time_ms, MAX_PROCESS_WAIT_MS),
            cursor,
            update,
          ),
        read: () => manager.read(id, cursor),
        kill: () => manager.kill(id, cursor),
      }[params.action]();
      return reply(manager, await run(effect, signal), cursor, startedAt);
    },
  });
}
