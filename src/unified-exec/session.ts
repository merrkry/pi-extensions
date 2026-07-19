import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";

import { type CollectedOutput, TailByteRing } from "./buffer.js";
import { loadPty, spawnChild, type SpawnedChild } from "./child.js";
import { SpawnError, StdinWriteError, type UnifiedExecUnavailableError } from "./errors.js";
import { DEFAULT_SESSION_LOG_MAX_BYTES, LogBudget, type LogSnapshot, SessionLog } from "./log.js";

export const DEFAULT_OUTPUT_TAIL_BYTES = 64 * 1024;
const DEFAULT_STREAM_TAIL_BYTES = 32 * 1024;
const STREAM_UPDATE_INTERVAL_MS = 250;
const POST_EXIT_CLOSE_WAIT_MS = 50;
const INTERRUPT_STATE_DEBOUNCE_MS = 500;

export interface SessionSpawnOptions {
  readonly command: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly tty: boolean;
  readonly displayCommand: string;
  readonly initialStdin?: Uint8Array;
  readonly outputTailBytes?: number;
  readonly streamTailBytes?: number;
  readonly logMaxBytes?: number;
}

export interface SessionState {
  readonly hasExited: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly failureMessage: string | null;
}

export interface StreamUpdate {
  readonly session_id: number;
  readonly pid: number | undefined;
  readonly running: boolean;
  readonly total_bytes: number;
  readonly tty: boolean;
  readonly command: string;
  readonly cwd: string;
  readonly log_path: string;
  readonly output: string;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

export class ExecSession {
  readonly startedAt = Date.now();
  readonly logPath: string;
  readonly operationSemaphore = Semaphore.makeUnsafe(1);
  readonly exited = Deferred.makeUnsafe<void>();
  readonly outputClosed = Deferred.makeUnsafe<void>();

  private readonly outputTail: TailByteRing;
  private readonly streamTail: TailByteRing;
  private committedOutputOffset = 0;
  private state: SessionState = {
    hasExited: false,
    exitCode: null,
    signal: null,
    failureMessage: null,
  };
  private requestedSignalValue: NodeJS.Signals | undefined;
  private requestedSignalVisibleAt = 0;
  private endedAtValue: number | undefined;
  private readonly stateListeners = new Set<() => void>();
  private readonly outputListeners = new Set<() => void>();

  private constructor(
    readonly id: number,
    readonly child: SpawnedChild,
    readonly displayCommand: string,
    readonly cwd: string,
    readonly tty: boolean,
    private readonly log: SessionLog,
    outputTail: TailByteRing,
    streamTail: TailByteRing,
    private readonly outputSignal: Queue.Queue<void>,
  ) {
    this.logPath = log.path;
    this.outputTail = outputTail;
    this.streamTail = streamTail;
    this.attachChild();
  }

