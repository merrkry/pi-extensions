import {
  CustomEditor,
  type ContextUsage,
  type ExtensionAPI,
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
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { FastModeStore } from "../shared/fast-mode.js";

const EDITOR_INSET = 1;
const EDITOR_INSET_TEXT = " ".repeat(EDITOR_INSET);

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

const CONTROL_CHAR_PATTERN = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f]`, "g");

function sanitizeStatusText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(CONTROL_CHAR_PATTERN, " ")
    .replace(/ +/g, " ")
    .trim();
}

function addEditorInset(line: string, width: number): string {
  const insetWidth = EDITOR_INSET * 2;
  if (width <= insetWidth) return blankLine(width);

  return EDITOR_INSET_TEXT + fitToWidth(line, width - insetWidth) + EDITOR_INSET_TEXT;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  if (!home) return cwd;

  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));

  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function formatContextWindow(contextWindow: number): string {
  return contextWindow > 0 ? formatTokens(contextWindow) : "?";
}

function contextInfo(
  usage: ContextUsage | undefined,
  model: { contextWindow?: number } | undefined,
): {
  text: string;
  percent: number;
  known: boolean;
} {
  const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;

  if (!usage || usage.tokens === null || usage.percent === null) {
    return { text: `?/${formatContextWindow(contextWindow)}`, percent: 0, known: false };
  }

  return {
    text: `${usage.percent.toFixed(1)}%/${formatContextWindow(contextWindow)}`,
    percent: usage.percent,
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
  const cwdText = sanitizeStatusText(formatCwd(ctx.cwd));
  const rightText = branch ? `${cwdText} • ${sanitizeStatusText(branch)}` : cwdText;

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

    return super.render(width - insetWidth).map((line) => addEditorInset(line, width));
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

export default function installBetterTuiChrome(pi: ExtensionAPI, fastMode: FastModeStore): void {
  let currentEditor: InsetEditor | undefined;
  let currentFooter: ChromeFooter | undefined;
  let currentModel: FooterModel;
  let fastModeEnabled = fastMode.enabled;
  let unsubscribeFastMode: (() => void) | undefined;

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
    invalidateFooterContextUsage();
    requestChromeRender();
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

    if (ctx.mode === "tui") {
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setFooter(undefined);
    }

    currentEditor = undefined;
    currentFooter = undefined;
    currentModel = undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    currentModel = ctx.model;

    if (ctx.mode !== "tui") return;

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
  });
}
