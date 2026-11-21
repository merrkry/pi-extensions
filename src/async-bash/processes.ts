import { NodeFileSystem } from "@effect/platform-node";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { Deferred, Effect, Exit, FileSystem, Option, Scope } from "effect";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { Output, type Page } from "./output.ts";

// Match Pi's bash output cadence to keep streaming updates inexpensive.
const OUTPUT_UPDATE_INTERVAL_MS = 100;
const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_POLL_INTERVAL_MS = 100;
/**
 * Finished sessions kept once their final state has been returned; starting a command removes
 * those seen longest ago with their logs, even when the model never paged their omitted output. Retention is
 * bounded automatically rather than by a release action, so the model never manages lifetimes and
 * no call can leave a session half released. The prompt guidelines state the bound.
 */
export const MAX_REPORTED_SESSIONS = 64;
// Remembers removed ids so later calls can tell them from mistyped ones.
const MAX_REMOVED_IDS = 1024;
// Bounds input queued for a command that is not reading stdin.
const MAX_QUEUED_INPUT_BYTES = 1024 * 1024;
const EXIT_FAILURE = 1;
// Bash represents signal termination as 128 + the signal number.
const SHELL_SIGNAL_EXIT_BASE = 128;
/**
 * The command appends through the descriptors it inherits. A log it cannot open again keeps
 * redirections to /dev/stdout or /dev/stderr, which would truncate it, failing as they do on the
 * sockets of Pi's own bash. Privileged users bypass file modes.
 */
const LOG_MODE = 0o400;

type Outcome =
  | { state: "exited"; exit_code: number; signal?: NodeJS.Signals }
  | { state: "failed"; error: string };

/** A shell with a pipe for stdin; its stdout and stderr are the log. */
type Child = ChildProcess & { readonly stdin: Writable };

export interface Command {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  shellPath?: string;
  shellCommandPrefix?: string;
  /** Stops the command once it has run this long. */
  timeoutMs?: number;
}

export type TaskState = "running" | "exited" | "failed";

/** Why Pi stopped a command. */
export type StopReason = "kill" | "timeout";

export type TaskSummary = {
  session_id: string;
  state: TaskState;
  command: string;
  cwd: string;
  pid?: number;
  exit_code?: number;
  signal?: NodeJS.Signals;
  error?: string;
  /** A pipe failure after stdin accepted input; part of that input may have been delivered. */
  input_error?: string;
  stopped_by?: StopReason;
  stdin: "open" | "closed";
  /** How long the shell has run, or ran. */
  runtime_seconds: number;
  /** While the shell runs, how long ago the log last grew. */
  idle_seconds?: number;
  total_bytes: number;
  full_output_path: string;
};

export type ProcessResult = TaskSummary &
  Page & {
    /** Why this write call wrote nothing. */
    input_refused?: string;
  };

/** What a result returned to the caller showed. */
type Shown = Pick<TaskSummary, "state" | "input_error"> & { cursor_bytes?: number };

const seconds = (milliseconds: number) => Math.max(0, Math.round(milliseconds / 1000));

/** Whether the signal reached the process group; signal 0 only asks whether one would. */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    // The group is empty, or holds only processes Pi may not signal.
    return false;
  }
}

function stopWindowsTree(child: Child, pid: number) {
  return Effect.callback<void, Error>((resume) => {
    const killer = spawn(
      join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/F", "/T", "/PID", String(pid)],
      { stdio: "ignore", windowsHide: true },
    );
    killer.once("error", (error) => resume(Effect.fail(error)));
    killer.once("close", (code) => {
      // The command may have exited before taskkill reaches it.
      resume(
        code === 0 || child.exitCode !== null || child.signalCode !== null
          ? Effect.void
          : Effect.fail(new Error(`taskkill failed for PID ${pid}: exit code ${code}`)),
      );
    });
  });
}

/**
 * Stops a command: TERM for its process group, then KILL for whatever is left of the group after
 * the grace period. Windows has no process groups and stops the shell's process tree at once.
 *
 * The group ID stays reserved while the group has members, so the signals reach only this
 * command; the probes end with the group. A probe counts exited processes that nothing has
 * reaped, so the wait lasts the whole grace period where orphans stay unreaped, e.g. in a
 * container without an init process.
 */
