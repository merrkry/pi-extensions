import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import type { CollectedOutput } from "./buffer.js";
import {
  SessionCapacityError,
  SessionNotFoundError,
  SessionShuttingDownError,
  TerminationError,
  type SpawnError,
  type UnifiedExecUnavailableError,
} from "./errors.js";
import {
  DEFAULT_RUNTIME_LOG_MAX_BYTES,
  DEFAULT_SESSION_LOG_MAX_BYTES,
  LogBudget,
  type LogStatus,
  RUNTIME_LOG_MAX_BYTES_ENV_VAR,
  resolveLogMaxBytes,
  SESSION_LOG_MAX_BYTES_ENV_VAR,
} from "./log.js";
import { ExecSession, type SessionSpawnOptions } from "./session.js";
import { IS_WINDOWS } from "./shell.js";

export const MAX_SESSIONS = 64;
export const MAX_TOMBSTONES = 64;
const MAX_CONCURRENT_SPAWNS = 8;
const LOG_DIRECTORY_PREFIX = "pi-unified-exec-";
const STALE_LOG_DIRECTORY_AGE_MS = 24 * 60 * 60 * 1_000;
let cleanupWarningEmitted = false;

export interface LaunchOutcome {
  readonly session: ExecSession;
}

export interface InterruptOutcome {
  readonly session: SessionSnapshot;
  readonly sent: boolean;
}

export interface TerminateOutcome {
  readonly session: ExecSession;
  readonly escalated: boolean;
  readonly finalOutput: CollectedOutput;
}

export type SessionPhase = "running" | "stopping" | "exited";

export interface SessionSnapshot {
  readonly sessionId: number;
  readonly phase: SessionPhase;
  readonly pid: number | undefined;
  readonly command: string;
  readonly cwd: string;
  readonly tty: boolean;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly requestedSignal: NodeJS.Signals | undefined;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly failureMessage: string | null;
  readonly outputBytesTotal: number;
  readonly logPath: string;
  readonly logStatus: LogStatus;
  readonly logBytesWritten: number;
  readonly logBytesDropped: number;
  readonly logErrorMessage: string | undefined;
}

interface SessionTombstone {
  readonly session: ExecSession;
}

export type InventoryListener = (sessions: readonly SessionSnapshot[]) => void;

export interface UnifiedExecApi {
  launch(
    options: SessionSpawnOptions,
  ): Effect.Effect<
    LaunchOutcome,
    SessionCapacityError | SessionShuttingDownError | SpawnError | UnifiedExecUnavailableError
  >;
  get(sessionId: number): Effect.Effect<ExecSession, SessionNotFoundError>;
  list(): Effect.Effect<readonly ExecSession[]>;
  inventory: Effect.Effect<readonly SessionSnapshot[]>;
  subscribe(listener: InventoryListener): Effect.Effect<() => void>;
  remove(sessionId: number): Effect.Effect<ExecSession | undefined>;
  interrupt(sessionId: number): Effect.Effect<InterruptOutcome, SessionNotFoundError>;
  signal(
    sessionId: number,
    signal: NodeJS.Signals,
  ): Effect.Effect<SessionSnapshot, SessionNotFoundError>;
  terminate(
    sessionId: number,
    signal: NodeJS.Signals,
  ): Effect.Effect<TerminateOutcome, SessionNotFoundError | TerminationError>;
  shutdown: Effect.Effect<readonly ExecSession[]>;
  resume: Effect.Effect<void>;
}

export class UnifiedExec extends Context.Service<UnifiedExec, UnifiedExecApi>()(
  "@pi-extensions/UnifiedExec",
) {}

function notifyInventoryListener(
  listener: InventoryListener,
  inventory: readonly SessionSnapshot[],
): void {
  try {
    listener(inventory);
  } catch {
    // An observer must not interfere with process ownership.
  }
}

