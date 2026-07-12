import { describe, expect, it } from "vitest";

import { extractRewrittenCommand, getRewriteTarget } from "./index.js";

const rewriteResult = (code: number, stdout = "", killed = false) => ({ code, stdout, killed });

describe("extractRewrittenCommand", () => {
  it.each([
    [0, "rtk git status"],
    [3, "rtk git status"],
  ])("accepts RTK exit code %i when stdout contains a rewrite", (code, stdout) => {
    expect(extractRewrittenCommand(rewriteResult(code, `  ${stdout}\n`))).toBe(stdout);
  });

  it.each([1, 2, 4])("rejects RTK exit code %i even when stdout is non-empty", (code) => {
    expect(extractRewrittenCommand(rewriteResult(code, "rtk git status"))).toBeNull();
  });

  it.each([0, 3])("rejects empty stdout for RTK exit code %i", (code) => {
    expect(extractRewrittenCommand(rewriteResult(code, "  \n"))).toBeNull();
  });

  it("rejects a killed rewrite process regardless of its output", () => {
    expect(extractRewrittenCommand(rewriteResult(0, "rtk git status", true))).toBeNull();
  });
});

describe("getRewriteTarget", () => {
  it("adapts bash's command field", () => {
    const event = { toolName: "bash", input: { command: "git status" } };
    const target = getRewriteTarget(event)!;

    target.apply("rtk git status");

    expect(target.command).toBe("git status");
    expect(event.input.command).toBe("rtk git status");
  });

  it("adapts exec_command's cmd field", () => {
    const event = { toolName: "exec_command", input: { cmd: "git status", tty: false } };
    const target = getRewriteTarget(event)!;

    target.apply("rtk git status");

    expect(target.command).toBe("git status");
    expect(event.input.cmd).toBe("rtk git status");
  });

  it("rewrites exec_command when tty is omitted without changing other arguments", () => {
    const event = {
      toolName: "exec_command",
      input: { cmd: "git diff", workdir: "/tmp", yield_time_ms: 500 },
    };

    getRewriteTarget(event)!.apply("rtk git diff");

    expect(event.input).toEqual({
      cmd: "rtk git diff",
      workdir: "/tmp",
      yield_time_ms: 500,
    });
  });

  it("does not rewrite interactive exec_command calls", () => {
    expect(
      getRewriteTarget({
        toolName: "exec_command",
        input: { cmd: "python -q", tty: true },
      }),
    ).toBeUndefined();
  });

  it("ignores unsupported tools and blank commands", () => {
    expect(
      getRewriteTarget({ toolName: "write_stdin", input: { chars: "git status" } }),
    ).toBeUndefined();
    expect(getRewriteTarget({ toolName: "bash", input: { command: "  " } })).toBeUndefined();
    expect(getRewriteTarget({ toolName: "exec_command", input: { cmd: "" } })).toBeUndefined();
  });
});
