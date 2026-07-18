import {
  DEFAULT_MAX_BYTES,
  formatSize,
  keyHint,
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import { formatHomePath } from "../shared/display-path.js";
import { sanitizeTerminalOutput } from "../shared/sanitize-terminal.js";
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
    const rawCommand = typeof this.args.cmd === "string" ? this.args.cmd : "";
    const command = sanitizeTerminalOutput(rawCommand) || "...";
    const styled = this.theme.fg("toolTitle", this.theme.bold(`$ ${command}`));
    const commandLines = new Text(styled, 0, 0).render(width);
    const visibleCommand = this.expanded
      ? headWithHardLimit(commandLines, COMMAND_EXPANDED_LINES, width, this.theme)
      : headWithExpansionHint(commandLines, COMMAND_PREVIEW_LINES, width, this.theme);
    const requestedCwd =
      typeof this.args.workdir === "string" ? this.args.workdir.trim() : undefined;
    const effectiveCwd = sanitizeTerminalOutput(requestedCwd || this.cwd);
    const cwdLine = truncateToWidth(
      this.theme.fg("muted", `cwd  ${formatHomePath(effectiveCwd)}`),
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
    const details = asRecord(this.result?.details);
    const output = sanitizeTerminalOutput(
      stringField(details, "output") ?? (this.result ? textContent(this.result) : ""),
    );
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

    const status = details ? statusLine(details, this.options, this.theme) : undefined;
    if (status) {
      lines.push("", truncateToWidth(status, width, "..."));
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
  details: Record<string, unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): string | undefined {
  const fields: string[] = [];
  const wallTime = finiteNumberField(details, "wall_time_seconds");
  const sessionId = finiteNumberField(details, "session_id");
  const exitCode = finiteNumberField(details, "exit_code");
  if (wallTime !== undefined) {
    const timeLabel = options.isPartial ? "elapsed" : sessionId === undefined ? "took" : "yielded";
    fields.push(`${timeLabel} ${wallTime.toFixed(1)}s`);
  }
  if (sessionId !== undefined) {
    fields.push(`session ${sessionId}`);
  } else if (exitCode !== undefined) {
    fields.push(exitCode === 0 ? `exit ${exitCode}` : theme.fg("error", `exit ${exitCode}`));
  } else {
    const signal = stringField(details, "signal");
    if (signal) fields.push(theme.fg("error", sanitizeTerminalOutput(signal)));
  }
  const failure = stringField(details, "failure_message");
  if (failure) {
    fields.push(theme.fg("error", sanitizeTerminalOutput(failure)));
  }
  const logPath = stringField(details, "log_path");
  if (logPath) {
    fields.push(`log ${formatHomePath(sanitizeTerminalOutput(logPath))}`);
  }
  return fields.length > 0 ? theme.fg("muted", fields.join(" · ")) : undefined;
}

function truncationWarning(details: Record<string, unknown>): string | undefined {
  const truncation = asRecord(details["truncation"]);
  if (truncation?.["truncated"] !== true) return undefined;
  const logPath = stringField(details, "log_path");
  const log = logPath ? `. Full output: ${sanitizeTerminalOutput(logPath)}` : "";
  const outputLines = finiteNumberField(truncation, "outputLines");
  const totalLines = finiteNumberField(truncation, "totalLines");
  if (
    truncation["truncatedBy"] === "lines" &&
    outputLines !== undefined &&
    totalLines !== undefined
  ) {
    return `[Truncated: showing ${outputLines} of ${totalLines} lines${log}]`;
  }
  const maximum = finiteNumberField(truncation, "maxBytes") ?? DEFAULT_MAX_BYTES;
  const shown =
    outputLines === undefined ? "Output truncated" : `Truncated: ${outputLines} lines shown`;
  return `[${shown} (${formatSize(maximum)} limit)${log}]`;
}

function describeWrite(args: WriteStdinArgs): string | undefined {
  if (args.chars && args.chars.length > 0) return visibleInput(args.chars);
  if (args.chars_b64 && args.chars_b64.length > 0) {
    return `base64 (${base64ByteLength(args.chars_b64)} bytes)`;
  }
  return undefined;
}

function visibleInput(input: string): string {
  const visible = sanitizeTerminalOutput(
    input
      .split("\u0003")
      .join("^C")
      .split("\u0004")
      .join("^D")
      .split("\u001b")
      .join("^[")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t"),
  );
  return visible.length <= 40 ? visible : `${visible.slice(0, 37)}...`;
}

function base64ByteLength(base64: string): number {
  const compact = base64.replace(/\s+/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function textContent(result: AgentToolResult<unknown>): string {
  if (!Array.isArray(result.content)) return "";
  const first = asRecord(result.content[0]);
  return first?.["type"] === "text" && typeof first["text"] === "string" ? first["text"] : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function finiteNumberField(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
