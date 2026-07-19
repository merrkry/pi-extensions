import {
  CustomEditor,
  type ContextUsage,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";

import { formatHomePath } from "../shared/display-path.js";
import { FastMode } from "../shared/fast-mode.js";
import { sanitizeTerminalOutput } from "../shared/sanitize-terminal.js";
import { UnifiedExec } from "../unified-exec/service.js";

const EDITOR_INSET = 1;
const EDITOR_INSET_TEXT = " ".repeat(EDITOR_INSET);
const PROCESS_WIDGET_KEY = "better-tui-chrome-processes";

type ThinkingLevel = Parameters<Theme["getThinkingBorderColor"]>[0];
const THINKING_LEVEL_VALUES = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];
const THINKING_LEVELS = new Set<unknown>(THINKING_LEVEL_VALUES);

function blankLine(width: number): string {
  return " ".repeat(Math.max(0, width));
}

function fitToWidth(line: string, width: number): string {
  return truncateToWidth(line, width, "", true);
}

function sanitizeStatusText(text: unknown): string {
  return sanitizeTerminalOutput(typeof text === "string" ? text : "")
    .replace(/\s+/g, " ")
    .trim();
}

function addEditorInset(line: string, width: number): string {
  const insetWidth = EDITOR_INSET * 2;
  if (width <= insetWidth) return blankLine(width);

  return EDITOR_INSET_TEXT + fitToWidth(line, width - insetWidth) + EDITOR_INSET_TEXT;
}

function wrapEditorLine(line: string): string {
  // CustomEditor already constrains every rendered line to the width it receives.
  // Adding the reserved outer columns does not need another ANSI/grapheme scan.
  return EDITOR_INSET_TEXT + line + EDITOR_INSET_TEXT;
}

function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "?";
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatContextWindow(contextWindow: number): string {
  return contextWindow > 0 ? formatTokens(contextWindow) : "?";
}

export function contextInfo(
  usage: ContextUsage | undefined,
  model: { contextWindow?: number } | undefined,
): {
  text: string;
  percent: number;
  known: boolean;
} {
  const rawContextWindow = usage?.contextWindow ?? model?.contextWindow;
  const contextWindow =
    typeof rawContextWindow === "number" && Number.isFinite(rawContextWindow)
      ? rawContextWindow
      : 0;
  const tokens = usage?.tokens;
  const percent = usage?.percent;

  if (
    !usage ||
    typeof tokens !== "number" ||
    !Number.isFinite(tokens) ||
    typeof percent !== "number" ||
    !Number.isFinite(percent)
  ) {
    return { text: `?/${formatContextWindow(contextWindow)}`, percent: 0, known: false };
  }

  return {
    text: `${percent.toFixed(1)}%/${formatContextWindow(contextWindow)}`,
    percent,
    known: true,
  };
}

function renderStatusLine(width: number, left: string, right: string, ellipsis: string): string {
  if (width <= 0) return "";

  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);

  if (leftWidth + 1 + rightWidth <= width) {
    return left + " ".repeat(width - leftWidth - rightWidth) + right;
  }

  const availableForRight = width - leftWidth - 1;
  if (availableForRight > 0) {
    const truncatedRight = truncateToWidth(right, availableForRight, ellipsis);
    return left + " " + truncatedRight;
  }

  return truncateToWidth(left, width, ellipsis);
}

function normalizeThinkingLevel(level: unknown): ThinkingLevel {
  return THINKING_LEVELS.has(level) ? (level as ThinkingLevel) : "off";
}

function editorBorderColor(
  theme: Theme,
  thinkingLevel: unknown,
  text: string,
): (str: string) => string {
  if (text.trimStart().startsWith("!")) return theme.getBashModeBorderColor();
  return theme.getThinkingBorderColor(normalizeThinkingLevel(thinkingLevel));
}

function contextStatusColor(context: { known: boolean; percent: number }): ThemeColor {
  if (!context.known) return "dim";
  if (context.percent > 90) return "error";
  if (context.percent > 70) return "warning";
  return "dim";
}

type FooterModel = { contextWindow?: number; id?: string } | undefined;

