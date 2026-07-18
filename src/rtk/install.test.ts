import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vitest";

import { extractRewrittenCommand, getRewriteTarget } from "./core.js";
import installRtk from "./install.js";

const rewriteResult = (code: number, stdout = "", killed = false) => ({ code, stdout, killed });

describe("extractRewrittenCommand", () => {
  it.each([
    [0, "rtk git status"],
    [3, "rtk git status"],
  ])("accepts RTK exit code %i when stdout contains a rewrite", (code, stdout) => {
    expect(Option.getOrNull(extractRewrittenCommand(rewriteResult(code, `  ${stdout}\n`)))).toBe(
      stdout,
    );
  });

  it.each([1, 2, 4])("rejects RTK exit code %i even when stdout is non-empty", (code) => {
    expect(Option.isNone(extractRewrittenCommand(rewriteResult(code, "rtk git status")))).toBe(
      true,
    );
  });

  it.each([0, 3])("rejects empty stdout for RTK exit code %i", (code) => {
    expect(Option.isNone(extractRewrittenCommand(rewriteResult(code, "  \n")))).toBe(true);
  });

  it("rejects a killed rewrite process regardless of its output", () => {
    expect(Option.isNone(extractRewrittenCommand(rewriteResult(0, "rtk git status", true)))).toBe(
      true,
    );
  });
});

describe("getRewriteTarget", () => {
  it("adapts bash's command field", () => {
    const event = { toolName: "bash", input: { command: "git status" } };
    const target = Option.getOrThrow(getRewriteTarget(event));

    target.apply("rtk git status");

    expect(target.command).toBe("git status");
    expect(event.input.command).toBe("rtk git status");
  });

  it("adapts exec_command's cmd field", () => {
    const event = { toolName: "exec_command", input: { cmd: "git status", tty: false } };
    const target = Option.getOrThrow(getRewriteTarget(event));

    target.apply("rtk git status");

    expect(target.command).toBe("git status");
    expect(event.input.cmd).toBe("rtk git status");
  });

  it("rewrites exec_command when tty is omitted without changing other arguments", () => {
    const event = {
      toolName: "exec_command",
      input: { cmd: "git diff", workdir: "/tmp", yield_time_ms: 500 },
    };

    Option.getOrThrow(getRewriteTarget(event)).apply("rtk git diff");

    expect(event.input).toEqual({
      cmd: "rtk git diff",
      workdir: "/tmp",
      yield_time_ms: 500,
    });
  });

  it("does not rewrite interactive exec_command calls", () => {
    expect(
      Option.isNone(
        getRewriteTarget({
          toolName: "exec_command",
          input: { cmd: "python -q", tty: true },
        }),
      ),
    ).toBe(true);
  });

  it("ignores unsupported tools and blank commands", () => {
    expect(
      Option.isNone(getRewriteTarget({ toolName: "write_stdin", input: { chars: "git status" } })),
    ).toBe(true);
    expect(Option.isNone(getRewriteTarget({ toolName: "bash", input: { command: "  " } }))).toBe(
      true,
    );
    expect(Option.isNone(getRewriteTarget({ toolName: "exec_command", input: { cmd: "" } }))).toBe(
      true,
    );
  });
});

describe("installRtk", () => {
  it.each([
    { code: 0, stdout: "not a version", killed: false },
    { code: 0, stdout: "rtk 0.43.0", killed: true },
    { code: 1, stdout: "", killed: false },
  ])("does not register handlers after an invalid version check: %o", async (result) => {
    const on = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pi = {
      exec: vi.fn().mockResolvedValue({ ...result, stderr: "" }),
      on,
    } as unknown as ExtensionAPI;

    try {
      await Effect.runPromise(installRtk(pi));
      expect(on).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("registers handlers after a supported version check", async () => {
    const on = vi.fn();
    const pi = {
      exec: vi.fn().mockResolvedValue({
        code: 0,
        stdout: "rtk 0.43.0\n",
        stderr: "",
        killed: false,
      }),
      on,
    } as unknown as ExtensionAPI;

    await Effect.runPromise(installRtk(pi));

    expect(on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
    expect(on).toHaveBeenCalledWith("tool_call", expect.any(Function));
  });
});
