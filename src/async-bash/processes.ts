import { NodeFileSystem, NodeStream } from "@effect/platform-node";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { Cause, Deferred, Effect, Exit, FileSystem, Option, Scope, Stream } from "effect";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { join } from "node:path";
import { Output, type Page } from "./output.ts";

// Match Pi's bash output cadence to keep streaming updates inexpensive.
const OUTPUT_UPDATE_INTERVAL_MS = 100;
const OUTPUT_IDLE_AFTER_EXIT_MS = 100;
/**
 * Bounds capture after the process group exits, for processes outside the group that still hold
 * the output pipes. No group member writes by then, and backpressure kept the backlog to the pipe
 * and stream buffers, which drain in milliseconds, so the deadline never cuts off group output.
 */
const MAX_CAPTURE_AFTER_TREE_EXIT_MS = 1_000;
export const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_POLL_INTERVAL_MS = 100;
/**
 * How long a wait that saw the command running continues after its shell exits, so that a command
 * whose descendants are about to exit, or whose capture is ending, still returns its final state.
 * Background processes that outlive it, such as a server, then end the wait as `draining` instead
 * of holding it to its limit.
 */
const SHELL_EXIT_GRACE_MS = MAX_CAPTURE_AFTER_TREE_EXIT_MS + 1_000;

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

type Outcome =
  | { state: "exited"; exit_code: number; signal?: NodeJS.Signals }
  | { state: "failed"; error: string };

const preserveOutput = () => {};

export interface Command {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  shellPath?: string;
  shellCommandPrefix?: string;
  /** Stops the process group once the session has run this long. */
  timeoutMs?: number;
}

/** Why the session's process group was stopped. */
export type StopReason = "kill" | "timeout";

/** `draining`: the shell has exited, but its process group or output capture has not finished. */
export type TaskState = "running" | "draining" | "exited" | "failed";

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
  /** Set once a kill or the timeout started stopping the process group. */
  stopped_by?: StopReason;
  stdin: "open" | "closed";
  total_bytes: number;
  /** Since the command started, until it finished. */
  runtime_seconds: number;
  /** Since the last output, or since the start when there was none. */
  idle_seconds: number;
  full_output_path: string;
};

/** What a result returned to the caller showed. */
type Shown = Pick<TaskSummary, "state" | "input_error"> & { cursor_bytes?: number };

const seconds = (milliseconds: number) => Math.round(milliseconds / 1000);

export type ProcessResult = TaskSummary &
  Page & {
    /** Why this write call wrote nothing. */
    input_refused?: string;
  };

function terminateTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (process.platform === "win32") {
    return Effect.callback<void, Error>((resume) => {
      if (!child.pid) return resume(Effect.void);
      const killer = spawn(
        join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/F", "/T", "/PID", String(child.pid)],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", (error) => resume(Effect.fail(error)));
      killer.once("close", (code) => {
        // The command may have exited before taskkill reaches it.
        resume(
          code === 0 || child.exitCode !== null || child.signalCode !== null
            ? Effect.void
            : Effect.fail(new Error(`taskkill failed for PID ${child.pid}: exit code ${code}`)),
        );
      });
    });
  }
  return Effect.try(() => {
    if (child.pid) process.kill(-child.pid, signal);
  }).pipe(
    Effect.catchIf(
      (error) =>
        error.cause instanceof Error && "code" in error.cause && error.cause.code === "ESRCH",
      () => Effect.void,
    ),
  );
}

/**
 * Whether a process in the group can still run. A zombie keeps its group signalable until its
 * parent reaps it, and the reaper of an orphan, such as a container's PID 1, may never do so;
 * Linux exposes process states to skip zombies, while other systems count them as alive.
 */