function renderFooterLine(
  width: number,
  ctx: FooterContext,
  footerData: ReadonlyFooterDataProvider,
  theme: Theme,
  thinkingLevel: unknown,
  usage: ContextUsage | undefined,
  fastModeEnabled: boolean,
): string {
  const innerWidth = width - EDITOR_INSET * 2;
  if (innerWidth <= 0) return blankLine(width);

  const currentModel = ctx.getModel();
  const model = sanitizeStatusText(currentModel?.id || "no-model");
  const reasoning = sanitizeStatusText(String(thinkingLevel));
  const context = contextInfo(usage, currentModel);
  const branch = footerData.getGitBranch();
  const cwdText = sanitizeStatusText(formatHomePath(ctx.cwd));
  const rightText =
    typeof branch === "string" && branch ? `${cwdText} • ${sanitizeStatusText(branch)}` : cwdText;

  const fastMode = fastModeEnabled ? theme.fg("dim", "fast • ") : "";
  const left =
    theme.fg("dim", `${model} • `) +
    fastMode +
    theme.fg("dim", `${reasoning} • `) +
    theme.fg(contextStatusColor(context), context.text);
  const right = theme.fg("dim", rightText);

  return addEditorInset(renderStatusLine(innerWidth, left, right, theme.fg("dim", "...")), width);
}

type FooterContext = {
  cwd: string;
  getContextUsage(): ContextUsage | undefined;
  getModel(): FooterModel;
};

class InsetEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly resolveBorderColor: (text: string) => (str: string) => string,
  ) {
    // Keep the editor's own content flush; this extension adds the outer inset.
    super(tui, theme, keybindings, { paddingX: 0 });
    this.refreshBorderColor();
  }

  refreshBorderColor(): void {
    this.borderColor = this.resolveBorderColor(this.getText());
  }

  requestChromeRender(): void {
    this.refreshBorderColor();
    this.tui.requestRender();
  }

  override setPaddingX(_padding: number): void {
    // Pi copies the default editor padding into custom editors after construction.
    // Keep this editor flush; the outer inset below is the only horizontal padding.
    if (this.getPaddingX() !== 0) super.setPaddingX(0);
  }

  override render(width: number): string[] {
    const insetWidth = EDITOR_INSET * 2;
    if (width <= 0) return [""];

    this.refreshBorderColor();
    if (width <= insetWidth) return super.render(width);

    return super.render(width - insetWidth).map(wrapEditorLine);
  }
}

class ChromeFooter implements Component {
  private cachedRender:
    | {
        signature: string;
        line: string;
      }
    | undefined;
  private cachedContextUsage: ContextUsage | undefined;
  private hasCachedContextUsage = false;
  private disposed = false;
  private readonly unsubscribeBranch: () => void;

  constructor(
    private readonly tui: TUI,
    private readonly ctx: FooterContext,
    private readonly footerData: ReadonlyFooterDataProvider,
    private readonly theme: Theme,
    private readonly getThinkingLevel: () => unknown,
    private readonly getFastModeEnabled: () => boolean,
    private readonly onDispose: (footer: ChromeFooter) => void,
  ) {
    this.unsubscribeBranch = footerData.onBranchChange(() => {
      this.invalidateRender();
      this.requestRender();
    });
  }

  dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    this.unsubscribeBranch();
    this.onDispose(this);
  }

  invalidate(): void {
    this.invalidateRender();
  }

  invalidateContextUsage(): void {
    this.hasCachedContextUsage = false;
    this.cachedContextUsage = undefined;
    this.invalidateRender();
  }

  requestRender(): void {
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const usage = this.getContextUsage();
    const thinkingLevel = this.getThinkingLevel();
    const fastModeEnabled = this.getFastModeEnabled();
    const model = this.ctx.getModel();
    const branch = this.footerData.getGitBranch();
    const signature = [
      width,
      this.ctx.cwd,
      model?.id ?? "",
      model?.contextWindow ?? "",
      String(thinkingLevel),
      fastModeEnabled,
      usage?.tokens ?? "",
      usage?.percent ?? "",
      usage?.contextWindow ?? "",
      branch ?? "",
    ].join("\0");

    if (this.cachedRender?.signature === signature) return [this.cachedRender.line];

    const line = renderFooterLine(
      width,
      this.ctx,
      this.footerData,
      this.theme,
      thinkingLevel,
      usage,
      fastModeEnabled,
    );
    this.cachedRender = { signature, line };
    return [line];
  }

  private getContextUsage(): ContextUsage | undefined {
    if (!this.hasCachedContextUsage) {
      this.cachedContextUsage = this.ctx.getContextUsage();
      this.hasCachedContextUsage = true;
    }

    return this.cachedContextUsage;
  }

  private invalidateRender(): void {
    this.cachedRender = undefined;
  }
}

