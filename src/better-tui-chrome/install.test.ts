import {
  type ContextUsage,
  type ExtensionAPI,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it, vi } from "vitest";

import { FastMode, type FastModeApi } from "../shared/fast-mode.js";
import { UnifiedExec, type SessionSnapshot, type UnifiedExecApi } from "../unified-exec/service.js";
import installBetterTuiChrome, { contextInfo } from "./install.js";

type Handler = (...args: any[]) => unknown;
const identity = (text: string) => text;

describe("better-tui-chrome fast-mode coordination", () => {
  it("treats incomplete runtime usage data as unknown instead of throwing", () => {
    const incomplete = {
      tokens: undefined,
      percent: undefined,
      contextWindow: undefined,
    } as unknown as ContextUsage;

    expect(() => contextInfo(incomplete, undefined)).not.toThrow();
    expect(contextInfo(incomplete, undefined)).toEqual({
      text: "?/?",
      percent: 0,
      known: false,
    });
  });

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

  it("renders session-scoped chrome through Pi 0.84's stable TUI reference", () => {
    const handlers = new Map<string, Handler[]>();
    const fastMode = {
      enabled: false,
      setEnabled: vi.fn(),
      toggle: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    } as FastModeApi;
    const processes = {
      subscribe: vi.fn(() => Effect.succeed(vi.fn())),
    } as unknown as UnifiedExecApi;
    const pi = {
      on(name: string, handler: Handler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    } as unknown as ExtensionAPI;
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: identity,
      getBashModeBorderColor: () => identity,
      getThinkingBorderColor: () => identity,
    } as unknown as Theme;
    let thinkingLevel = "low";
    const regularRequestRender = vi.fn();
    const fullscreenRequestRender = vi.fn();
    const terminal = { rows: 24, columns: 80 };
    let activeRenderer: {
      mode: "regular" | "fullscreen";
      terminal: typeof terminal;
      requestRender: () => void;
    } = {
      mode: "regular",
      terminal,
      requestRender: regularRequestRender,
    };
    const tui = new Proxy({} as TUI, {
      get: (_target, property) => {
        const value = Reflect.get(activeRenderer, property, activeRenderer);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const renderer = activeRenderer;
          const method = Reflect.get(renderer, property, renderer) as (
            ...args: unknown[]
          ) => unknown;
          return method.apply(renderer, args);
        };
      },
    });
    const ctx = {
      mode: "tui",
      model: { id: "test-model", contextWindow: 200_000 },
      get thinkingLevel() {
        return thinkingLevel;
      },
      cwd: "/tmp/project",
      getContextUsage: () => ({ tokens: 50_000, percent: 25, contextWindow: 200_000 }),
      ui: {
        theme,
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

    const editorFactory = ctx.ui.setEditorComponent.mock.calls[0]?.[0];
    const footerFactory = ctx.ui.setFooter.mock.calls[0]?.[0];
    expect(editorFactory).toBeTypeOf("function");
    expect(footerFactory).toBeTypeOf("function");

    const editorTheme: EditorTheme = {
      borderColor: identity,
      selectList: {
        selectedPrefix: identity,
        selectedText: identity,
        description: identity,
        scrollInfo: identity,
        noMatch: identity,
      },
    };
    const keybindings = { matches: () => false } as unknown as KeybindingsManager;
    const editor = editorFactory?.(tui, editorTheme, keybindings);
    editor?.setText("hello fullscreen");
    expect(editor?.render(40).every((line: string) => visibleWidth(line) <= 40)).toBe(true);

    const footerData = {
      getGitBranch: () => "main",
      onBranchChange: () => vi.fn(),
    } as unknown as ReadonlyFooterDataProvider;
    const footer = footerFactory?.(tui, theme, footerData);
    expect(footer?.render(80)[0]).toContain("test-model");
    expect(footer?.render(80)[0]).toContain("low");

    activeRenderer = {
      mode: "fullscreen",
      terminal,
      requestRender: fullscreenRequestRender,
    };
    thinkingLevel = "high";
    handlers.get("thinking_level_select")?.[0]?.({ level: "high" });

    expect(tui.mode).toBe("fullscreen");
    const fullscreenLine = footer?.render(80)[0] ?? "";
    expect(fullscreenLine).toContain("high");
    expect(visibleWidth(fullscreenLine)).toBe(80);
    expect(fullscreenRequestRender).toHaveBeenCalled();
    expect(regularRequestRender).not.toHaveBeenCalled();
  });
});