function groupAlive(fs: FileSystem.FileSystem, pgid: number) {
  return Effect.gen(function* () {
    const signalable = yield* Effect.try(() => {
      process.kill(-pgid, 0);
      return true;
    }).pipe(
      Effect.catchIf(
        (error) =>
          error.cause instanceof Error && "code" in error.cause && error.cause.code === "ESRCH",
        () => Effect.succeed(false),
      ),
    );
    if (!signalable || process.platform !== "linux") return signalable;
    const pids = fs
      .readDirectory("/proc")
      .pipe(Effect.map((entries) => entries.filter((entry) => /^\d+$/u.test(entry))));
    // The fields after the parenthesized command name start with state, ppid, and pgrp.
    const stat = (pid: string) =>
      fs
        .readFileString(`/proc/${pid}/stat`)
        .pipe(
          Effect.option,
          Effect.map(Option.map((text) => text.slice(text.lastIndexOf(")") + 2).split(" "))),
        );
    // Without procfs, e.g. in some containers, zombies count as alive as on other systems.
    const listed = yield* Effect.option(pids);
    if (Option.isNone(listed)) return true;
    const before = listed.value;
    for (const pid of before) {
      const fields = yield* stat(pid);
      if (Option.isSome(fields) && Number(fields.value[2]) === pgid && fields.value[0] !== "Z") {
        return true;
      }
    }
    // A member alive after the scan was either listed before it, and so found live, or appeared
    // during it. Count any process that appeared and is in the group, or has already gone, as live.
    const known = new Set(before);
    for (const pid of yield* pids.pipe(Effect.orElseSucceed(() => [] as string[]))) {
      if (known.has(pid)) continue;
      const fields = yield* stat(pid);
      if (Option.isNone(fields) || Number(fields.value[2]) === pgid) return true;
    }
    return false;
  });
}

/**
 * A session's lifecycle. Each step only moves forward, and only the session's monitor finishes it.
 * `draining`: the shell has exited, but its process group or output capture has not finished.
 */
type Phase =
  | { tag: "running" }
  | { tag: "draining"; outcome: Outcome }
  | {
      tag: "finished";
      outcome: Outcome;
      finishedAt: number;
      captureError?: string;
      seenAt?: number;
    };

class Task {
  private phase: Phase = { tag: "running" };
  private readonly exited = Deferred.makeUnsafe<Outcome>();
  private readonly finished = Deferred.makeUnsafe<void>();
  private readonly killRequested = Deferred.makeUnsafe<void>();
  private stopReason: StopReason | undefined;
  private readonly startedAt = performance.now();
  /** A stdin failure after a write call accepted input, until a returned result shows it. */
  private inputError: string | undefined;
  /** End of the output that returned results showed, where reads continue by default. */
  private shown = 0;
  /** Bytes written to stdin and not yet flushed; Bun leaves `writableLength` at zero. */
  queuedInput = 0;

  constructor(
    readonly id: string,
    readonly command: Command,
    readonly child: ChildProcessWithoutNullStreams,
    readonly output: Output,
  ) {
    // Node resumes unread stdio on exit. Retain it until Effect attaches its readers.
    child.stdout.on("readable", preserveOutput);
    child.stderr.on("readable", preserveOutput);
    child.once("exit", (code, signal) => {
      let exitCode = code ?? EXIT_FAILURE;
      if (code === null && signal) {
        const signalNumber = constants.signals[signal];
        if (signalNumber !== undefined) exitCode = SHELL_SIGNAL_EXIT_BASE + signalNumber;
      }
      this.exit(
        signal
          ? { state: "exited", exit_code: exitCode, signal }
          : { state: "exited", exit_code: exitCode },
      );
    });
    child.once("error", (error) => this.exit({ state: "failed", error: error.message }));
    // A failed write destroys stdin, which then reports as closed.
    child.stdin.on("error", () => {});
  }

  private exit(outcome: Outcome) {
    if (this.phase.tag !== "running") return;
    this.phase = { tag: "draining", outcome };
    Deferred.doneUnsafe(this.exited, Effect.succeed(outcome));
  }

