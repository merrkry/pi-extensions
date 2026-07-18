import { randomBytes } from "node:crypto";
import { closeSync, createWriteStream, openSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";

import { HeadTailBuffer } from "./buffer.js";
import { loadPty, spawnChild, type SpawnedChild } from "./child.js";
import { SpawnError, StdinWriteError, type UnifiedExecUnavailableError } from "./errors.js";

export const DEFAULT_HEAD_TAIL_MAX_BYTES = 1024 * 1024;
const DEFAULT_STREAM_TAIL_BYTES = 32 * 1024;
const POST_EXIT_CLOSE_WAIT_MS = 50;

export interface SessionSpawnOptions {
  readonly command: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly tty: boolean;
  readonly displayCommand: string;
  readonly windowsVerbatimArguments?: boolean;
  readonly headTailMaxBytes?: number;
  readonly streamTailBytes?: number;
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
  readonly outputBuffer: HeadTailBuffer;
  readonly logPath: string;
  readonly operationSemaphore = Semaphore.makeUnsafe(1);
  readonly exited = Deferred.makeUnsafe<void>();
  readonly outputClosed = Deferred.makeUnsafe<void>();

  private readonly streamTailCap: number;
  private streamTail: Uint8Array[] = [];
  private streamTailBytes = 0;
  private totalOutputBytes = 0;
  private state: SessionState = {
    hasExited: false,
    exitCode: null,
    signal: null,
    failureMessage: null,
  };
  private lastUsedAt = this.startedAt;
  private logStream: WriteStream | undefined;

  private constructor(
    readonly id: number,
    readonly child: SpawnedChild,
    readonly displayCommand: string,
    readonly cwd: string,
    readonly tty: boolean,
    logPath: string,
    outputBuffer: HeadTailBuffer,
    streamTailCap: number,
    logStream: WriteStream,
    private readonly outputSignal: Queue.Queue<void>,
  ) {
    this.logPath = logPath;
    this.outputBuffer = outputBuffer;
    this.streamTailCap = streamTailCap;
    this.logStream = logStream;
    this.attachChild();
  }

  static spawn(
    id: number,
    options: SessionSpawnOptions,
  ): Effect.Effect<ExecSession, SpawnError | UnifiedExecUnavailableError> {
    return Effect.gen(function* () {
      const pty = options.tty ? yield* loadPty : undefined;
      const outputSignal = yield* Queue.sliding<void>(1);
      const logPath = join(tmpdir(), `pi-unified-exec-${id}-${randomBytes(4).toString("hex")}.log`);
      return yield* Effect.try({
        try: () => {
          closeSync(openSync(logPath, "w"));
          const logStream = createWriteStream(logPath, { flags: "a" });
          let child: SpawnedChild;
          try {
            child = spawnChild(options, pty);
          } catch (cause) {
            logStream.end();
            throw cause;
          }
          return new ExecSession(
            id,
            child,
            options.displayCommand,
            options.cwd,
            options.tty,
            logPath,
            new HeadTailBuffer(options.headTailMaxBytes ?? DEFAULT_HEAD_TAIL_MAX_BYTES),
            options.streamTailBytes ?? DEFAULT_STREAM_TAIL_BYTES,
            logStream,
            outputSignal,
          );
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
    this.logStream?.on("error", (cause) => {
      this.recordFailure(`log stream error: ${cause.message}`);
      this.logStream = undefined;
    });
    this.child.onData((chunk) => {
      this.totalOutputBytes += chunk.length;
      this.outputBuffer.pushChunk(chunk);
      this.appendStreamTail(chunk);
      this.logStream?.write(Buffer.from(chunk));
      Queue.offerUnsafe(this.outputSignal, undefined);
    });
    this.child.onExit((exitCode, signal, failureMessage) => {
      this.state = {
        hasExited: true,
        exitCode,
        signal,
        failureMessage: this.state.failureMessage ?? failureMessage ?? null,
      };
      Deferred.doneUnsafe(this.exited, Effect.void);
      Queue.offerUnsafe(this.outputSignal, undefined);
      setImmediate(() => {
        const stream = this.logStream;
        this.logStream = undefined;
        const close = () => {
          Deferred.doneUnsafe(this.outputClosed, Effect.void);
          Queue.offerUnsafe(this.outputSignal, undefined);
        };
        if (!stream) return close();
        stream.once("close", close);
        stream.end();
      });
    });
  }

  private appendStreamTail(chunk: Uint8Array): void {
    this.streamTail.push(chunk.slice());
    this.streamTailBytes += chunk.length;
    while (this.streamTailBytes > this.streamTailCap && this.streamTail.length > 0) {
      const first = this.streamTail[0]!;
      const excess = this.streamTailBytes - this.streamTailCap;
      if (first.length <= excess) {
        this.streamTail.shift();
        this.streamTailBytes -= first.length;
      } else {
        this.streamTail[0] = first.slice(excess);
        this.streamTailBytes -= excess;
      }
    }
  }

  private recordFailure(message: string): void {
    this.state = { ...this.state, failureMessage: this.state.failureMessage ?? message };
  }

  collectUntil(deadlineMs: number): Effect.Effect<Uint8Array> {
    return collectSessionUntil(this, deadlineMs);
  }

  poll(deadlineMs: number, input?: Uint8Array): Effect.Effect<Uint8Array, StdinWriteError> {
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

  clearOutputSignal(): Effect.Effect<void> {
    return Queue.clear(this.outputSignal).pipe(Effect.asVoid);
  }

  awaitOutputSignal(timeoutMs: number): Effect.Effect<Option.Option<void>> {
    return Queue.take(this.outputSignal).pipe(Effect.timeoutOption(timeoutMs));
  }

  writeNow(data: Uint8Array): boolean {
    return this.child.write(data);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): Effect.Effect<void> {
    return Effect.sync(() => {
      if (!this.hasExited) this.child.kill(signal);
    });
  }

  snapshotStreamTail(): Uint8Array {
    return concat(this.streamTail);
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

  get totalBytesSeen(): number {
    return this.totalOutputBytes;
  }

  get lastUsed(): number {
    return this.lastUsedAt;
  }

  touch(): void {
    this.lastUsedAt = Date.now();
  }
}

function collectSessionUntil(session: ExecSession, deadlineMs: number): Effect.Effect<Uint8Array> {
  return Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let postExitDeadline: number | undefined;
    for (;;) {
      yield* session.clearOutputSignal();
      const drained = session.outputBuffer.drainChunks();
      chunks.push(...drained);
      const now = Date.now();
      if (
        session.hasExited &&
        Deferred.isDoneUnsafe(session.outputClosed) &&
        drained.length === 0
      ) {
        break;
      }
      if (now >= deadlineMs) break;
      if (session.hasExited) {
        postExitDeadline ??= Math.min(deadlineMs, now + POST_EXIT_CLOSE_WAIT_MS);
      }
      const waitUntil = postExitDeadline ?? deadlineMs;
      if (waitUntil <= now) break;
      const notified = yield* session.awaitOutputSignal(waitUntil - now);
      if (Option.isNone(notified)) break;
    }
    return concat(chunks);
  });
}

function pollSession(
  session: ExecSession,
  deadlineMs: number,
  input?: Uint8Array,
): Effect.Effect<Uint8Array, StdinWriteError> {
  return session.operationSemaphore.withPermit(
    Effect.gen(function* () {
      session.touch();
      if (input && input.length > 0) {
        if (!session.writeNow(input)) {
          return yield* new StdinWriteError({
            sessionId: session.id,
            message: session.hasExited
              ? "the process has already exited"
              : "stdin write failed: the child closed its stdin; bytes were not delivered",
          });
        }
        yield* Effect.sleep(100);
      }
      return yield* session.collectUntil(deadlineMs);
    }),
  );
}

function streamSessionUpdates(
  session: ExecSession,
  deadlineMs: number,
  emit: (details: StreamUpdate) => void,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (Date.now() < deadlineMs) {
      yield* Effect.sleep(250);
      const output = decoder.decode(session.snapshotStreamTail());
      yield* Effect.sync(() =>
        emit({
          session_id: session.id,
          pid: session.pid,
          running: !session.hasExited,
          total_bytes: session.totalBytesSeen,
          tty: session.tty,
          command: session.displayCommand,
          cwd: session.cwd,
          log_path: session.logPath,
          output,
        }),
      );
      if (session.hasExited) return;
    }
  });
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
