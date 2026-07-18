import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { renderAgentInventory, updateProcessStatus } from "./management.js";
import type { AgentSessionSnapshot } from "./service.js";

function snapshot(overrides: Partial<AgentSessionSnapshot> = {}): AgentSessionSnapshot {
  return {
    sessionId: 3,
    phase: "running",
    pid: 1234,
    command: "npm run dev",
    cwd: "/workspace/project",
    tty: true,
    startedAt: 1_000,
    requestedSignal: undefined,
    exitCode: null,
    exitSignal: null,
    failureMessage: null,
    outputBytesTotal: 42,
    logPath: "/tmp/process.log",
    outputTail: undefined,
    ...overrides,
  };
}

describe("unified-exec process management", () => {
  it("renders every process with compact fields and bounded pipe output tails", () => {
    expect(renderAgentInventory([])).toBeUndefined();
    const inventory = renderAgentInventory(
      [
        snapshot(),
        snapshot({
          sessionId: 4,
          phase: "stopping",
          requestedSignal: "SIGTERM",
          tty: false,
          command: `worker\n${"x".repeat(20_000)}`,
          outputTail: "one\ntwo\nthree\nfour\nfive",
        }),
        ...Array.from({ length: 62 }, (_, index) =>
          snapshot({
            sessionId: index + 5,
            command: `worker-${index} ${"x".repeat(1_000)}`,
            cwd: `/workspace/${"nested/".repeat(4)}${index}`,
          }),
        ),
      ],
      62_000,
    )!;

    expect(inventory).toContain('<background_processes total="64" active="64">');
    expect(inventory).toContain('#3 running tty running_for=1m01s cwd="/workspace/project"');
    expect(inventory).toContain("#4 stopping(SIGTERM)");
    expect(inventory).toContain("#66 running");
    expect(inventory).not.toContain("more; call list_sessions");
    expect(inventory).not.toContain("\nxxxxxxxx");
    expect(inventory).toContain("output_tail #4:\n  two\n  three\n  four\n  five");
    expect(inventory).toContain("tty output tails omitted");
  });

  it("counts running and stopping sessions in the persistent footer status", () => {
    const statuses: Array<string | undefined> = [];
    const context = {
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      },
    } as unknown as Pick<ExtensionCommandContext, "ui">;

    updateProcessStatus(context, [
      snapshot(),
      snapshot({ sessionId: 4, phase: "stopping", requestedSignal: "SIGTERM" }),
      snapshot({ sessionId: 5, phase: "exited", exitCode: 0 }),
    ]);
    expect(statuses.at(-1)).toBe("exec 2");
  });
});
