import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { decode } from "./protocol.js";
import { UnifiedExec, UnifiedExecLive } from "./service.js";

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
        return { output: decode(output), state: session.snapshotState() };
      }),
    );

    expect(result.output).toBe("effect-ok");
    expect(result.state).toMatchObject({ hasExited: true, exitCode: 0 });
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
        return decode(output);
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
        return chunks.map(decode).join("");
      }),
    );

    expect(output).toContain("first:one");
    expect(output).toContain("second:two");
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
    expect(result.exited).toMatchObject([{ phase: "exited" }]);
    expect(result.phases).toContain("empty");
    expect(result.phases).toContain("running");
    expect(result.phases).toContain("stopping");
    expect(result.phases).toContain("exited");
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
