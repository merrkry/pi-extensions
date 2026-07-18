import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createFastModeStore, type FastModeStore } from "../shared/fast-mode.js";
import installCodexFastMode from "./install.js";

type Handler = (...args: any[]) => unknown;

function createHarness(fastMode: FastModeStore) {
  const handlers = new Map<string, Handler[]>();
  let fastCommand: Handler | undefined;
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: { handler: Handler }) {
      if (name === "fast") fastCommand = command.handler;
    },
  } as unknown as ExtensionAPI;

  installCodexFastMode(pi, fastMode);

  return {
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

describe("codex-fast-mode", () => {
  it("shares toggles across installers and can globally disable them again", async () => {
    const fastMode = createFastModeStore();
    const first = createHarness(fastMode);
    const second = createHarness(fastMode);
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

  it("shows the current state when a new session starts", async () => {
    const fastMode = createFastModeStore();
    const first = createHarness(fastMode);
    await first.runFast(createContext());

    const second = createHarness(fastMode);
    const ctx = createContext();
    second.emit("session_start", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("codex-fast-mode", "fast");
  });
});