export default function installBetterTuiChrome(
  pi: ExtensionAPI,
): Effect.Effect<void, never, FastMode | UnifiedExec> {
  return Effect.gen(function* () {
    const fastMode = yield* FastMode;
    const processes = yield* UnifiedExec;
    let currentEditor: InsetEditor | undefined;
    let currentFooter: ChromeFooter | undefined;
    let currentModel: FooterModel;
    let fastModeEnabled = fastMode.enabled;
    let unsubscribeFastMode: (() => void) | undefined;
    let unsubscribeProcesses: (() => void) | undefined;
    let currentContext: ExtensionContext | undefined;
    let activeProcessCount = 0;
    let agentRunning = false;

    function processLabel(): string {
      const noun = activeProcessCount === 1 ? "process" : "processes";
      return `${activeProcessCount} ${noun} running`;
    }

    function updateProcessChrome(): void {
      const ctx = currentContext;
      if (!ctx || ctx.mode !== "tui") return;
      ctx.ui.setWorkingMessage(
        activeProcessCount > 0 ? `Working... · ${processLabel()}` : undefined,
      );
      if (agentRunning || activeProcessCount === 0) {
        ctx.ui.setWidget(PROCESS_WIDGET_KEY, undefined);
        return;
      }
      const label = processLabel();
      ctx.ui.setWidget(PROCESS_WIDGET_KEY, (_tui, theme) => ({
        render: (width) => [
          truncateToWidth(
            ` ${theme.fg("accent", "·")} ${theme.fg("muted", label)}`,
            width,
            theme.fg("dim", "..."),
          ),
        ],
        invalidate() {},
      }));
    }

    function invalidateFooterContextUsage(): void {
      currentFooter?.invalidateContextUsage();
    }

    function requestChromeRender(): void {
      if (currentEditor) {
        currentEditor.requestChromeRender();
        return;
      }

      currentFooter?.requestRender();
    }

    pi.on("thinking_level_select", () => {
      requestChromeRender();
    });

    pi.on("model_select", (event) => {
      currentModel = event.model;
      invalidateFooterContextUsage();
      requestChromeRender();
    });

    pi.on("agent_start", () => {
      agentRunning = true;
      updateProcessChrome();
      invalidateFooterContextUsage();
      requestChromeRender();
    });

    pi.on("agent_end", () => {
      agentRunning = false;
      updateProcessChrome();
    });

    pi.on("turn_start", () => {
      invalidateFooterContextUsage();
      requestChromeRender();
    });

    pi.on("turn_end", () => {
      invalidateFooterContextUsage();
      requestChromeRender();
    });

    pi.on("message_end", () => {
      invalidateFooterContextUsage();
      requestChromeRender();
    });

    pi.on("session_compact", () => {
      invalidateFooterContextUsage();
      requestChromeRender();
    });

    pi.on("session_shutdown", (_event, ctx) => {
      unsubscribeFastMode?.();
      unsubscribeFastMode = undefined;
      unsubscribeProcesses?.();
      unsubscribeProcesses = undefined;

      if (ctx.mode === "tui") {
        ctx.ui.setWorkingMessage();
        ctx.ui.setWidget(PROCESS_WIDGET_KEY, undefined);
        ctx.ui.setEditorComponent(undefined);
        ctx.ui.setFooter(undefined);
      }

      currentContext = undefined;
      currentEditor = undefined;
      currentFooter = undefined;
      currentModel = undefined;
      activeProcessCount = 0;
      agentRunning = false;
    });

    pi.on("session_start", (_event, ctx) => {
      currentModel = ctx.model;

      if (ctx.mode !== "tui") return;

      currentContext = ctx;
      agentRunning = false;
      unsubscribeProcesses?.();
      unsubscribeProcesses = Effect.runSync(
        processes.subscribe((sessions) => {
          activeProcessCount = sessions.filter((session) => session.phase !== "exited").length;
          updateProcessChrome();
        }),
      );
      fastModeEnabled = fastMode.enabled;
      unsubscribeFastMode?.();
      unsubscribeFastMode = fastMode.subscribe((enabled) => {
        if (enabled === fastModeEnabled) return;
        fastModeEnabled = enabled;
        currentFooter?.invalidate();
        requestChromeRender();
      });

      const footerContext: FooterContext = {
        cwd: ctx.cwd,
        getContextUsage: () => ctx.getContextUsage(),
        getModel: () => currentModel,
      };

      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        currentEditor = new InsetEditor(tui, theme, keybindings, (text) =>
          editorBorderColor(ctx.ui.theme, pi.getThinkingLevel(), text),
        );
        return currentEditor;
      });

      ctx.ui.setFooter((tui, theme, footerData) => {
        const footer = new ChromeFooter(
          tui,
          footerContext,
          footerData,
          theme,
          () => pi.getThinkingLevel(),
          () => fastModeEnabled,
          (disposed) => {
            if (currentFooter === disposed) currentFooter = undefined;
          },
        );
        currentFooter = footer;
        return footer;
      });
      updateProcessChrome();
    });
  });
}