  get isFinished() {
    return this.phase.tag === "finished";
  }

  get state(): TaskState {
    return this.phase.tag === "finished" ? this.phase.outcome.state : this.phase.tag;
  }

  get stdinOpen() {
    const stdin = this.child.stdin;
    return (
      this.phase.tag === "running" && !stdin.destroyed && !stdin.errored && !stdin.writableEnded
    );
  }

  summary(): TaskSummary {
    const phase = this.phase;
    const now = phase.tag === "finished" ? phase.finishedAt : performance.now();
    const lastOutput = this.output.lastAppendAt ?? this.startedAt;
    const outcome = phase.tag === "running" ? undefined : phase.outcome;
    const error =
      outcome?.state === "failed"
        ? outcome.error
        : phase.tag === "finished" &&
          phase.captureError &&
          `Output capture failed: ${phase.captureError}`;
    return {
      session_id: this.id,
      state: this.state,
      command: this.command.command,
      cwd: this.command.cwd,
      ...(this.child.pid ? { pid: this.child.pid } : {}),
      ...(outcome?.state === "exited"
        ? {
            exit_code: outcome.exit_code,
            ...(outcome.signal ? { signal: outcome.signal } : {}),
          }
        : {}),
      ...(error ? { error } : {}),
      ...(this.inputError ? { input_error: this.inputError } : {}),
      ...(this.stopReason ? { stopped_by: this.stopReason } : {}),
      stdin: this.stdinOpen ? "open" : "closed",
      total_bytes: this.output.totalBytes,
      runtime_seconds: seconds(now - this.startedAt),
      idle_seconds: seconds(Math.max(0, now - lastOutput)),
      full_output_path: this.output.path,
    };
  }