function makeLogDirectory(): Effect.Effect<string> {
  return Effect.promise(async () => {
    await removeStaleLogDirectories();
    const directory = await mkdtemp(join(tmpdir(), `${LOG_DIRECTORY_PREFIX}${process.pid}-`));
    try {
      await writeFile(
        join(directory, ".owner.json"),
        JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        { mode: 0o600 },
      );
      await chmod(directory, 0o700);
      return directory;
    } catch (cause) {
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch (cleanupCause) {
        warnCleanupFailure(`could not roll back ${directory}: ${String(cleanupCause)}`);
      }
      throw cause;
    }
  });
}

function removeLogDirectory(directory: string | undefined): Effect.Effect<void> {
  if (!directory) return Effect.void;
  return Effect.promise(async () => {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (cause) {
      warnCleanupFailure(`could not remove ${directory}: ${String(cause)}`);
    }
  });
}

async function removeStaleLogDirectories(): Promise<void> {
  const root = tmpdir();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (cause) {
    warnCleanupFailure(`could not inspect ${root}: ${String(cause)}`);
    return;
  }

  const cutoff = Date.now() - STALE_LOG_DIRECTORY_AGE_MS;
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(LOG_DIRECTORY_PREFIX))
      .map((entry) => removeStaleLogDirectory(join(root, entry.name), cutoff)),
  );
}

async function removeStaleLogDirectory(directory: string, cutoff: number): Promise<void> {
  try {
    const metadata = await lstat(directory);
    const currentUid = process.getuid?.();
    if (!metadata.isDirectory() || (currentUid !== undefined && metadata.uid !== currentUid))
      return;
    const owner = await readLogDirectoryOwner(directory, metadata.birthtimeMs);
    if (!owner) return;
    if (
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.createdAt !== "number" ||
      !Number.isFinite(owner.createdAt) ||
      owner.createdAt > cutoff ||
      processIsAlive(owner.pid)
    ) {
      return;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (cause) {
    const code =
      cause && typeof cause === "object" && "code" in cause ? String(cause.code) : undefined;
    if (code !== "ENOENT") warnCleanupFailure(`could not clean ${directory}: ${String(cause)}`);
  }
}

async function readLogDirectoryOwner(
  directory: string,
  fallbackCreatedAt: number,
): Promise<{ readonly pid?: unknown; readonly createdAt?: unknown } | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, ".owner.json"), "utf8")) as {
      readonly pid?: unknown;
      readonly createdAt?: unknown;
    };
  } catch (cause) {
    const code =
      cause && typeof cause === "object" && "code" in cause ? String(cause.code) : undefined;
    if (code !== "ENOENT") throw cause;
    const match = new RegExp(`^${LOG_DIRECTORY_PREFIX}(\\d+)-`).exec(basename(directory));
    if (!match) return undefined;
    return { pid: Number(match[1]), createdAt: fallbackCreatedAt };
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      String(cause.code) === "ESRCH"
    );
  }
}

function warnCleanupFailure(message: string): void {
  if (cleanupWarningEmitted) return;
  cleanupWarningEmitted = true;
  process.emitWarning(`unified-exec log cleanup: ${message}`);
}

