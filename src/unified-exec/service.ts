import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import {
  SessionCapacityError,
  SessionNotFoundError,
  SessionShuttingDownError,
  TerminationError,
  type SpawnError,
  type UnifiedExecUnavailableError,
} from "./errors.js";
import { ExecSession, type SessionSpawnOptions } from "./session.js";
import { IS_WINDOWS } from "./shell.js";

export const MAX_SESSIONS = 64;
export const MAX_TOMBSTONES = 64;
const MAX_CONCURRENT_SPAWNS = 8;
const decoder = new TextDecoder("utf-8", { fatal: false });

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
  readonly finalOutput: Uint8Array;
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
}

export interface AgentSessionSnapshot extends SessionSnapshot {
  readonly outputTail: string | undefined;
}

interface SessionTombstone {
  readonly session: ExecSession;
  readonly snapshot: SessionSnapshot;
  readonly outputTail: string | undefined;
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
  agentInventory: Effect.Effect<readonly AgentSessionSnapshot[]>;
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
  return Effect.promise(() => mkdtemp(join(tmpdir(), "pi-unified-exec-")));
}

function removeLogDirectory(directory: string | undefined): Effect.Effect<void> {
  if (!directory) return Effect.void;
  return Effect.promise(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
      () => undefined,
    ),
  );
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
    let logDirectory: string | undefined = yield* makeLogDirectory();

    const reconcileExitedUnsafe = (): void => {
      for (const [id, session] of sessions) {
        if (!session.hasExited) continue;
        sessions.delete(id);
        tombstones.push({
          session,
          snapshot: sessionSnapshot(session),
          outputTail: session.tty ? undefined : decoder.decode(session.snapshotStreamTail()),
        });
      }
      while (tombstones.length > MAX_TOMBSTONES) tombstones.shift();
    };

    const inventoryUnsafe = (): readonly SessionSnapshot[] => {
      reconcileExitedUnsafe();
      return Object.freeze(
        [
          ...[...sessions.values()].map(sessionSnapshot),
          ...tombstones.map((tombstone) => tombstone.snapshot),
        ].toSorted((a, b) => a.sessionId - b.sessionId),
      );
    };

    const agentInventoryUnsafe = (): readonly AgentSessionSnapshot[] => {
      reconcileExitedUnsafe();
      return Object.freeze(
        [
          ...[...sessions.values()].map((session) =>
            Object.freeze({
              ...sessionSnapshot(session),
              outputTail: session.tty ? undefined : decoder.decode(session.snapshotStreamTail()),
            }),
          ),
          ...tombstones.map((tombstone) =>
            Object.freeze({ ...tombstone.snapshot, outputTail: tombstone.outputTail }),
          ),
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
                  const directory = logDirectory;
                  if (!directory) return yield* Effect.fail(new SessionShuttingDownError());
                  const session = yield* ExecSession.spawn(id, options, directory);
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
            return [
              ...sessions.values(),
              ...tombstones.map((tombstone) => tombstone.session),
            ].toSorted((a, b) => a.id - b.id);
          }),
        ),
      inventory: stateSemaphore.withPermit(Effect.sync(inventoryUnsafe)),
      agentInventory: stateSemaphore.withPermit(Effect.sync(agentInventoryUnsafe)),
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
      resume: Effect.gen(function* () {
        const directory = logDirectory ?? (yield* makeLogDirectory());
        yield* stateSemaphore.withPermit(
          Effect.sync(() => {
            logDirectory = directory;
            shuttingDown = false;
          }),
        );
        yield* Effect.sync(publishInventory);
      }),
    };
    return api;
  });
}

function sessionSnapshot(session: ExecSession): SessionSnapshot {
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
