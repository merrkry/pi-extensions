import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, describe, expect, it } from "vitest";

import installUnifiedExec from "./install.js";
import type { ResponseShape } from "./protocol.js";
import { UnifiedExecLive } from "./service.js";

interface CallableTool {
  execute(
    toolCallId: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext,
  ): Promise<AgentToolResult<unknown>>;
}

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});

async function makeHarness() {
  const tools = new Map<string, CallableTool>();
  const handlers = new Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>();
  let activeTools = ["bash", "read"];
  const ui = {
    notify() {},
    setStatus() {},
    setWidget() {},
  };
  const context = {
    cwd: process.cwd(),
    hasUI: false,
    ui,
  } as unknown as ExtensionContext;
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool as unknown as CallableTool);
    },
    registerFlag() {},
    registerCommand() {},
    on(event: string, handler: (event: unknown, context: ExtensionContext) => unknown) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    getFlag() {
      return false;
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(next: string[]) {
      activeTools = next;
    },
  } as unknown as ExtensionAPI;
  const runtime = ManagedRuntime.make(UnifiedExecLive);
  disposals.push(() => runtime.dispose());
  await runtime.runPromise(installUnifiedExec(pi));

  return {
    tools,
    get activeTools() {
      return activeTools;
    },
    async emit(event: string) {
      await (handlers.get(event) ?? []).reduce(
        (previous, handler) => previous.then(() => handler({}, context)),
        Promise.resolve<unknown>(undefined),
      );
    },
    async call(name: string, parameters: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`missing tool: ${name}`);
      return tool.execute("test-call", parameters, undefined, undefined, context);
    },
  };
}

describe("unified-exec Pi adapter", () => {
  it("registers the compatible tool family and replaces built-in bash", async () => {
    const harness = await makeHarness();
    await harness.emit("session_start");

    expect([...harness.tools.keys()]).toEqual([
      "exec_command",
      "write_stdin",
      "kill_session",
      "list_sessions",
    ]);
    expect(harness.activeTools).toEqual(["read"]);
  });

  it("executes short commands through the public exec_command contract", async () => {
    const harness = await makeHarness();
    await harness.emit("session_start");
    const result = await harness.call("exec_command", { cmd: "printf adapter-ok" });
    const details = result.details as ResponseShape;

    expect(details.exit_code).toBe(0);
    expect(details.session_id).toBeUndefined();
    expect(details.output).toBe("adapter-ok");
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("maps typed input failures to ordinary tool errors at the boundary", async () => {
    const harness = await makeHarness();
    await harness.emit("session_start");
    const started = await harness.call("exec_command", {
      cmd: "cat",
      yield_time_ms: 1_000,
    });
    const sessionId = (started.details as ResponseShape).session_id!;

    try {
      await expect(
        harness.call("write_stdin", {
          session_id: sessionId,
          chars: "x",
          chars_b64: "eA==",
        }),
      ).rejects.toThrow("pass either `chars` or `chars_b64`");
    } finally {
      await harness.call("kill_session", { session_id: sessionId });
    }
  });
});
