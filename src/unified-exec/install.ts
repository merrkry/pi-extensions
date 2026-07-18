import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Type } from "typebox";

import { loadPty } from "./child.js";
import { manageProcesses, renderAgentInventory } from "./management.js";
import {
  errorMessage,
  InvalidInputError,
  type StdinWriteError,
  type UnifiedExecError,
} from "./errors.js";
import {
  clampYield,
  EARLY_EXIT_GRACE_PERIOD_MS,
  type ExecCommandArgs,
  finalizeResponse,
  MAX_YIELD_TIME_MS,
  MIN_YIELD_TIME_MS,
  normalizeSignal,
  renderResponseText,
  resolveMaxEmptyPollMs,
  resolveWriteInput,
  type ResponseShape,
  type WriteStdinArgs,
} from "./protocol.js";
import { renderExecCommandCall, renderResult, renderWriteStdinCall } from "./render.js";
import { type ExecSession, type StreamUpdate } from "./session.js";
import { UnifiedExec, type UnifiedExecApi } from "./service.js";
import {
  buildShellCommand,
  IS_WINDOWS,
  resolveDefaultShell,
  resolveWindowsShell,
} from "./shell.js";

function runEffect<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
  return Effect.runPromise(effect, signal ? { signal } : {});
}

function toBoundaryError(error: UnifiedExecError): Error {
  return new Error(errorMessage(error), { cause: error });
}