function makeUnifiedExec(): Effect.Effect<UnifiedExecApi> {
  return Effect.gen(function* () {
    const stateSemaphore = yield* Semaphore.make(1);
    const spawnSemaphore = yield* Semaphore.make(MAX_CONCURRENT_SPAWNS);
    const sessions = new Map<number, ExecSession>();
    const tombstones: SessionTombstone[] = [];
    const pendingIds = new Set<number>();
    const inventoryListeners = new Set<InventoryListener>();
    let nextId = 1;
    let shuttingDown = false;
    let logDirectory: string | undefined;
    let logBudget = new LogBudget(
      resolveLogMaxBytes(RUNTIME_LOG_MAX_BYTES_ENV_VAR, DEFAULT_RUNTIME_LOG_MAX_BYTES),
    );

    const ensureLogDirectory = stateSemaphore.withPermit(
      Effect.gen(function* () {
        if (shuttingDown) return yield* Effect.fail(new SessionShuttingDownError());
        logDirectory ??= yield* makeLogDirectory();
        return logDirectory;
      }),
    );

    const reconcileExitedUnsafe = (): void => {
      for (const [id, session] of sessions) {
        if (!session.hasExited) continue;
        sessions.delete(id);
        tombstones.push({ session });
      }
      while (tombstones.length > MAX_TOMBSTONES) tombstones.shift();
    };

    const inventoryUnsafe = (): readonly SessionSnapshot[] => {
      reconcileExitedUnsafe();
      return Object.freeze(
        [
          ...[...sessions.values()].map(sessionSnapshot),
          ...tombstones.map((tombstone) => sessionSnapshot(tombstone.session)),
        ].toSorted((a, b) => a.sessionId - b.sessionId),
      );
    };

    const publishInventory = (): void => {
      const inventory = inventoryUnsafe();
      for (const listener of inventoryListeners) notifyInventoryListener(listener, inventory);
    };

    const remove = (sessionId: number) =>
      stateSemaphore
        .withPermit(
          Effect.sync(() => {
            const session = sessions.get(sessionId);
            sessions.delete(sessionId);
            const tombstoneIndex = tombstones.findIndex(
              (tombstone) => tombstone.session.id === sessionId,
            );
            const tombstone =
              tombstoneIndex < 0 ? undefined : tombstones.splice(tombstoneIndex, 1)[0];
            return session ?? tombstone?.session;
          }),
        )
        .pipe(Effect.tap(() => Effect.sync(publishInventory)));

    const releaseReservation = (sessionId: number) =>
      stateSemaphore.withPermit(
        Effect.sync(() => {
          pendingIds.delete(sessionId);
        }),
      );

    const api: UnifiedExecApi = {
      launch: (options) =>
        Effect.gen(function* () {
          const id = yield* stateSemaphore.withPermit(
            Effect.gen(function* () {
              if (shuttingDown) return yield* Effect.fail(new SessionShuttingDownError());
              reconcileExitedUnsafe();
              if (sessions.size + pendingIds.size >= MAX_SESSIONS) {
                return yield* Effect.fail(new SessionCapacityError({ maximum: MAX_SESSIONS }));
              }
              const reserved = nextId++;
              pendingIds.add(reserved);
              return reserved;
            }),
          );

          return yield* spawnSemaphore
            .withPermit(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* stateSemaphore.withPermit(
                    Effect.suspend(() =>
                      shuttingDown ? Effect.fail(new SessionShuttingDownError()) : Effect.void,
                    ),
                  );
                  const directory = yield* ensureLogDirectory;
                  const session = yield* ExecSession.spawn(
                    id,
                    {
                      ...options,
                      logMaxBytes:
                        options.logMaxBytes ??
                        resolveLogMaxBytes(
                          SESSION_LOG_MAX_BYTES_ENV_VAR,
                          DEFAULT_SESSION_LOG_MAX_BYTES,
                        ),
                    },
                    directory,
                    logBudget,
                  );
                  session.onStateChange(publishInventory);
                  const accepted = yield* stateSemaphore.withPermit(
                    Effect.sync(() => {
                      pendingIds.delete(id);
                      if (shuttingDown) return false;
                      sessions.set(id, session);
                      return true;
                    }),
                  );
                  if (!accepted) {
                    yield* terminateOwnedSessions([session]);
                    return yield* Effect.fail(new SessionShuttingDownError());
                  }
                  yield* Effect.sync(publishInventory);
                  return { session };
                }),
              ),
            )
            .pipe(Effect.onExit(() => releaseReservation(id)));
        }),
      get: (sessionId) =>
        stateSemaphore.withPermit(
          Effect.suspend(() => {
            const session =
              sessions.get(sessionId) ??
              tombstones.find((tombstone) => tombstone.session.id === sessionId)?.session;
            return session
              ? Effect.succeed(session)
              : Effect.fail(new SessionNotFoundError({ sessionId }));
          }),
        ),
      list: () =>
        stateSemaphore.withPermit(
          Effect.sync(() => {
            reconcileExitedUnsafe();
            return [...sessions.values()].toSorted((a, b) => a.id - b.id);
          }),
        ),
      inventory: stateSemaphore.withPermit(Effect.sync(inventoryUnsafe)),
      subscribe: (listener) =>
        Effect.sync(() => {
          inventoryListeners.add(listener);
          notifyInventoryListener(listener, inventoryUnsafe());
          return () => {
            inventoryListeners.delete(listener);
          };
        }),
      remove,
      interrupt: (sessionId) =>
        Effect.gen(function* () {
          const session = yield* api.get(sessionId);
          const sent = yield* session.interrupt();
          return { session: sessionSnapshot(session), sent };
        }),
      signal: (sessionId, signal) =>
        Effect.gen(function* () {
          const session = yield* api.get(sessionId);
          yield* session.kill(signal);
          return sessionSnapshot(session);
        }),
      terminate: (sessionId, signal) =>
        Effect.gen(function* () {
          const session = yield* api.get(sessionId);
          yield* session.kill(signal);
          let exited = yield* session.awaitExit(2_000);
          let escalated = false;
          if (!exited && !IS_WINDOWS) {
            escalated = true;
            yield* session.kill("SIGKILL");
            exited = yield* session.awaitExit(500);
          }
          const finalOutput = yield* session.operationSemaphore.withPermit(
            session.collectUntil(Date.now() + 100),
          );
          if (!exited) return yield* Effect.fail(new TerminationError({ sessionId, signal }));
          return { session, escalated, finalOutput };
        }),
      shutdown: stateSemaphore
        .withPermit(
          Effect.sync(() => {
            shuttingDown = true;
            const owned = [
              ...sessions.values(),
              ...tombstones.map((tombstone) => tombstone.session),
            ];
            const directory = logDirectory;
            sessions.clear();
            tombstones.length = 0;
            logDirectory = undefined;
            return { directory, owned };
          }),
        )
        .pipe(
          Effect.tap(() => Effect.sync(publishInventory)),
          Effect.flatMap(({ directory, owned }) =>
            terminateOwnedSessions(owned).pipe(
              Effect.ensuring(removeLogDirectory(directory)),
              Effect.as(owned),
            ),
          ),
        ),
      resume: stateSemaphore
        .withPermit(
          Effect.sync(() => {
            if (shuttingDown) {
              logBudget = new LogBudget(
                resolveLogMaxBytes(RUNTIME_LOG_MAX_BYTES_ENV_VAR, DEFAULT_RUNTIME_LOG_MAX_BYTES),
              );
            }
            shuttingDown = false;
          }),
        )
        .pipe(Effect.tap(() => Effect.sync(publishInventory))),
    };
    return api;
  });
}

