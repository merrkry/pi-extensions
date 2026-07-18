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
const MAX_CONCURRENT_SPAWNS = 8;

export interface LaunchOutcome {
  readonly session: ExecSession;
}

export interface TerminateOutcome {
  readonly session: ExecSession;
  readonly escalated: boolean;
  readonly finalOutput: Uint8Array;
}

export interface UnifiedExecApi {
  launch(
    options: SessionSpawnOptions,
  ): Effect.Effect<
    LaunchOutcome,
    SessionCapacityError | SessionShuttingDownError | SpawnError | UnifiedExecUnavailableError
  >;
  get(sessionId: number): Effect.Effect<ExecSession, SessionNotFoundError>;
  list(): Effect.Effect<readonly ExecSession[]>;
  remove(sessionId: number): Effect.Effect<ExecSession | undefined>;
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

function makeUnifiedExec(): Effect.Effect<UnifiedExecApi> {
  return Effect.gen(function* () {
    const stateSemaphore = yield* Semaphore.make(1);
    const spawnSemaphore = yield* Semaphore.make(MAX_CONCURRENT_SPAWNS);
    const sessions = new Map<number, ExecSession>();
    const pendingIds = new Set<number>();
    let nextId = 1;
    let shuttingDown = false;

    const remove = (sessionId: number) =>
      stateSemaphore.withPermit(
        Effect.sync(() => {
          const session = sessions.get(sessionId);
          sessions.delete(sessionId);
          return session;
        }),
      );

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
              if (sessions.size + pendingIds.size >= MAX_SESSIONS) {
                reapExited(sessions);
              }
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
                  const session = yield* ExecSession.spawn(id, options);
                  yield* stateSemaphore.withPermit(
                    Effect.suspend(() => {
                      pendingIds.delete(id);
                      if (shuttingDown) {
                        return session
                          .kill()
                          .pipe(Effect.andThen(Effect.fail(new SessionShuttingDownError())));
                      }
                      sessions.set(id, session);
                      return Effect.void;
                    }),
                  );
                  return { session };
                }),
              ),
            )
            .pipe(Effect.onExit(() => releaseReservation(id)));
        }),
      get: (sessionId) =>
        stateSemaphore.withPermit(
          Effect.suspend(() => {
            const session = sessions.get(sessionId);
            return session
              ? Effect.succeed(session)
              : Effect.fail(new SessionNotFoundError({ sessionId }));
          }),
        ),
      list: () =>
        stateSemaphore.withPermit(
          Effect.sync(() => [...sessions.values()].toSorted((a, b) => a.id - b.id)),
        ),
      remove,
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
          yield* remove(sessionId);
          return { session, escalated, finalOutput };
        }),
      shutdown: stateSemaphore
        .withPermit(
          Effect.sync(() => {
            shuttingDown = true;
            const owned = [...sessions.values()];
            sessions.clear();
            return owned;
          }),
        )
        .pipe(Effect.flatMap(terminateOwnedSessions)),
      resume: stateSemaphore.withPermit(
        Effect.sync(() => {
          shuttingDown = false;
        }),
      ),
    };
    return api;
  });
}

function reapExited(sessions: Map<number, ExecSession>): void {
  for (const [id, session] of sessions) {
    if (session.hasExited) sessions.delete(id);
  }
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
    return sessions;
  });
}

export const UnifiedExecLive = Layer.effect(
  UnifiedExec,
  Effect.acquireRelease(makeUnifiedExec(), (service) => service.shutdown.pipe(Effect.asVoid)),
);
