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
import { sanitizeTerminalOutput, type TerminalSafeText } from "../shared/sanitize-terminal.js";
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

interface ResultRenderModel {
  readonly output: TerminalSafeText;
  readonly wallTime: number | undefined;
  readonly sessionId: number | undefined;
  readonly exitCode: number | undefined;
  readonly signal: TerminalSafeText | undefined;
  readonly failure: TerminalSafeText | undefined;
  readonly logPath: TerminalSafeText | undefined;
  readonly logStatus: TerminalSafeText | undefined;
  readonly captureOmittedBytes: number | undefined;
  readonly truncation?: {
    readonly truncatedBy?: unknown;
    readonly outputLines: number | undefined;
    readonly totalLines: number | undefined;
    readonly maxBytes: number | undefined;
  };
}

class ExecCallComponent implements Component {
  private args: ExecCommandArgs = { cmd: "" };
  private theme!: Theme;
  private cwd = "";
  private expanded = false;

  update(args: unknown, theme: Theme, cwd: unknown, expanded: unknown): void {
    this.args = asRecord(args) ? (args as ExecCommandArgs) : { cmd: "" };
    this.theme = theme;
    this.cwd = typeof cwd === "string" ? cwd : "";
    this.expanded = expanded === true;
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
  private model: ResultRenderModel = {
    output: sanitizeTerminalOutput(""),
    wallTime: undefined,
    sessionId: undefined,
    exitCode: undefined,
    signal: undefined,
    failure: undefined,
    logPath: undefined,
    logStatus: undefined,
    captureOmittedBytes: undefined,
  };
  private options: ToolRenderResultOptions = { expanded: false, isPartial: false };
  private theme!: Theme;

  update(result: unknown, options: ToolRenderResultOptions, theme: Theme): void {
    this.model = parseResultRenderModel(result);
    this.options = options;
    this.theme = theme;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const { output } = this.model;
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

    const warning = truncationWarning(this.model);
    if (warning) lines.push("", truncateToWidth(this.theme.fg("warning", warning), width, "..."));

    const status = statusLine(this.model, this.options, this.theme);
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
  model: ResultRenderModel,
  options: ToolRenderResultOptions,
  theme: Theme,
): string | undefined {
  const fields: string[] = [];
  const { wallTime, sessionId, exitCode } = model;
  if (wallTime !== undefined) {
    const timeLabel = options.isPartial ? "elapsed" : sessionId === undefined ? "took" : "yielded";
    fields.push(`${timeLabel} ${wallTime.toFixed(1)}s`);
  }
  if (sessionId !== undefined) {
    fields.push(`session ${sessionId}`);
  } else if (exitCode !== undefined) {
    fields.push(exitCode === 0 ? `exit ${exitCode}` : theme.fg("error", `exit ${exitCode}`));
  } else {
    if (model.signal) fields.push(theme.fg("error", model.signal));
  }
  if (model.failure) {
    fields.push(theme.fg("error", model.failure));
  }
  if (model.logPath) {
    const status = model.logStatus && model.logStatus !== "complete" ? ` (${model.logStatus})` : "";
    fields.push(`log ${formatHomePath(model.logPath)}${status}`);
  }
  return fields.length > 0 ? theme.fg("muted", fields.join(" · ")) : undefined;
}

function truncationWarning(model: ResultRenderModel): string | undefined {
  const warnings: string[] = [];
  if (model.captureOmittedBytes !== undefined && model.captureOmittedBytes > 0) {
    warnings.push(
      `Output capture omitted ${formatSize(model.captureOmittedBytes)} before its retained tail`,
    );
  }

  const { truncation } = model;
  if (truncation) {
    const { outputLines, totalLines } = truncation;
    if (
      truncation.truncatedBy === "lines" &&
      outputLines !== undefined &&
      totalLines !== undefined
    ) {
      warnings.push(`Response then shows ${outputLines} of ${totalLines} retained lines`);
    } else {
      const maximum = truncation.maxBytes ?? DEFAULT_MAX_BYTES;
      const shown =
        outputLines === undefined
          ? "Output truncated"
          : `Response then truncated to ${outputLines} retained lines`;
      warnings.push(`${shown} (${formatSize(maximum)} limit)`);
    }
  }

  if (warnings.length === 0) return undefined;
  const log = model.logPath ? `. Bounded output log: ${model.logPath}` : "";
  return `[${warnings.join("; ")}${log}]`;
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

function parseResultRenderModel(value: unknown): ResultRenderModel {
  const result = asRecord(value);
  const details = asRecord(result?.["details"]);
  const truncation = asRecord(details?.["truncation"]);
  const captureTruncation = asRecord(details?.["capture_truncation"]);
  const rawOutput = stringField(details, "output") ?? textContent(result);
  return {
    output: sanitizeTerminalOutput(rawOutput),
    wallTime: finiteNumberField(details, "wall_time_seconds"),
    sessionId: finiteNumberField(details, "session_id"),
    exitCode: finiteNumberField(details, "exit_code"),
    signal: safeStringField(details, "signal"),
    failure: safeStringField(details, "failure_message"),
    logPath: safeStringField(details, "log_path"),
    logStatus: safeStringField(details, "log_status"),
    captureOmittedBytes: finiteNumberField(captureTruncation, "omittedBytes"),
    ...(truncation?.["truncated"] === true
      ? {
          truncation: {
            truncatedBy: truncation["truncatedBy"],
            outputLines: finiteNumberField(truncation, "outputLines"),
            totalLines: finiteNumberField(truncation, "totalLines"),
            maxBytes: finiteNumberField(truncation, "maxBytes"),
          },
        }
      : {}),
  };
}

function textContent(result: Record<string, unknown> | undefined): string {
  const content = result?.["content"];
  if (!Array.isArray(content)) return "";
  const first = asRecord(content[0]);
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

function safeStringField(
  record: Record<string, unknown> | undefined,
  key: string,
): TerminalSafeText | undefined {
  const value = stringField(record, key);
  return value === undefined ? undefined : sanitizeTerminalOutput(value);
}

function finiteNumberField(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