  /**
   * Marks what a result returned to the caller showed. Only the caller knows whether a result
   * reaches it: streaming updates, cancelled calls, and cleanup observe without returning.
   */
  acknowledge(shown: Shown) {
    if (shown.cursor_bytes !== undefined) this.shown = Math.max(this.shown, shown.cursor_bytes);
    if (this.phase.tag === "finished" && (shown.state === "exited" || shown.state === "failed")) {
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
    return Effect.suspend(() => {
      // Observe state before output, so a finished state always comes with the final bytes.
      const summary = this.summary();
      return this.output
        .page(cursor, from)
        .pipe(Effect.map((page): ProcessResult => ({ ...summary, ...page })));
    });
  }

  /**
   * Waits until the command finishes, `until` completes, or `waitMs` elapses. A wait that starts
   * while the shell runs also ends shortly after the shell exits, leaving any background processes
   * draining; a wait that starts while they drain lasts until they exit.
   */
  wait(
    waitMs: number,
    cursor: number,
    onUpdate?: (result: ProcessResult) => void,
    until: Effect.Effect<unknown> = Effect.never,
  ) {
    return Effect.gen({ self: this }, function* () {
      const shellExit =
        this.phase.tag === "running"
          ? Deferred.await(this.exited).pipe(Effect.andThen(Effect.sleep(SHELL_EXIT_GRACE_MS)))
          : Effect.never;
      const finished = Effect.raceAllFirst([Deferred.await(this.finished), shellExit, until]).pipe(
        Effect.timeoutOption(waitMs),
      );
      if (!onUpdate) {
        yield* finished;
      } else {
        const output = this.output;
        const observe = () => this.observe(cursor, "end");
        const updates = Effect.gen(function* () {
          let reported = output.totalBytes;
          while (true) {
            yield* Effect.sleep(OUTPUT_UPDATE_INTERVAL_MS);
            if (output.totalBytes === reported) continue;
            reported = output.totalBytes;
            onUpdate(yield* observe());
          }
        });
        yield* Effect.raceFirst(finished, updates);
      }
      return yield* this.observe(cursor, "end");
    });
  }

  /**
   * Requests termination and waits until the session finishes. The monitor carries the
   * termination out, so cancelling this wait never stops a TERM from escalating to KILL.
   */
  kill() {
    return this.requestStop("kill").pipe(Effect.andThen(Deferred.await(this.finished)));
  }

  /** The first request decides the reason; a finished session has nothing left to stop. */
  private requestStop(reason: StopReason) {
    return Effect.suspend(() => {
      if (this.stopReason === undefined && this.phase.tag !== "finished") this.stopReason = reason;
      return Deferred.succeed(this.killRequested, undefined);
    });
  }

  /**
   * Waits for every process in the shell's process group. Processes that leave the group, e.g.
   * through setsid, escape both this wait and group signals, as they do in Pi's own bash; only
   * their hold on the output pipes is bounded, by MAX_CAPTURE_AFTER_TREE_EXIT_MS.
   */
  private waitForTreeExit(fs: FileSystem.FileSystem) {
    if (process.platform === "win32") return Deferred.await(this.exited).pipe(Effect.asVoid);
    const pid = this.child.pid;
    return Effect.gen(function* () {
      while (pid && (yield* groupAlive(fs, pid))) {
        yield* Effect.sleep(TERMINATION_POLL_INTERVAL_MS);
      }
    });
  }

  /**
   * The only driver of the lifecycle: captures output, carries out a requested termination, and
   * finishes the session once its process group has exited and capture has ended. It then closes
   * `scope`, which holds the child process.
   */
  monitor(fs: FileSystem.FileSystem, scope: Scope.Closeable) {
    return Effect.gen({ self: this }, function* () {
      const { child, output } = this;
      const terminated = Deferred.makeUnsafe<void>();
      const treeExited = Deferred.makeUnsafe<void>();
      const captureDeadline = Deferred.makeUnsafe<void>();

      const timeoutMs = this.command.timeoutMs;
      if (timeoutMs !== undefined) {
        yield* Effect.forkChild(
          Effect.sleep(timeoutMs).pipe(Effect.andThen(this.requestStop("timeout"))),
        );
      }
      yield* Effect.forkChild(
        Deferred.await(this.killRequested).pipe(
          Effect.andThen(terminateTree(child, "SIGTERM")),
          Effect.andThen(this.waitForTreeExit(fs).pipe(Effect.timeoutOption(TERMINATION_GRACE_MS))),
          Effect.flatMap((exited) =>
            Option.isNone(exited) ? terminateTree(child, "SIGKILL") : Effect.void,
          ),
          Effect.ignore,
          Effect.ensuring(Deferred.succeed(terminated, undefined)),
        ),
      );
      yield* Effect.forkChild(
        Effect.gen({ self: this }, function* () {
          yield* Deferred.await(this.exited);
          // After KILL, members still in the group are zombies or unkillable; waiting longer
          // cannot help.
          yield* Effect.raceFirst(this.waitForTreeExit(fs), Deferred.await(terminated));
          yield* Deferred.succeed(treeExited, undefined);
          yield* Effect.sleep(MAX_CAPTURE_AFTER_TREE_EXIT_MS);
          yield* Deferred.succeed(captureDeadline, undefined);
        }),
      );

      const chunks = Stream.merge(
        NodeStream.fromReadable({
          evaluate: () => {
            child.stdout.off("readable", preserveOutput);
            return child.stdout;
          },
        }).pipe(Stream.map((data) => ({ data, channel: "stdout" as const }))),
        NodeStream.fromReadable({
          evaluate: () => {
            child.stderr.off("readable", preserveOutput);
            return child.stderr;
          },
        }).pipe(Stream.map((data) => ({ data, channel: "stderr" as const }))),
      );
      // Once the process group has exited, an idle pull or the deadline ends capture. Both only
      // stop waiting for writers outside the group; see MAX_CAPTURE_AFTER_TREE_EXIT_MS.
      const read = Stream.transformPull(chunks, (pull) =>
        Effect.succeed(
          Effect.raceFirst(
            pull,
            Effect.raceFirst(
              Deferred.await(treeExited).pipe(
                Effect.andThen(Effect.sleep(OUTPUT_IDLE_AFTER_EXIT_MS)),
              ),
              Deferred.await(captureDeadline),
            ).pipe(Effect.andThen(Cause.done())),
          ),
        ),
      ).pipe(Stream.runForEach(({ data, channel }) => output.append(data, channel)));

      const captureError = yield* Effect.gen(function* () {
        yield* read;
        // Background processes that closed their output still keep the session draining.
        yield* Deferred.await(treeExited);
        yield* output.finish();
        return undefined;
      }).pipe(
        Effect.catchCause((cause) =>
          terminateTree(child, "SIGKILL").pipe(
            Effect.ignore,
            Effect.as(String(Cause.squash(cause))),
          ),
        ),
      );
      const outcome = yield* Deferred.await(this.exited);
      // Shell exit does not end a requested grace period for its descendants.
      if (Deferred.isDoneUnsafe(this.killRequested)) yield* Deferred.await(terminated);
      yield* Scope.close(scope, Exit.void);
      this.phase = {
        tag: "finished",
        outcome,
        finishedAt: performance.now(),
        ...(captureError ? { captureError } : {}),
      };
      yield* Deferred.succeed(this.finished, undefined);
    });
  }
}

export const makeProcesses = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Scope.make();
  const tasks = new Map<string, Task>();
  const removed = new Set<string>();
  let closed = false;

