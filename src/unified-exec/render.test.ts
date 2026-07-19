import { initTheme, type AgentToolResult, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";

import { sanitizeTerminalOutput } from "../shared/sanitize-terminal.js";
import type { ExecCommandArgs, ResponseShape } from "./protocol.js";
import {
  COMMAND_EXPANDED_LINES,
  COMMAND_PREVIEW_LINES,
  OUTPUT_EXPANDED_LINES,
  OUTPUT_PREVIEW_LINES,
  renderExecCommandCall,
  renderResult,
} from "./render.js";

beforeAll(() => initTheme(undefined, false));

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const callContext = (args: ExecCommandArgs, expanded: boolean, lastComponent?: Component) => ({
  args,
  cwd: "/workspace/project",
  expanded,
  lastComponent,
});

const response = (output: string): ResponseShape => ({
  phase: "yielded",
  chunk_id: "test",
  wall_time_seconds: 1.25,
  output: sanitizeTerminalOutput(output),
  original_token_count: output.length,
  tty: false,
  session_id: 7,
  log_path: sanitizeTerminalOutput("/tmp/unified.log"),
  cwd: sanitizeTerminalOutput("/workspace/project"),
  command: sanitizeTerminalOutput("test"),
});

describe("unified-exec rendering", () => {
  it("caps a streaming command while keeping cwd on a stable separate line", () => {
    const args = {
      cmd: ["first", "second", "third", "fourth", "fifth", "sixth"].join("\n"),
    };
    const component = renderExecCommandCall(args, theme, callContext(args, false));
    const lines = component.render(80);

    expect(lines.at(-1)).toBe("cwd  /workspace/project");
    expect(lines.some((line) => line.includes("$ first"))).toBe(true);
    expect(lines.some((line) => line.includes("sixth"))).toBe(false);
    expect(lines.length).toBe(COMMAND_PREVIEW_LINES + 2);
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);

    const updated = { ...args, cmd: `${args.cmd}\nseventh` };
    const updatedLines = renderExecCommandCall(
      updated,
      theme,
      callContext(updated, false, component),
    ).render(80);
    expect(updatedLines.at(-1)).toBe("cwd  /workspace/project");
  });

  it("tolerates incomplete runtime call context", () => {
    const args = { cmd: "printf safe" };
    const context = {
      args,
      cwd: undefined,
      expanded: undefined,
      lastComponent: undefined,
    } as unknown as Parameters<typeof renderExecCommandCall>[2];

    const component = renderExecCommandCall(args, theme, context);

    expect(() => component.render(80)).not.toThrow();
    expect(component.render(80).some((line) => line.startsWith("cwd  "))).toBe(true);
  });

  it("uses the global tool expansion state for full command and output", () => {
    const args = {
      cmd: ["first", "second", "third", "fourth", "fifth", "sixth"].join("\n"),
    };
    const call = renderExecCommandCall(args, theme, callContext(args, true));
    expect(call.render(80).some((line) => line.includes("$ first"))).toBe(true);

    const output = Array.from(
      { length: 12 },
      (_, index) => `row-${String(index + 1).padStart(2, "0")}`,
    ).join("\n");
    const result: AgentToolResult<ResponseShape> = {
      content: [{ type: "text", text: output }],
      details: response(output),
    };
    const collapsed = renderResult(result, { expanded: false, isPartial: true }, theme, {
      args: {},
      cwd: "/workspace/project",
      expanded: false,
      lastComponent: undefined,
    });
    const collapsedLines = collapsed.render(80);
    expect(collapsedLines.some((line) => line.includes("row-01"))).toBe(false);
    expect(collapsedLines.some((line) => line.includes("row-12"))).toBe(true);
    expect(collapsedLines.filter((line) => line.includes("row-")).length).toBe(
      OUTPUT_PREVIEW_LINES,
    );

    const expanded = renderResult(result, { expanded: true, isPartial: false }, theme, {
      args: {},
      cwd: "/workspace/project",
      expanded: true,
      lastComponent: collapsed,
    });
    expect(expanded.render(80).some((line) => line.includes("row-01"))).toBe(true);
  });

  it("applies hard visual-line limits even when expanded", () => {
    const commandRows = Array.from(
      { length: COMMAND_EXPANDED_LINES + 20 },
      (_, index) => `command-${String(index + 1).padStart(3, "0")}`,
    );
    const args = { cmd: commandRows.join("\n") };
    const commandLines = renderExecCommandCall(args, theme, callContext(args, true)).render(80);
    expect(commandLines.some((line) => line.includes("$ command-001"))).toBe(true);
    expect(commandLines.some((line) => line.includes("command-100"))).toBe(false);
    expect(commandLines.some((line) => line.includes("Display limit"))).toBe(true);
    expect(commandLines.length).toBe(COMMAND_EXPANDED_LINES + 2);

    const outputRows = Array.from(
      { length: OUTPUT_EXPANDED_LINES + 20 },
      (_, index) => `output-${String(index + 1).padStart(3, "0")}`,
    );
    const output = outputRows.join("\n");
    const result: AgentToolResult<ResponseShape> = {
      content: [{ type: "text", text: output }],
      details: response(output),
    };
    const outputLines = renderResult(result, { expanded: true, isPartial: false }, theme, {
      args: {},
      cwd: "/workspace/project",
      expanded: true,
      lastComponent: undefined,
    }).render(80);
    expect(outputLines.some((line) => line.includes("output-001"))).toBe(false);
    expect(outputLines.some((line) => line.includes("output-220"))).toBe(true);
    expect(outputLines.some((line) => line.includes("Display limit"))).toBe(true);
    expect(outputLines.filter((line) => line.includes("output-")).length).toBe(
      OUTPUT_EXPANDED_LINES,
    );
  });

  it("does not pass process or command control sequences to the TUI", () => {
    const args = { cmd: "printf '\u001b[31mdanger\u001b[0m'\u0007" };
    const callLines = renderExecCommandCall(args, theme, callContext(args, false)).render(80);
    expect(callLines.join("\n")).toContain("danger");
    expect(["\u001b", "\u0007"].some((control) => callLines.join("\n").includes(control))).toBe(
      false,
    );

    const output = "before\u001b[2J\u001b]0;owned\u0007after\u0008";
    const result: AgentToolResult<ResponseShape> = {
      content: [{ type: "text", text: output }],
      details: response(output),
    };
    const rendered = renderResult(result, { expanded: false, isPartial: true }, theme, {
      args: {},
      cwd: "/workspace/project",
      expanded: false,
      lastComponent: undefined,
    })
      .render(80)
      .join("\n");

    expect(rendered).toContain("beforeafter");
    expect(["\u001b", "\u0007", "\u0008"].some((control) => rendered.includes(control))).toBe(
      false,
    );
    expect(rendered).not.toContain("owned");
  });

  it("combines capture and response truncation warnings", () => {
    const result = {
      content: [{ type: "text", text: "retained output" }],
      details: {
        ...response("retained output"),
        capture_truncation: { omittedBytes: 65_536 },
        truncation: {
          truncated: true,
          truncatedBy: "bytes",
          outputLines: 100,
          maxBytes: 50 * 1024,
        },
      },
    } as unknown as AgentToolResult<ResponseShape>;

    const rendered = renderResult(result, { expanded: true, isPartial: false }, theme, {
      args: {},
      cwd: "/workspace/project",
      expanded: true,
      lastComponent: undefined,
    })
      .render(240)
      .join("\n");

    expect(rendered).toContain("Output capture omitted 64.0KB");
    expect(rendered).toContain("Response then truncated to 100 retained lines");
  });

  it("tolerates partial results with incomplete or malformed details", () => {
    const result = {
      content: [{ type: "text", text: "content fallback" }],
      details: {
        output: "partial output",
        wall_time_seconds: undefined,
        session_id: "not-a-number",
        truncation: { truncated: true },
      },
    } as unknown as AgentToolResult<ResponseShape>;

    const component = renderResult(result, { expanded: false, isPartial: true }, theme, {
      args: {},
      cwd: "/workspace/project",
      expanded: false,
      lastComponent: undefined,
    });

    expect(() => component.render(80)).not.toThrow();
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("partial output");
    expect(rendered).toContain("Output truncated");
    expect(rendered).not.toContain("elapsed");
  });
});
