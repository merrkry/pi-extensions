import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";

import { RUNTIME_LOG_MAX_BYTES_ENV_VAR } from "./log.js";
import { decode } from "./protocol.js";
import { MAX_TOMBSTONES, UnifiedExec, UnifiedExecLive } from "./service.js";

const spawnOptions = (command: string) => ({
  command: ["bash", "-c", command],
  cwd: process.cwd(),
  env: process.env,
  tty: false,
  displayCommand: command,
});

const run = <A, E>(effect: Effect.Effect<A, E, UnifiedExec>) =>
  Effect.runPromise(effect.pipe(Effect.provide(UnifiedExecLive)));

describe("UnifiedExec service", () => {
  it("captures output and exit state from a pipe process", async () => {
    const result = await run(
      Effect.gen(function* () {
        const manager = yield* UnifiedExec;
        const { session } = yield* manager.launch(spawnOptions("printf effect-ok"));
        expect(yield* session.awaitExit(2_000)).toBe(true);
        const output = yield* session.operationSemaphore.withPermit(
          session.collectUntil(Date.now() + 200),
        );
        return { output: decode(output.bytes), state: session.snapshotState() };
      }),
    );

    expect(result.output).toBe("effect-ok");
    expect(result.state).toMatchObject({ hasExited: true, exitCode: 0 });
  });

  it("sends an initial command over stdin and closes the pipe", async () => {
    const result = await run(
      Effect.gen(function* () {
        const manager = yield* UnifiedExec;
        const command = "printf stdin-ok";
        const { session } = yield* manager.launch({
          ...spawnOptions(command),
          command: ["bash", "-s"],
          initialStdin: new TextEncoder().encode(command),
        });
        expect(yield* session.awaitExit(2_000)).toBe(true);
        const output = yield* session.operationSemaphore.withPermit(
          session.collectUntil(Date.now() + 200),
        );
        return { output: decode(output.bytes), state: session.snapshotState() };
      }),
    );

    expect(result.output).toBe("stdin-ok");
    expect(result.state).toMatchObject({ hasExited: true, exitCode: 0 });
  });

  it("streams only when pipe output changes", async () => {
    const updates = await run(
      Effect.gen(function* () {
        const manager = yield* UnifiedExec;
        const { session } = yield* manager.launch(spawnOptions("printf once; sleep 2"));
        const received: string[] = [];
        yield* session.streamUpdates(Date.now() + 700, (update) => {
          received.push(update.output);
        });
        yield* manager.terminate(session.id, "SIGTERM");
        return received;
      }),
    );

    expect(updates).toEqual(["once"]);
  });

  it("runs interactive commands through the optional PTY provider", async () => {
    const result = await run(
      Effect.gen(function* () {
        const manager = yield* UnifiedExec;
        const { session } = yield* manager.launch({
          ...spawnOptions("printf pty-ok"),
          tty: true,
        });
        expect(yield* session.awaitExit(2_000)).toBe(true);
        const output = yield* session.operationSemaphore.withPermit(
          session.collectUntil(Date.now() + 200),
        );
        return decode(output.bytes);
      }),
    );

    expect(result).toContain("pty-ok");
  });

  it("serializes concurrent writes and polls for the same session", async () => {
    const output = await run(
      Effect.gen(function* () {
        const manager = yield* UnifiedExec;
        const { session } = yield* manager.launch(
          spawnOptions('read first; echo "first:$first"; read second; echo "second:$second"'),
        );
        const now = Date.now();
        const chunks = yield* Effect.all(
          [
            session.poll(now + 250, new TextEncoder().encode("one\n")),
            session.poll(now + 1_500, new TextEncoder().encode("two\n")),
          ],
          { concurrency: "unbounded" },
        );
        return chunks.map((chunk) => decode(chunk.bytes)).join("");
      }),
    );

    expect(output).toContain("first:one");
    expect(output).toContain("second:two");
  });

  it("finishes reporting input accepted just before the permit deadline", async () => {
    const output = await run(
      Effect.gen(function* () {
        const manager = yield* UnifiedExec;
        const { session } = yield* manager.launch(spawnOptions("cat"));
        yield* session.operationSemaphore.take(1);
        const poll = yield* Effect.forkChild(
          session.poll(Date.now() + 200, new TextEncoder().encode("near-deadline\n")),
        );
        yield* Effect.sleep(150);
        yield* session.operationSemaphore.release(1);
        const collected = yield* Fiber.join(poll);
        yield* manager.terminate(session.id, "SIGTERM");
        return decode(collected.bytes);
      }),
    );

    expect(output).toBe("near-deadline\n");
  });

  it("reports unknown sessions through the typed error channel", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const manager = yield* UnifiedExec;
          return yield* manager.get(999_999);
        }),
      ),
    ).rejects.toMatchObject({ _tag: "SessionNotFoundError", sessionId: 999_999 });
  });

  it("publishes immutable inventory transitions and supports non-escalating signals", async () => {
    const result = await run(
      Effect.gen(function* () {
        const manager = yield* UnifiedExec;
        const phases: string[] = [];
        const unsubscribe = yield* manager.subscribe((sessions) => {
          phases.push(sessions.map((session) => session.phase).join(",") || "empty");
        });
        const { session } = yield* manager.launch(spawnOptions("sleep 30"));
        const running = yield* manager.inventory;
        const stopping = yield* manager.signal(session.id, "SIGTERM");
        expect(yield* session.awaitExit(2_000)).toBe(true);
        const exited = yield* manager.inventory;
        yield* manager.remove(session.id);
        unsubscribe();
        return { running, stopping, exited, phases };
      }),
    );

    expect(result.running).toMatchObject([{ phase: "running", command: "sleep 30" }]);
    expect(Object.isFrozen(result.running)).toBe(true);
    expect(Object.isFrozen(result.running[0])).toBe(true);
    expect(result.stopping).toMatchObject({ phase: "stopping", requestedSignal: "SIGTERM" });
    expect(result.exited).toMatchObject([{ phase: "exited", endedAt: expect.any(Number) }]);
    expect(result.phases).toContain("empty");
    expect(result.phases).toContain("running");
    expect(result.phases).toContain("stopping");
    expect(result.phases).toContain("exited");
  });

  it.skipIf(process.platform === "win32")(
    "debounces the exiting phase after an interrupt",
    async () => {
      const result = await run(
        Effect.gen(function* () {
          const manager = yield* UnifiedExec;
          const { session } = yield* manager.launch(spawnOptions("trap '' INT; sleep 30"));
          yield* Effect.sleep(100);
          const interrupted = yield* manager.interrupt(session.id);
          yield* Effect.sleep(550);
          const delayed = (yield* manager.inventory)[0];
          yield* manager.signal(session.id, "SIGKILL");
          expect(yield* session.awaitExit(2_000)).toBe(true);
          return { interrupted, delayed };
        }),
      );

      expect(result.interrupted).toMatchObject({
        sent: true,
        session: { phase: "running", requestedSignal: "SIGINT" },
      });
      expect(result.delayed).toMatchObject({ phase: "stopping", requestedSignal: "SIGINT" });
    },
  );

  it("refreshes tombstone log state after delayed stream finalization", async () => {
    const result = await run(
      Effect.gen(function* () {
        const manager = yield* UnifiedExec;
        const { session } = yield* manager.launch(spawnOptions("true"));
        expect(yield* session.awaitExit(2_000)).toBe(true);
        const before = (yield* manager.inventory)[0]!;

        const internals = session as unknown as {
          readonly log: { readonly stream: { emit(event: string, cause: Error): boolean } };
        };
        internals.log.stream.emit("error", new Error("delayed log failure"));
        const after = (yield* manager.inventory)[0]!;
        return { before, after };
      }),
    );

    expect(result.before.logStatus).toBe("complete");
    expect(result.after).toMatchObject({
      logStatus: "write_error",
      logErrorMessage: "delayed log failure",
    });
  });

  it("keeps a tombstone after an Agent termination", async () => {
    const inventory = await run(
      Effect.gen(function* () {
        const manager = yield* UnifiedExec;
        const { session } = yield* manager.launch(spawnOptions("sleep 30"));
        yield* manager.terminate(session.id, "SIGTERM");
        return yield* manager.inventory;
      }),
    );

    expect(inventory).toMatchObject([{ phase: "exited", requestedSignal: "SIGTERM" }]);
  });

  it("lists only live sessions while known tombstones remain readable", async () => {
    const result = await run(
      Effect.gen(function* () {
        const manager = yield* UnifiedExec;
        const { session } = yield* manager.launch(spawnOptions("printf completed"));
        expect(yield* session.awaitExit(2_000)).toBe(true);
        const listed = yield* manager.list();
        const retained = yield* manager.get(session.id);
        const output = yield* retained.operationSemaphore.withPermit(
          retained.collectUntil(Date.now() + 200),
        );
        return { listed, output: decode(output.bytes), exitCode: retained.exitCode };
      }),
    );

    expect(result).toEqual({ listed: [], output: "completed", exitCode: 0 });
  });

  it("retains exited background sessions in a bounded FIFO", async () => {
    const inventory = await run(
      Effect.gen(function* () {
        const manager = yield* UnifiedExec;
        for (let index = 0; index <= MAX_TOMBSTONES; index += 1) {
          const { session } = yield* manager.launch(spawnOptions("true"));
          expect(yield* session.awaitExit(2_000)).toBe(true);
        }
        return yield* manager.inventory;
      }),
    );

    expect(inventory).toHaveLength(MAX_TOMBSTONES);
    expect(inventory[0]).toMatchObject({ sessionId: 2, phase: "exited" });
    expect(inventory.at(-1)).toMatchObject({
      sessionId: MAX_TOMBSTONES + 1,
      phase: "exited",
    });
  });

  it("caps each session log without affecting captured process output", async () => {
    const result = await run(
      Effect.gen(function* () {
        const manager = yield* UnifiedExec;
        const { session } = yield* manager.launch({
          ...spawnOptions("printf 0123456789abcdefghijklmnopqrstuvwxyz"),
          logMaxBytes: 10,
        });
        expect(yield* session.awaitExit(2_000)).toBe(true);
        expect(yield* session.awaitOutputClosed(2_000)).toBe(true);
        const output = yield* session.operationSemaphore.withPermit(
          session.collectUntil(Date.now() + 200),
        );
        return {
          output: decode(output.bytes),
          log: readFileSync(session.logPath, "utf8"),
          status: session.logSnapshot,
        };
      }),
    );

    expect(result.output).toBe("0123456789abcdefghijklmnopqrstuvwxyz");
    expect(result.log).toBe("0123456789");
    expect(result.status).toMatchObject({
      status: "capped",
      bytesWritten: 10,
      bytesDropped: 26,
    });
  });

  it("enforces one payload budget across all runtime logs", async () => {
    const previous = process.env[RUNTIME_LOG_MAX_BYTES_ENV_VAR];
    process.env[RUNTIME_LOG_MAX_BYTES_ENV_VAR] = "10";
    try {
      const result = await run(
        Effect.gen(function* () {
          const manager = yield* UnifiedExec;
          const sessions = [];
          for (const command of ["printf 12345678", "printf abcdefgh"]) {
            const { session } = yield* manager.launch(spawnOptions(command));
            expect(yield* session.awaitExit(2_000)).toBe(true);
            expect(yield* session.awaitOutputClosed(2_000)).toBe(true);
            sessions.push(session);
          }
          return sessions.map((session) => ({
            log: readFileSync(session.logPath, "utf8"),
            status: session.logSnapshot,
          }));
        }),
      );

      expect(result.map((entry) => entry.log).join("")).toHaveLength(10);
      expect(result[1]!.status).toMatchObject({ status: "capped", bytesDropped: 6 });
    } finally {
      if (previous === undefined) delete process.env[RUNTIME_LOG_MAX_BYTES_ENV_VAR];
      else process.env[RUNTIME_LOG_MAX_BYTES_ENV_VAR] = previous;
    }
  });

  it("removes its runtime log directory during scoped shutdown", async () => {
    const logDirectory = await run(
      Effect.gen(function* () {
        const manager = yield* UnifiedExec;
        const { session } = yield* manager.launch(spawnOptions("printf cleanup"));
        expect(yield* session.awaitExit(2_000)).toBe(true);
        return dirname(session.logPath);
      }),
    );

    expect(existsSync(logDirectory)).toBe(false);
  });

  it("terminates all owned processes during shutdown", async () => {
    const exited = await run(
      Effect.gen(function* () {
        const manager = yield* UnifiedExec;
        const { session } = yield* manager.launch(spawnOptions("sleep 30"));
        const owned = yield* manager.shutdown;
        return {
          count: owned.length,
          exited: yield* session.awaitExit(2_000),
        };
      }),
    );

    expect(exited).toEqual({ count: 1, exited: true });
  });
});