export default function installUnifiedExec(
  pi: ExtensionAPI,
): Effect.Effect<void, never, UnifiedExec> {
  return Effect.gen(function* () {
    const manager = yield* UnifiedExec;

    // Warm the optional native module once. Pipe mode remains available on failure.
    yield* loadPty.pipe(Effect.catch(() => Effect.void));

    pi.registerFlag("keep-builtin-bash", {
      description:
        "Keep Pi's built-in `bash` tool alongside exec_command/write_stdin. By default it is removed.",
      type: "boolean",
      default: false,
    });

    let pendingAgentInventory: string | undefined;

    pi.on("session_start", async () => {
      await runEffect(manager.resume);
      if (pi.getFlag("keep-builtin-bash") !== true) {
        pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "bash"));
      }
    });

    pi.on("before_agent_start", async () => {
      pendingAgentInventory = renderAgentInventory(await runEffect(manager.agentInventory));
    });

    pi.on("context", (event) => {
      const inventory = pendingAgentInventory;
      pendingAgentInventory = undefined;
      if (!inventory) return;
      return {
        messages: [
          ...event.messages,
          {
            role: "custom" as const,
            customType: "unified-exec-inventory",
            content: inventory,
            display: false,
            timestamp: Date.now(),
          },
        ],
      };
    });

    pi.on("session_shutdown", async () => {
      pendingAgentInventory = undefined;
      await runEffect(manager.shutdown);
    });

    pi.registerCommand("processes", {
      description: "Inspect and manage Unified Exec background processes",
      handler: async (_arguments, context) => manageProcesses(manager, context),
    });

    pi.registerTool({
      name: "exec_command",
      label: "exec_command",
      description:
        "Run a command in an owned persistent session. Returns session_id if still running or exit_code if it finishes before yielding.",
      promptSnippet: "Run a shell command; long-running ones yield a session_id",
      promptGuidelines: [
        "Normally omit yield_time_ms and keep the 5s default. Use 1s only for interactive commands.",
        "For long-running non-interactive commands, use one empty write_stdin poll of 5 minutes or longer.",
      ],
      executionMode: "parallel",
      parameters: Type.Object({
        cmd: Type.String({ description: "Shell command to execute." }),
        workdir: Type.Optional(
          Type.String({ description: "Working directory. Defaults to the session cwd." }),
        ),
        shell: Type.Optional(
          Type.String({
            description:
              "Shell binary. Defaults to bash (on Windows: bash if available, else powershell).",
          }),
        ),
        tty: Type.Optional(
          Type.Boolean({ description: "Allocate a PTY. Default false.", default: false }),
        ),
        yield_time_ms: Type.Optional(
          Type.Number({
            description: `Wait before yielding, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}] ms.`,
          }),
        ),
      }),
      async execute(_toolCallId, parameters, signal, onUpdate, context) {
        const response = await runEffect(
          runExecCommand(manager, parameters, context.cwd, onUpdate).pipe(
            Effect.mapError(toBoundaryError),
          ),
          signal,
        );
        return {
          content: [{ type: "text", text: renderResponseText(response) }],
          details: response,
        };
      },
      renderCall: renderExecCommandCall,
      renderResult,
    });

    pi.registerTool({
      name: "write_stdin",
      label: "write_stdin",
      description:
        "Write bytes to a running session, or omit chars/chars_b64 to poll. chars supports C-style escapes; chars_b64 is binary-safe.",
      promptSnippet: "Send input to or poll a running session",
      promptGuidelines: [
        "Normally omit yield_time_ms and keep the 5s default. Use 1s only for interactive sessions.",
        "For long-running non-interactive jobs, use one empty poll of 5 minutes or longer.",
        "In tty sessions, submit lines with \\r rather than \\n for portable Enter behavior.",
      ],
      executionMode: "parallel",
      parameters: Type.Object({
        session_id: Type.Number({ description: "Session id from exec_command." }),
        chars: Type.Optional(
          Type.String({
            description:
              "Text with C-style escapes: \\xHH, \\uHHHH, \\u{H…}, \\n, \\r, and \\t. Mutually exclusive with chars_b64.",
          }),
        ),
        chars_b64: Type.Optional(
          Type.String({ description: "Base64 bytes. Mutually exclusive with chars." }),
        ),
        yield_time_ms: Type.Optional(
          Type.Number({
            description: `Wait before yielding, clamped to [${MIN_YIELD_TIME_MS}, ${resolveMaxEmptyPollMs()}] ms.`,
          }),
        ),
      }),
      async execute(_toolCallId, parameters, signal, onUpdate) {
        const response = await runEffect(
          runWriteStdin(manager, parameters, onUpdate).pipe(Effect.mapError(toBoundaryError)),
          signal,
        );
        return {
          content: [{ type: "text", text: renderResponseText(response) }],
          details: response,
        };
      },
      renderCall: renderWriteStdinCall,
      renderResult,
    });

    pi.registerTool({
      name: "kill_session",
      label: "kill_session",
      description:
        "Terminate a session. The requested signal escalates to SIGKILL after 2s; Windows force-kills the process tree.",
      promptSnippet: "Terminate a session",
      executionMode: "parallel",
      parameters: Type.Object({
        session_id: Type.Number({ description: "Session to terminate." }),
        signal: Type.Optional(Type.String({ description: "Initial signal. Default SIGTERM." })),
      }),
      async execute(_toolCallId, parameters, signal) {
        const outcome = await runEffect(
          Effect.gen(function* () {
            const initial = yield* normalizeSignal(parameters.signal);
            return yield* manager.terminate(parameters.session_id, initial);
          }).pipe(Effect.mapError(toBoundaryError)),
          signal,
        );
        const output = new TextDecoder().decode(outcome.finalOutput);
        return {
          content: [
            {
              type: "text",
              text: `Killed session ${outcome.session.id}${
                outcome.escalated ? " — escalated to SIGKILL" : ""
              }\nlog_path: ${outcome.session.logPath}\n---\n${output || "(no output)"}`,
            },
          ],
          details: {
            session_id: outcome.session.id,
            exit_code: outcome.session.exitCode,
            signal: outcome.session.signal,
            escalated: outcome.escalated,
            log_path: outcome.session.logPath,
            final_output: output,
          },
        };
      },
    });

    pi.registerTool({
      name: "list_sessions",
      label: "list_sessions",
      description: "List live sessions and retained exited-session tombstones.",
      promptSnippet: "List live sessions and exited tombstones",
      executionMode: "parallel",
      parameters: Type.Object({}),
      async execute(_toolCallId, _parameters, signal) {
        const all = await runEffect(manager.list(), signal);
        const now = Date.now();
        const sessions = all.map((session) => sessionSummary(session, now));
        const lines = sessions.length
          ? sessions.map(
              (session) =>
                `${session.session_id}: ${session.running ? "running" : "exited"} pid=${session.pid ?? "?"} ${
                  session.tty ? "tty" : "pipe"
                } cwd=${session.cwd}\n  ${session.command}\n  log: ${session.log_path}`,
            )
          : ["(no sessions)"];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            sessions,
            active_count: sessions.filter((session) => session.running).length,
          },
        };
      },
    });
  });
}

