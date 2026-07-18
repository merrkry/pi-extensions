import * as ManagedRuntime from "effect/ManagedRuntime";
import { describe, expect, it, vi } from "vitest";

import { FastMode, FastModeLive } from "./fast-mode.js";

describe("FastMode service", () => {
  it("shares process-global state across layers and stops disposed subscriptions", async () => {
    const firstRuntime = ManagedRuntime.make(FastModeLive);
    const secondRuntime = ManagedRuntime.make(FastModeLive);
    const listener = vi.fn();

    try {
      const unsubscribe = await firstRuntime.runPromise(
        FastMode.useSync((fastMode) => {
          fastMode.setEnabled(false);
          return fastMode.subscribe(listener);
        }),
      );

      expect(
        await secondRuntime.runPromise(FastMode.useSync((fastMode) => fastMode.toggle())),
      ).toBe(true);
      expect(listener).toHaveBeenCalledWith(true);

      unsubscribe();
      await secondRuntime.runPromise(FastMode.useSync((fastMode) => fastMode.setEnabled(false)));
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all([firstRuntime.dispose(), secondRuntime.dispose()]);
    }
  });
});