function stop(child: Child) {
  const pid = child.pid;
  if (pid === undefined) return Effect.void;
  if (process.platform === "win32") return stopWindowsTree(child, pid).pipe(Effect.ignore);
  return Effect.gen(function* () {
    if (!signalGroup(pid, "SIGTERM")) return;
    const deadline = performance.now() + TERMINATION_GRACE_MS;
    while (performance.now() < deadline) {
      yield* Effect.sleep(TERMINATION_POLL_INTERVAL_MS);
      if (!signalGroup(pid, 0)) return;
    }
    signalGroup(pid, "SIGKILL");
  });
}

/** A session lasts as long as its shell: only the shell's exit finishes it. */
type Phase =
  | { tag: "running" }
  | { tag: "finished"; outcome: Outcome; finishedAt: number; seenAt?: number };

class Task {
  private phase: Phase = { tag: "running" };
  private readonly startedAt = performance.now();
  private readonly exited = Deferred.makeUnsafe<void>();
  private readonly stopRequested = Deferred.makeUnsafe<void>();
  /** Done once the shell has exited and a stop Pi began has run its course. */
  private readonly settled = Deferred.makeUnsafe<void>();
  private stoppedBy: StopReason | undefined;
  /** A stdin failure after a write call accepted input, until a returned result shows it. */
  private inputError: string | undefined;
  /** End of the output that returned results showed, where reads continue by default. */
  private shown = 0;
  /** Bytes written to stdin and not yet flushed; Bun leaves `writableLength` at zero. */
  queuedInput = 0;

  readonly output: Output;

  constructor(
    readonly id: string,
    readonly command: Command,
    readonly child: Child,
    fs: FileSystem.FileSystem,
    logPath: string,
  ) {
    this.output = new Output(fs, logPath, () => this.isFinished);
    child.once("exit", (code, signal) => {
      if (!signal) return this.finish({ state: "exited", exit_code: code ?? EXIT_FAILURE });
      const exitCode = SHELL_SIGNAL_EXIT_BASE + (constants.signals[signal] ?? 0);
      return this.finish({ state: "exited", exit_code: exitCode, signal });
    });
    child.once("error", (error) => this.finish({ state: "failed", error: error.message }));
    // A failed write destroys stdin, which then reports as closed.
    child.stdin.on("error", () => {});
  }

  private finish(outcome: Outcome) {
    if (this.phase.tag !== "running") return;
    this.phase = { tag: "finished", outcome, finishedAt: performance.now() };
    this.child.stdin.destroy();
    Deferred.doneUnsafe(this.exited, Exit.void);
  }

  get isFinished() {
    return this.phase.tag === "finished";
  }

  get isSettled() {
    return Deferred.isDoneUnsafe(this.settled);
  }

  get stdinOpen() {
    const stdin = this.child.stdin;
    return (
      this.phase.tag === "running" && !stdin.destroyed && !stdin.errored && !stdin.writableEnded
    );
  }

  summary() {
    return Effect.suspend(() => {
      // Read the state before the log, so a final state comes with the final length.
      const phase = this.phase;
      const stdin = this.stdinOpen ? ("open" as const) : ("closed" as const);
      return this.output.status().pipe(
        Effect.map(({ totalBytes, modifiedAt }): TaskSummary => {
          const outcome = phase.tag === "finished" ? phase.outcome : undefined;
          const endedAt = phase.tag === "finished" ? phase.finishedAt : performance.now();
          return {
            session_id: this.id,
            state: outcome?.state ?? "running",
            command: this.command.command,
            cwd: this.command.cwd,
            ...(this.child.pid ? { pid: this.child.pid } : {}),
            ...(outcome?.state === "exited" ? { exit_code: outcome.exit_code } : {}),
            ...(outcome?.state === "exited" && outcome.signal ? { signal: outcome.signal } : {}),
            ...(outcome?.state === "failed" ? { error: outcome.error } : {}),
            ...(this.inputError ? { input_error: this.inputError } : {}),
            ...(this.stoppedBy ? { stopped_by: this.stoppedBy } : {}),
            stdin,
            runtime_seconds: seconds(endedAt - this.startedAt),
            ...(outcome ? {} : { idle_seconds: seconds(Date.now() - modifiedAt) }),
            total_bytes: totalBytes,
            full_output_path: this.output.path,
          };
        }),
      );
    });
  }

