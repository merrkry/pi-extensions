import {
  DEFAULT_MAX_BYTES,
  formatSize,
  keyHint,
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import type { ExecCommandArgs, ResponseShape, WriteStdinArgs } from "./protocol.js";

export const COMMAND_PREVIEW_LINES = 4;
export const COMMAND_EXPANDED_LINES = 80;
export const OUTPUT_PREVIEW_LINES = 8;
export const OUTPUT_EXPANDED_LINES = 200;

interface RenderContext<TArgs> {
  readonly args: TArgs;
  readonly cwd: string;
  readonly expanded: boolean;
  readonly lastComponent: Component | undefined;
}

class ExecCallComponent implements Component {
  private args: ExecCommandArgs = { cmd: "" };
  private theme!: Theme;
  private cwd = "";
  private expanded = false;

  update(args: ExecCommandArgs, theme: Theme, cwd: string, expanded: boolean): void {
    this.args = args;
    this.theme = theme;
    this.cwd = cwd;
    this.expanded = expanded;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const command = this.args.cmd || "...";
    const styled = this.theme.fg("toolTitle", this.theme.bold(`$ ${command}`));
    const commandLines = new Text(styled, 0, 0).render(width);
    const visibleCommand = this.expanded
      ? headWithHardLimit(commandLines, COMMAND_EXPANDED_LINES, width, this.theme)
      : headWithExpansionHint(commandLines, COMMAND_PREVIEW_LINES, width, this.theme);
    const effectiveCwd = this.args.workdir?.trim() || this.cwd;
    const cwdLine = truncateToWidth(
      this.theme.fg("muted", `cwd  ${tildify(effectiveCwd)}`),
      width,
      "...",
    );
    return [...visibleCommand, cwdLine];
  }

  invalidate(): void {
    // Rendering is derived directly from the latest arguments, width, and theme.
  }
}

class ResultComponent implements Component {
  private result: AgentToolResult<ResponseShape> | undefined;
  private options: ToolRenderResultOptions = { expanded: false, isPartial: false };
  private theme!: Theme;

  update(
    result: AgentToolResult<ResponseShape>,
    options: ToolRenderResultOptions,
    theme: Theme,
  ): void {
    this.result = result;
    this.options = options;
    this.theme = theme;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const details = this.result?.details;
    const output = details?.output ?? (this.result ? textContent(this.result) : "");
    const lines: string[] = [];

    if (output) {
      const styled = output
        .split("\n")
        .map((line) => this.theme.fg("toolOutput", line))
        .join("\n");
      const visualLines = new Text(styled, 0, 0).render(width);
      lines.push("");
      lines.push(
        ...(this.options.expanded
          ? tailWithHardLimit(visualLines, OUTPUT_EXPANDED_LINES, width, this.theme)
          : tailWithExpansionHint(visualLines, OUTPUT_PREVIEW_LINES, width, this.theme)),
      );
    }

    const warning = details ? truncationWarning(details) : undefined;
    if (warning) lines.push("", truncateToWidth(this.theme.fg("warning", warning), width, "..."));

    if (details) {
      lines.push("", truncateToWidth(statusLine(details, this.options, this.theme), width, "..."));
    }
    return lines;
  }

  invalidate(): void {
    // Rendering is derived directly from the latest result, width, and theme.
  }
}

export function renderExecCommandCall(
  args: ExecCommandArgs,
  theme: Theme,
  context: RenderContext<ExecCommandArgs>,
): Component {
  const component =
    context.lastComponent instanceof ExecCallComponent
      ? context.lastComponent
      : new ExecCallComponent();
  component.update(args, theme, context.cwd, context.expanded);
  return component;
}

export function renderWriteStdinCall(
  args: WriteStdinArgs,
  theme: Theme,
  context: RenderContext<WriteStdinArgs>,
): Component {
  const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  const sessionId = args.session_id ?? "?";
  const payload = describeWrite(args);
  text.setText(
    payload === undefined
      ? theme.fg("muted", `poll  session ${sessionId}`)
      : `${theme.fg("toolTitle", theme.bold(`stdin  ${payload}`))}\n${theme.fg(
          "muted",
          `session ${sessionId}`,
        )}`,
  );
  return text;
}

export function renderResult(
  result: AgentToolResult<ResponseShape>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext<unknown>,
): Component {
  const component =
    context.lastComponent instanceof ResultComponent
      ? context.lastComponent
      : new ResultComponent();
  component.update(result, options, theme);
  return component;
}

function headWithExpansionHint(
  lines: readonly string[],
  maximum: number,
  width: number,
  theme: Theme,
): string[] {
  if (lines.length <= maximum) return [...lines];
  const hidden = lines.length - maximum;
  const hint =
    theme.fg("muted", `... (${hidden} later lines,`) +
    ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
  return [...lines.slice(0, maximum), truncateToWidth(hint, width, "...")];
}

function tailWithExpansionHint(
  lines: readonly string[],
  maximum: number,
  width: number,
  theme: Theme,
): string[] {
  if (lines.length <= maximum) return [...lines];
  const hidden = lines.length - maximum;
  const hint =
    theme.fg("muted", `... (${hidden} earlier lines,`) +
    ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
  return [truncateToWidth(hint, width, "..."), ...lines.slice(-maximum)];
}

function headWithHardLimit(
  lines: readonly string[],
  maximum: number,
  width: number,
  theme: Theme,
): string[] {
  if (lines.length <= maximum) return [...lines];
  return [...lines.slice(0, maximum), hardLimitHint("first", lines.length, maximum, width, theme)];
}

function tailWithHardLimit(
  lines: readonly string[],
  maximum: number,
  width: number,
  theme: Theme,
): string[] {
  if (lines.length <= maximum) return [...lines];
  return [hardLimitHint("last", lines.length, maximum, width, theme), ...lines.slice(-maximum)];
}

function hardLimitHint(
  retained: "first" | "last",
  total: number,
  maximum: number,
  width: number,
  theme: Theme,
): string {
  return truncateToWidth(
    theme.fg("muted", `[Display limit: showing ${retained} ${maximum} of ${total} visual lines]`),
    width,
    "...",
  );
}

function statusLine(
  details: ResponseShape,
  options: ToolRenderResultOptions,
  theme: Theme,
): string {
  const fields: string[] = [];
  const timeLabel = options.isPartial
    ? "elapsed"
    : details.session_id === undefined
      ? "took"
      : "yielded";
  fields.push(`${timeLabel} ${details.wall_time_seconds.toFixed(1)}s`);
  if (details.session_id !== undefined) {
    fields.push(`session ${details.session_id}`);
  } else if (details.exit_code !== undefined) {
    fields.push(
      details.exit_code === 0
        ? `exit ${details.exit_code}`
        : theme.fg("error", `exit ${details.exit_code}`),
    );
  } else if (details.signal) {
    fields.push(theme.fg("error", details.signal));
  }
  if (details.failure_message) fields.push(theme.fg("error", details.failure_message));
  if (details.log_path) fields.push(`log ${tildify(details.log_path)}`);
  return theme.fg("muted", fields.join(" · "));
}

function truncationWarning(details: ResponseShape): string | undefined {
  const truncation = details.truncation;
  if (!truncation?.truncated) return undefined;
  const log = details.log_path ? `. Full output: ${details.log_path}` : "";
  if (truncation.truncatedBy === "lines") {
    return `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines${log}]`;
  }
  return `[Truncated: ${truncation.outputLines} lines shown (${formatSize(
    truncation.maxBytes ?? DEFAULT_MAX_BYTES,
  )} limit)${log}]`;
}

function describeWrite(args: WriteStdinArgs): string | undefined {
  if (args.chars && args.chars.length > 0) return visibleInput(args.chars);
  if (args.chars_b64 && args.chars_b64.length > 0) {
    return `base64 (${base64ByteLength(args.chars_b64)} bytes)`;
  }
  return undefined;
}

function visibleInput(input: string): string {
  const visible = input
    .split("\u0003")
    .join("^C")
    .split("\u0004")
    .join("^D")
    .split("\u001b")
    .join("^[")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return visible.length <= 40 ? visible : `${visible.slice(0, 37)}...`;
}

function base64ByteLength(base64: string): number {
  const compact = base64.replace(/\s+/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function textContent(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

function tildify(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
