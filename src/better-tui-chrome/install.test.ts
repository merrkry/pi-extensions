import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it, vi } from "vitest";

import { FastMode, type FastModeApi } from "../shared/fast-mode.js";
import { UnifiedExec, type SessionSnapshot, type UnifiedExecApi } from "../unified-exec/service.js";
import installBetterTuiChrome from "./install.js";

type Handler = (...args: any[]) => unknown;

describe("better-tui-chrome fast-mode coordination", () => {
  it("subscribes only for TUI sessions and disposes on shutdown", () => {
    const handlers = new Map<string, Handler[]>();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const fastMode = {
      enabled: true,
      setEnabled: vi.fn(),
      toggle: vi.fn(),
      subscribe,
    } as FastModeApi;
    const processUnsubscribe = vi.fn();
    let inventoryListener: ((sessions: readonly SessionSnapshot[]) => void) | undefined;
    const processes = {
      subscribe: vi.fn((listener: (sessions: readonly SessionSnapshot[]) => void) =>
        Effect.sync(() => {
          inventoryListener = listener;
          listener([]);
          return processUnsubscribe;
        }),
      ),
    } as unknown as UnifiedExecApi;
    const pi = {
      on(name: string, handler: Handler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      getThinkingLevel: () => "off",
    } as unknown as ExtensionAPI;
    const ctx = {
      mode: "tui",
      model: undefined,
      cwd: "/tmp",
      ui: {
        setEditorComponent: vi.fn(),
        setFooter: vi.fn(),
        setWidget: vi.fn(),
        setWorkingMessage: vi.fn(),
      },
    };

    Effect.runSync(
      installBetterTuiChrome(pi).pipe(
        Effect.provide(
          Layer.merge(Layer.succeed(FastMode, fastMode), Layer.succeed(UnifiedExec, processes)),
        ),
      ),
    );
    handlers.get("session_start")?.[0]?.({}, ctx);
    expect(subscribe).toHaveBeenCalledOnce();

    inventoryListener?.([{ phase: "running" } as SessionSnapshot]);
    expect(ctx.ui.setWorkingMessage).toHaveBeenLastCalledWith("Working... · 1 process running");
    expect(ctx.ui.setWidget).not.toHaveBeenLastCalledWith("better-tui-chrome-processes", undefined);

    handlers.get("agent_start")?.[0]?.({});
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("better-tui-chrome-processes", undefined);

    handlers.get("session_shutdown")?.[0]?.({}, ctx);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(processUnsubscribe).toHaveBeenCalledOnce();
  });
});