  static spawn(
    id: number,
    options: SessionSpawnOptions,
    logDirectory = tmpdir(),
    logBudget = new LogBudget(DEFAULT_SESSION_LOG_MAX_BYTES),
  ): Effect.Effect<ExecSession, SpawnError | UnifiedExecUnavailableError> {
    return Effect.gen(function* () {
      const pty = options.tty ? yield* loadPty : undefined;
      const outputSignal = yield* Queue.sliding<void>(1);
      const logPath = join(logDirectory, `${id}-${randomBytes(4).toString("hex")}.log`);
      return yield* Effect.try({
        try: () => {
          const log = SessionLog.open(
            logPath,
            logBudget,
            options.logMaxBytes ?? DEFAULT_SESSION_LOG_MAX_BYTES,
          );
          let child: SpawnedChild;
          try {
            child = spawnChild(options, pty);
          } catch (cause) {
            log.end();
            throw cause;
          }
          const session = new ExecSession(
            id,
            child,
            options.displayCommand,
            options.cwd,
            options.tty,
            log,
            new TailByteRing(options.outputTailBytes ?? DEFAULT_OUTPUT_TAIL_BYTES),
            new TailByteRing(options.streamTailBytes ?? DEFAULT_STREAM_TAIL_BYTES),
            outputSignal,
          );
          if (options.initialStdin && !child.end(options.initialStdin)) {
            child.kill();
            throw new Error("failed to send the command to the shell over stdin");
          }
          return session;
        },
        catch: (cause) =>
          new SpawnError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
    });
  }

  private attachChild(): void {
    this.log.onWritable(() => this.child.resumeOutput());
    this.log.onStatusChange(() => this.notifyStateChange());
    const closeOutput = () => {
      Deferred.doneUnsafe(this.outputClosed, Effect.void);
      Queue.offerUnsafe(this.outputSignal, undefined);
      this.notifyStateChange();
    };
    this.log.onClose(closeOutput);
    this.child.onData((chunk) => {
      this.outputTail.append(chunk);
      this.streamTail.append(chunk);
      if (this.log.append(chunk) === "backpressured") this.child.pauseOutput();
      Queue.offerUnsafe(this.outputSignal, undefined);
      this.notifyOutputChange();
    });
    this.child.onExit((exitCode, signal, failureMessage) => {
      this.endedAtValue = Date.now();
      this.state = {
        hasExited: true,
        exitCode,
        signal,
        failureMessage: failureMessage ?? null,
      };
      this.notifyStateChange();
      Deferred.doneUnsafe(this.exited, Effect.void);
      Queue.offerUnsafe(this.outputSignal, undefined);
      setImmediate(() => this.log.end());
    });
  }

  private notifyStateChange(): void {
    for (const listener of this.stateListeners) {
      try {
        listener();
      } catch {
        // Process lifecycle callbacks must not be disrupted by observers.
      }
    }
  }

  private notifyOutputChange(): void {
    for (const listener of this.outputListeners) {
      try {
        listener();
      } catch {
        // Output collection must not be disrupted by streaming observers.
      }
    }
  }

  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onOutputChange(listener: () => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  collectUntil(deadlineMs: number): Effect.Effect<CollectedOutput> {
    return collectSessionUntil(this, deadlineMs);
  }

  poll(deadlineMs: number, input?: Uint8Array): Effect.Effect<CollectedOutput, StdinWriteError> {
    return pollSession(this, deadlineMs, input);
  }

  streamUpdates(deadlineMs: number, emit: (details: StreamUpdate) => void): Effect.Effect<void> {
    return streamSessionUpdates(this, deadlineMs, emit);
  }

  awaitExit(timeoutMs: number): Effect.Effect<boolean> {
    if (this.hasExited) return Effect.succeed(true);
    return Deferred.await(this.exited).pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.map(Option.isSome),
    );
  }

  awaitOutputClosed(timeoutMs: number): Effect.Effect<boolean> {
    return Deferred.await(this.outputClosed).pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.map(Option.isSome),
    );
  }

  clearOutputSignal(): Effect.Effect<void> {
    return Queue.clear(this.outputSignal).pipe(Effect.asVoid);
  }

  awaitOutputSignal(timeoutMs: number): Effect.Effect<Option.Option<void>> {
    return Queue.take(this.outputSignal).pipe(Effect.timeoutOption(timeoutMs));
  }

  writeNow(data: Uint8Array): boolean {
    return this.child.write(data);
  }

  interrupt(): Effect.Effect<boolean> {
    return Effect.sync(() => {
      if (this.hasExited || !this.child.interrupt()) return false;
      this.requestedSignalValue = "SIGINT";
      this.requestedSignalVisibleAt = Date.now() + INTERRUPT_STATE_DEBOUNCE_MS;
      this.notifyStateChange();
      const timer = setTimeout(() => {
        if (!this.hasExited && this.requestedSignalValue === "SIGINT") this.notifyStateChange();
      }, INTERRUPT_STATE_DEBOUNCE_MS);
      timer.unref();
      return true;
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.hasExited) return;
      this.requestedSignalValue = signal;
      this.requestedSignalVisibleAt = Date.now();
      this.child.kill(signal);
      this.notifyStateChange();
    });
  }

  snapshotStreamTail(): Uint8Array {
    return this.streamTail.snapshotTail();
  }

  takePendingOutput(): CollectedOutput {
    const snapshot = this.outputTail.snapshotFrom(this.committedOutputOffset);
    this.committedOutputOffset = snapshot.endOffset;
    return {
      bytes: snapshot.bytes,
      totalBytes: snapshot.totalBytes,
      omittedBytes: snapshot.omittedBytes,
    };
  }

