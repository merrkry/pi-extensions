import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vite-plus/test";
import { requestSlot } from "./src/deepseek-search/api.ts";

test("a request slot frees once the oldest start is more than one second old", async () => {
  const granted = await Effect.runPromise(
    Effect.gen(function* () {
      const slot = requestSlot(2);
      const times: number[] = [];
      const take = slot.pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.map((time) => times.push(time)),
      );
      yield* take;
      yield* TestClock.adjust(500);
      yield* take;
      const waiting = yield* Effect.forkChild(Effect.all([take, take]));
      yield* TestClock.adjust(1001);
      yield* Fiber.join(waiting);
      return times;
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(granted).toEqual([0, 500, 1001, 1501]);
});
