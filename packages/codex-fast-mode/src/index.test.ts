import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import codexFastMode from "./index.js";

const GLOBAL_STATE_KEY = Symbol.for("@pi-extensions/codex-fast-mode:state");

type Handler = (...args: any[]) => unknown;

function createHarness() {
  const handlers = new Map<string, Handler[]>();
  const events = new Map<string, Handler[]>();
  const emitted: Array<{ name: string; data: unknown }> = [];
  let fastCommand: Handler | undefined;

  const pi = {
    events: {
      emit(name: string, data: unknown) {
        emitted.push({ name, data });
        for (const handler of events.get(name) ?? []) handler(data);
      },
      on(name: string, handler: Handler) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    },
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: { handler: Handler }) {
      if (name === "fast") fastCommand = command.handler;
    },
  } as unknown as ExtensionAPI;

  codexFastMode(pi);

  return {
    emitted,
    emit(name: string, ...args: unknown[]) {
      return handlers.get(name)?.map((handler) => handler(...args));
    },
    runFast(ctx: unknown) {
      if (!fastCommand) throw new Error("fast command was not registered");
      return fastCommand("", ctx);
    },
  };
}

function createContext() {
  return {
    model: { provider: "openai-codex" },
    modelRegistry: { isUsingOAuth: () => true },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  };
}

describe.sequential("codex-fast-mode global state", () => {
  beforeEach(() => {
    delete (globalThis as unknown as Record<symbol, unknown>)[GLOBAL_STATE_KEY];
  });

  it("shares toggles across extension instances and can globally disable them again", async () => {
    const first = createHarness();
    const second = createHarness();
    const ctx = createContext();

    await first.runFast(ctx);
    expect(second.emit("before_provider_request", { payload: { input: "child" } }, ctx)).toEqual([
      { input: "child", service_tier: "priority" },
    ]);

    await first.runFast(ctx);
    expect(second.emit("before_provider_request", { payload: { input: "child" } }, ctx)).toEqual([
      undefined,
    ]);
  });

  it("shows and publishes the current state when a new instance starts", async () => {
    const first = createHarness();
    await first.runFast(createContext());

    const second = createHarness();
    const ctx = createContext();
    second.emit("session_start", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("codex-fast-mode", "fast");
    expect(second.emitted).toContainEqual({
      name: "codex-fast-mode:state",
      data: { enabled: true },
    });
  });
});