function sessionSnapshot(session: ExecSession): SessionSnapshot {
  const log = session.logSnapshot;
  return Object.freeze({
    sessionId: session.id,
    phase: session.hasExited ? "exited" : session.isStopping ? "stopping" : "running",
    pid: session.pid,
    command: session.displayCommand,
    cwd: session.cwd,
    tty: session.tty,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    requestedSignal: session.requestedSignal,
    exitCode: session.exitCode,
    exitSignal: session.signal,
    failureMessage: session.failureMessage,
    outputBytesTotal: session.totalBytesSeen,
    logPath: session.logPath,
    logStatus: log.status,
    logBytesWritten: log.bytesWritten,
    logBytesDropped: log.bytesDropped,
    logErrorMessage: log.errorMessage,
  });
}

function terminateOwnedSessions(
  sessions: readonly ExecSession[],
): Effect.Effect<readonly ExecSession[]> {
  return Effect.gen(function* () {
    yield* Effect.all(
      sessions.map((session) => session.kill()),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
    yield* Effect.all(
      sessions.map((session) => session.awaitExit(1_000)),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
    if (!IS_WINDOWS) {
      const survivors = sessions.filter((session) => !session.hasExited);
      yield* Effect.all(
        survivors.map((session) => session.kill("SIGKILL")),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
      yield* Effect.all(
        survivors.map((session) => session.awaitExit(500)),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    }
    yield* Effect.all(
      sessions.map((session) => session.awaitOutputClosed(500)),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
    return sessions;
  });
}

export const UnifiedExecLive = Layer.effect(
  UnifiedExec,
  Effect.acquireRelease(makeUnifiedExec(), (service) => service.shutdown.pipe(Effect.asVoid)),
);