  /**
   * Marks what a result returned to the caller showed. Only the caller knows whether a result
   * reaches it: streaming updates, cancelled calls, and cleanup observe without returning.
   * Calls that overlap on a session therefore start from the same place and can return the same
   * output; none is skipped.
   */
  acknowledge(shown: Shown) {
    if (shown.cursor_bytes !== undefined) this.shown = Math.max(this.shown, shown.cursor_bytes);
    if (this.phase.tag === "finished" && shown.state !== "running") {
      this.phase.seenAt ??= performance.now();
    }
    if (shown.input_error !== undefined && this.inputError === shown.input_error) {
      this.inputError = undefined;
    }
  }

  /** Where output continues after what returned results showed. */
  get shownCursor() {
    return this.shown;
  }

  stdinFailed(message: string) {
    this.inputError ??= message;
  }

  /** Whether the caller has yet to see this session's final state or a stdin failure. */
  get unreported() {
    return (
      (this.phase.tag === "finished" && this.phase.seenAt === undefined) ||
      this.inputError !== undefined
    );
  }

  /** When a returned result first showed the final state, for retention by recency. */
  get seenAt() {
    return this.phase.tag === "finished" && !this.unreported ? this.phase.seenAt : undefined;
  }

  /** Reads without marking anything as shown; see `acknowledge`. */
  observe(cursor: number, from: "cursor" | "end") {
    return Effect.gen({ self: this }, function* () {
      // Summarize before reading, so a final state comes with the output written until then.
      const summary = yield* this.summary();
      const page = yield* this.output.page(cursor, from);
      return { ...summary, ...page } satisfies ProcessResult;
    });
  }

  /** Waits until the shell exits, `until` completes, or `waitMs` elapses. */
  wait(
    waitMs: number,
    cursor: number,
    onUpdate?: (result: ProcessResult) => void,
    until: Effect.Effect<unknown> = Effect.never,
  ) {
    return Effect.gen({ self: this }, function* () {
      const finished = Effect.raceFirst(Deferred.await(this.exited), until).pipe(
        Effect.timeoutOption(waitMs),
      );
      if (!onUpdate) {
        yield* finished;
      } else {
        const updates = Effect.gen({ self: this }, function* () {
          let reported = (yield* this.output.status()).totalBytes;
          while (true) {
            yield* Effect.sleep(OUTPUT_UPDATE_INTERVAL_MS);
            const { totalBytes } = yield* this.output.status();
            if (totalBytes === reported) continue;
            reported = totalBytes;
            onUpdate(yield* this.observe(cursor, "end"));
          }
        });
        yield* Effect.raceFirst(finished, updates);
      }
      return yield* this.observe(cursor, "end");
    });
  }

  private requestStop(reason: StopReason) {
    if (this.phase.tag !== "running" || this.stoppedBy) return;
    this.stoppedBy = reason;
    Deferred.doneUnsafe(this.stopRequested, Exit.void);
  }

  /**
   * Requests a stop and waits until it has run its course. The supervisor carries the stop out,
   * so cancelling this wait never keeps a TERM from escalating to KILL.
   */
  kill() {
    return Effect.suspend(() => {
      this.requestStop("kill");
      return Deferred.await(this.settled);
    });
  }

  /** For exit handlers, which must be synchronous: ends what Pi still manages of the command. */
  killNow() {
    const pid = this.child.pid;
    if (this.isSettled || pid === undefined) return;
    if (process.platform !== "win32") {
      signalGroup(pid, "SIGKILL");
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }

  /** Carries out the time limit and requested stops; nothing else signals the command. */
  supervise() {
    return Effect.gen({ self: this }, function* () {
      const { timeoutMs } = this.command;
      if (timeoutMs !== undefined) {
        yield* Effect.forkChild(
          Effect.sleep(timeoutMs).pipe(
            Effect.andThen(Effect.sync(() => this.requestStop("timeout"))),
          ),
        );
      }
      const stopping = yield* Effect.raceFirst(
        Deferred.await(this.stopRequested).pipe(Effect.as(true)),
        Deferred.await(this.exited).pipe(Effect.as(false)),
      );
      if (stopping) {
        yield* stop(this.child);
        // KILL ends the shell unless the kernel holds it; the session then keeps running.
        yield* Deferred.await(this.exited).pipe(Effect.timeoutOption(TERMINATION_GRACE_MS));
      }
      yield* Deferred.succeed(this.settled, undefined);
    });
  }
}

export const makeProcesses = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Scope.make();
  const tasks = new Map<string, Task>();
  /** Commands Pi may still signal. A finished session can leave `tasks` before its stop ends. */
  const supervised = new Set<Task>();
  const removed = new Set<string>();
  let closed = false;