function runExecCommand(
  manager: UnifiedExecApi,
  arguments_: ExecCommandArgs,
  defaultCwd: string,
  onUpdate: AgentToolUpdateCallback<ResponseShape> | undefined,
): Effect.Effect<ResponseShape, UnifiedExecError> {
  return Effect.gen(function* () {
    const startedAt = Date.now();
    const tty = arguments_.tty ?? false;
    let shell = arguments_.shell;
    if (!shell) {
      shell = resolveDefaultShell().shell;
    } else if (IS_WINDOWS) {
      const requestedShell = shell;
      shell = yield* Effect.try({
        try: () => resolveWindowsShell(requestedShell),
        catch: (cause) =>
          new InvalidInputError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
    }
    const shellCommand = yield* Effect.try({
      try: () => buildShellCommand(shell, arguments_.cmd),
      catch: (cause) =>
        new InvalidInputError({ message: cause instanceof Error ? cause.message : String(cause) }),
    });
    const cwd = arguments_.workdir?.trim() || defaultCwd;
    const yieldTimeMs = clampYield(arguments_.yield_time_ms);
    const { session } = yield* manager.launch({
      command: shellCommand.command,
      cwd,
      env: process.env,
      tty,
      displayCommand: arguments_.cmd,
      ...(shellCommand.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: shellCommand.windowsVerbatimArguments }),
    });

    const exitedEarly = yield* session.awaitExit(EARLY_EXIT_GRACE_PERIOD_MS);
    if (exitedEarly) {
      const collected = yield* session.operationSemaphore.withPermit(
        session.collectUntil(Date.now() + 500),
      );
      yield* manager.remove(session.id);
      return finalizeForSession(session, startedAt, collected, undefined, yieldTimeMs);
    }

    const deadline = startedAt + yieldTimeMs;
    const collected = yield* withStreaming(session, deadline, onUpdate, session.poll(deadline));
    if (session.hasExited) {
      yield* manager.remove(session.id);
      return finalizeForSession(session, startedAt, collected, undefined, yieldTimeMs);
    }
    return finalizeForSession(session, startedAt, collected, session.id, yieldTimeMs);
  });
}

function runWriteStdin(
  manager: UnifiedExecApi,
  arguments_: WriteStdinArgs,
  onUpdate: AgentToolUpdateCallback<ResponseShape> | undefined,
): Effect.Effect<ResponseShape, UnifiedExecError> {
  return Effect.gen(function* () {
    const startedAt = Date.now();
    const session = yield* manager.get(arguments_.session_id);
    const input = yield* resolveWriteInput(arguments_);
    const maximum = input && input.length > 0 ? MAX_YIELD_TIME_MS : resolveMaxEmptyPollMs();
    const yieldTimeMs = clampYield(arguments_.yield_time_ms, maximum);
    const deadline = startedAt + yieldTimeMs;
    let failure: string | undefined;
    const collected = yield* withStreaming(
      session,
      deadline,
      onUpdate,
      session.poll(deadline, input),
    ).pipe(
      Effect.catchTag("StdinWriteError", (error: StdinWriteError) => {
        failure = error.message;
        return session.operationSemaphore.withPermit(session.collectUntil(Date.now() + 50));
      }),
    );
    if (session.hasExited) {
      return finalizeForSession(
        session,
        startedAt,
        collected,
        undefined,
        yieldTimeMs,
        session.failureMessage ?? failure,
      );
    }
    return finalizeForSession(session, startedAt, collected, session.id, yieldTimeMs, failure);
  });
}

function withStreaming<E>(
  session: ExecSession,
  deadline: number,
  onUpdate: AgentToolUpdateCallback<ResponseShape> | undefined,
  operation: Effect.Effect<Uint8Array, E>,
): Effect.Effect<Uint8Array, E> {
  if (!onUpdate) return operation;
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        session.streamUpdates(deadline, (update) => {
          onUpdate({
            content: [{ type: "text", text: update.output }],
            details: streamResponse(update, session.startedAt),
          });
        }),
      );
      const remaining = Math.max(1, deadline - Date.now());
      const result = yield* operation.pipe(Effect.timeoutOption(remaining));
      return Option.getOrElse(result, () => new Uint8Array());
    }),
  );
}

function streamResponse(update: StreamUpdate, startedAt: number): ResponseShape {
  return {
    chunk_id: "stream",
    wall_time_seconds: (Date.now() - startedAt) / 1000,
    output: update.output,
    original_token_count: Math.ceil(update.total_bytes / 4),
    tty: update.tty,
    session_id: update.session_id,
    log_path: update.log_path,
    cwd: update.cwd,
    command: update.command,
  };
}

function finalizeForSession(
  session: ExecSession,
  startedAt: number,
  collected: Uint8Array,
  sessionId: number | undefined,
  yieldTimeMs: number,
  failure = session.failureMessage,
): ResponseShape {
  return finalizeResponse({
    startedAt,
    collected,
    ...(sessionId === undefined ? {} : { sessionId }),
    exitCode: session.exitCode,
    signal: session.signal,
    failure,
    tty: session.tty,
    logPath: session.logPath,
    cwd: session.cwd,
    command: session.displayCommand,
    yieldTimeMs,
  });
}

function sessionSummary(session: ExecSession, now: number) {
  return {
    session_id: session.id,
    command: session.displayCommand,
    cwd: session.cwd,
    tty: session.tty,
    pid: session.pid,
    started_at_ms: session.startedAt,
    ended_at_ms: session.endedAt,
    elapsed_ms: (session.endedAt ?? now) - session.startedAt,
    running: !session.hasExited,
    exit_code: session.exitCode,
    signal: session.signal,
    failure_message: session.failureMessage,
    output_bytes_total: session.totalBytesSeen,
    log_path: session.logPath,
  };
}