  snapshotState(): SessionState {
    return { ...this.state };
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get hasExited(): boolean {
    return this.state.hasExited;
  }

  get exitCode(): number | null {
    return this.state.exitCode;
  }

  get signal(): NodeJS.Signals | null {
    return this.state.signal;
  }

  get failureMessage(): string | null {
    return this.state.failureMessage;
  }

  get requestedSignal(): NodeJS.Signals | undefined {
    return this.requestedSignalValue;
  }

  get isStopping(): boolean {
    return this.requestedSignalValue !== undefined && Date.now() >= this.requestedSignalVisibleAt;
  }

  get endedAt(): number | undefined {
    return this.endedAtValue;
  }

  get totalBytesSeen(): number {
    return this.outputTail.totalBytes;
  }

  get logSnapshot(): LogSnapshot {
    return this.log.snapshot();
  }
}

function collectSessionUntil(
  session: ExecSession,
  deadlineMs: number,
): Effect.Effect<CollectedOutput> {
  return Effect.gen(function* () {
    let postExitDeadline: number | undefined;
    for (;;) {
      yield* session.clearOutputSignal();
      const now = Date.now();
      if (session.hasExited && Deferred.isDoneUnsafe(session.outputClosed)) break;
      if (now >= deadlineMs) break;
      if (session.hasExited) {
        postExitDeadline ??= Math.min(deadlineMs, now + POST_EXIT_CLOSE_WAIT_MS);
      }
      const waitUntil = postExitDeadline ?? deadlineMs;
      if (waitUntil <= now) break;
      const notified = yield* session.awaitOutputSignal(waitUntil - now);
      if (Option.isNone(notified)) break;
    }
    return session.takePendingOutput();
  });
}

function pollSession(
  session: ExecSession,
  deadlineMs: number,
  input?: Uint8Array,
): Effect.Effect<CollectedOutput, StdinWriteError> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) return Effect.succeed(emptyCollectedOutput());

  return Effect.acquireUseRelease(
    session.operationSemaphore.take(1).pipe(Effect.timeoutOption(remaining)),
    (permit) =>
      Option.isNone(permit)
        ? Effect.succeed(emptyCollectedOutput())
        : pollSessionWithPermit(session, deadlineMs, input),
    (permit) =>
      Option.isSome(permit)
        ? session.operationSemaphore.release(1).pipe(Effect.asVoid)
        : Effect.void,
  );
}

function pollSessionWithPermit(
  session: ExecSession,
  deadlineMs: number,
  input?: Uint8Array,
): Effect.Effect<CollectedOutput, StdinWriteError> {
  return Effect.gen(function* () {
    if (Date.now() >= deadlineMs) return emptyCollectedOutput();
    if (input && input.length > 0) {
      if (!session.writeNow(input)) {
        return yield* new StdinWriteError({
          sessionId: session.id,
          message: session.hasExited
            ? "the process has already exited"
            : "stdin write failed: the child closed its stdin; bytes were not delivered",
        });
      }
      // Once stdin has been accepted, finish the short delivery grace period
      // rather than converting the side effect into an ambiguous deadline timeout.
      yield* Effect.sleep(100).pipe(Effect.uninterruptible);
    }
    return yield* session.collectUntil(deadlineMs);
  });
}

function emptyCollectedOutput(): CollectedOutput {
  return { bytes: new Uint8Array(), totalBytes: 0, omittedBytes: 0 };
}

function streamSessionUpdates(
  session: ExecSession,
  deadlineMs: number,
  emit: (details: StreamUpdate) => void,
): Effect.Effect<void> {
  return Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* Queue.sliding<void>(1);
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          session.onOutputChange(() => {
            Queue.offerUnsafe(changes, undefined);
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );

      let emittedBytes = 0;
      const emitCurrent = () => {
        const totalBytes = session.totalBytesSeen;
        if (totalBytes === emittedBytes) return;
        emittedBytes = totalBytes;
        emit({
          session_id: session.id,
          pid: session.pid,
          running: !session.hasExited,
          total_bytes: totalBytes,
          tty: session.tty,
          command: session.displayCommand,
          cwd: session.cwd,
          log_path: session.logPath,
          output: decoder.decode(session.snapshotStreamTail()),
        });
      };

      yield* Queue.clear(changes);
      yield* Effect.sync(emitCurrent);
      while (Date.now() < deadlineMs && !session.hasExited) {
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) break;
        const changed = yield* Queue.take(changes).pipe(Effect.timeoutOption(remaining));
        if (Option.isNone(changed)) break;
        const coalesceMs = Math.max(
          0,
          Math.min(STREAM_UPDATE_INTERVAL_MS, deadlineMs - Date.now()),
        );
        yield* Effect.sleep(coalesceMs);
        yield* Queue.clear(changes);
        yield* Effect.sync(emitCurrent);
      }
    }),
  );
}