  // Pi can exit without session_shutdown, e.g. when its terminal disappears. Exit handlers must be
  // synchronous, so only the shell is reached on Windows, which has no process groups.
  const killOnExit = () => {
    for (const task of supervised) task.killNow();
  };
  // Acquired first, so closing the scope removes the handler last: Pi may exit while shutdown is
  // still waiting out a termination grace period.
  yield* Effect.acquireRelease(
    Effect.sync(() => process.on("exit", killOnExit)),
    () => Effect.sync(() => process.off("exit", killOnExit)),
  ).pipe(Scope.provide(scope));
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-bash-" }).pipe(
    Scope.provide(scope),
    // Nothing else closes the scope when initialization fails.
    Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
  );

  const get = (id: string) =>
    Effect.suspend(() => {
      const task = tasks.get(id);
      if (task) return Effect.succeed(task);
      return Effect.fail(
        new Error(
          removed.has(id)
            ? `Session ${id} was removed to keep the ${MAX_REPORTED_SESSIONS} most recently seen finished sessions`
            : `Unknown session: ${id}`,
        ),
      );
    });

  // Rejects invalid cursors before an action changes anything.
  const checked = (id: string, cursor: number) =>
    get(id).pipe(Effect.tap((task) => task.output.checkCursor(cursor)));

  // Pruning can remove a session's log under an observation that found the session first.
  const live =
    (id: string) =>
    <A>(effect: Effect.Effect<A, Error>) =>
      effect.pipe(
        Effect.catchIf(
          () => removed.has(id) && !tasks.has(id),
          (error) => get(id).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );

  // Callers take sessions out of the map before removing their logs, so concurrent removals never
  // claim the same session. An interrupted removal leaves only a file that shutdown removes.
  const removeLogs = (stale: Task[]) =>
    Effect.forEach(stale, (task) => fs.remove(task.output.path).pipe(Effect.ignore), {
      discard: true,
    }).pipe(Effect.uninterruptible);

  const prune = Effect.suspend(() => {
    const seen = [...tasks.values()]
      .filter((task) => task.seenAt !== undefined)
      .sort((a, b) => a.seenAt! - b.seenAt!);
    const stale = seen.slice(0, Math.max(0, seen.length - MAX_REPORTED_SESSIONS));
    for (const task of stale) {
      tasks.delete(task.id);
      removed.add(task.id);
      if (removed.size > MAX_REMOVED_IDS) removed.delete(removed.values().next().value!);
    }
    return removeLogs(stale);
  });

  const refuse = (task: Task, cursor: number, reason: string) =>
    task
      .observe(cursor, "end")
      .pipe(Effect.map((result): ProcessResult => ({ ...result, input_refused: reason })));

  return {
    start: (command: Command) =>
      Effect.gen(function* () {
        const shell = yield* Effect.try(() => getShellConfig(command.shellPath));
        if (shell.commandTransport === "stdin") {
          return yield* Effect.fail(
            new Error(
              "This bash requires stdin for commands; set shellPath to Git Bash to keep task stdin writable",
            ),
          );
        }
        yield* prune;
        const id = randomUUID();
        const path = join(directory, `${id}.log`);
        const task = yield* Effect.acquireUseRelease(
          Effect.try(() => openSync(path, "ax", LOG_MODE)),
          (log) =>
            // One synchronous step, so shutdown either finds the command or turns it away.
            Effect.try(() => {
              if (closed) throw new Error("Bash session is shutting down");
              const shellCommand = command.shellCommandPrefix
                ? `${command.shellCommandPrefix}\n${command.command}`
                : command.command;
              const child = spawn(shell.shell, [...shell.args, shellCommand], {
                cwd: command.cwd,
                env: { ...command.env, TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0" },
                detached: process.platform !== "win32",
                windowsHide: true,
                stdio: ["pipe", log, log],
              });
              const task = new Task(id, command, child as Child, fs, path);
              tasks.set(id, task);
              supervised.add(task);
              return task;
            }),
          // The command holds its own copies of the descriptor.
          (log) => Effect.sync(() => closeSync(log)),
        ).pipe(Effect.onError(() => fs.remove(path).pipe(Effect.ignore)));
        yield* task
          .supervise()
          .pipe(Effect.ensuring(Effect.sync(() => supervised.delete(task))), Effect.forkIn(scope));
        return task;
      }).pipe(Effect.uninterruptible),

    poll: (
      id: string,
      waitMs: number,
      cursor: number,
      onUpdate?: (result: ProcessResult) => void,
    ) =>
      checked(id, cursor).pipe(
        Effect.flatMap((task) => task.wait(waitMs, cursor, onUpdate)),
        live(id),
      ),

    read: (id: string, cursor: number) =>
      checked(id, cursor).pipe(
        Effect.flatMap((task) => task.observe(cursor, "cursor")),
        live(id),
      ),

    write: (
      id: string,
      chars: string,
      eof: boolean,
      waitMs: number,
      cursor: number,
      onUpdate?: (result: ProcessResult) => void,
    ) =>
      checked(id, cursor).pipe(
        Effect.flatMap((task) => {
          if (!task.stdinOpen) {
            return refuse(task, cursor, "stdin is closed");
          }
          const queued = task.queuedInput;
          const bytes = Buffer.byteLength(chars);
          if (queued + bytes > MAX_QUEUED_INPUT_BYTES) {
            return refuse(
              task,
              cursor,
              `${bytes} more bytes would exceed ${MAX_QUEUED_INPUT_BYTES} bytes of stdin the command has not read; ${queued} are queued`,
            );
          }
          // The pipe can fail after accepting input, e.g. once the command closes stdin, by which
          // time the command may have read part of it. Results report the failure until one is
          // acknowledged, even when it arrives after this call returns. Bun reports no failure
          // when the pipe has no reader; the input is then lost silently.
          const rejected = Deferred.makeUnsafe<void>();
          const settled = (error?: Error | null) => {
            if (!error) return;
            task.stdinFailed(error.message);
            Deferred.doneUnsafe(rejected, Effect.void);
          };
          if (chars) {
            task.queuedInput += bytes;
            task.child.stdin.write(chars, (error) => {
              task.queuedInput -= bytes;
              settled(error);
            });
          }
          if (eof) task.child.stdin.end(settled);
          return task.wait(waitMs, cursor, onUpdate, Deferred.await(rejected));
        }),
        live(id),
      ),

    kill: (id: string, cursor: number) =>
      checked(id, cursor).pipe(
        Effect.tap((task) => task.kill()),
        Effect.flatMap((task) => task.observe(cursor, "end")),
        live(id),
      ),

    /** Removes a finished session whose whole output the caller has already received. */
    discard: (id: string) =>
      Effect.suspend(() => {
        const task = tasks.get(id);
        // Pruning may already have removed it.
        if (!task) return Effect.void;
        if (!task.isFinished) return Effect.die(new Error(`${id} is running`));
        tasks.delete(id);
        return removeLogs([task]);
      }),

    list: Effect.suspend(() =>
      Effect.forEach([...tasks.values()], (task) =>
        task.summary().pipe(
          Effect.map(Option.some),
          // Pruning can remove a session's log while the list is being read.
          Effect.catchIf(
            () => !tasks.has(task.id),
            () => Effect.succeed(Option.none<TaskSummary>()),
          ),
        ),
      ).pipe(Effect.map((summaries) => summaries.flatMap(Option.toArray))),
    ),

    /** Records what a result returned to the caller showed; the session may be gone by then. */
    acknowledge: (shown: Shown & Pick<TaskSummary, "session_id">) =>
      Effect.sync(() => tasks.get(shown.session_id)?.acknowledge(shown)),

    /** Where output continues after what returned results showed. */
    shownCursor: (id: string) => get(id).pipe(Effect.map((task) => task.shownCursor)),

    /** Sessions that still need the caller's attention. */
    pending: Effect.sync(() => {
      const running: string[] = [];
      const unreported: string[] = [];
      for (const task of tasks.values()) {
        if (!task.isFinished) running.push(task.id);
        else if (task.unreported) unreported.push(task.id);
      }
      return { running, unreported };
    }),

    shutdown: Effect.gen(function* () {
      closed = true;
      yield* Effect.forEach([...supervised], (task) => task.kill(), {
        concurrency: "unbounded",
        discard: true,
      });
      yield* Scope.close(scope, Exit.void);
      tasks.clear();
    }),
  };
}).pipe(Effect.provide(NodeFileSystem.layer));

export type Processes = Effect.Success<typeof makeProcesses>;