  // Pi can exit without session_shutdown, e.g. when its terminal disappears. Exit handlers must be
  // synchronous, so only the shell is reached on Windows, which has no process groups.
  const killOnExit = () => {
    for (const task of tasks.values()) {
      if (task.isFinished || !task.child.pid) continue;
      try {
        process.kill(process.platform === "win32" ? task.child.pid : -task.child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
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
        if (closed) return yield* Effect.fail(new Error("Bash session is shutting down"));
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
        const taskScope = yield* Scope.fork(scope);
        const path = join(directory, `${id}.log`);
        const task = yield* Effect.gen(function* () {
          const output = yield* Output.make(fs, path, taskScope);
          return yield* Effect.acquireRelease(
            Effect.try(() => {
              const shellCommand = command.shellCommandPrefix
                ? `${command.shellCommandPrefix}\n${command.command}`
                : command.command;
              const child = spawn(shell.shell, [...shell.args, shellCommand], {
                cwd: command.cwd,
                // Python output reaches the log as it is written, so sessions show progress.
                env: {
                  ...command.env,
                  TERM: "dumb",
                  NO_COLOR: "1",
                  FORCE_COLOR: "0",
                  PYTHONUNBUFFERED: "1",
                },
                detached: process.platform !== "win32",
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
              });
              return new Task(id, command, child, output);
            }),
            (task) =>
              terminateTree(task.child, "SIGKILL").pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    task.child.stdin.destroy();
                    task.child.stdout.destroy();
                    task.child.stderr.destroy();
                  }),
                ),
                Effect.orDie,
              ),
          ).pipe(Scope.provide(taskScope));
        }).pipe(
          Effect.onError((cause) =>
            Scope.close(taskScope, Exit.failCause(cause)).pipe(
              Effect.andThen(fs.remove(path).pipe(Effect.ignore)),
            ),
          ),
        );
        tasks.set(id, task);
        // The monitor owns the task scope once the command has started.
        yield* Effect.forkIn(task.monitor(fs, taskScope), scope);
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

    list: Effect.sync(() => [...tasks.values()].map((task) => task.summary())),

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
      yield* Effect.forEach(tasks.values(), (task) => task.kill(), {
        concurrency: "unbounded",
        discard: true,
      });
      yield* Scope.close(scope, Exit.void);
      tasks.clear();
    }),
  };
}).pipe(Effect.provide(NodeFileSystem.layer));

export type Processes = Effect.Success<typeof makeProcesses>;
