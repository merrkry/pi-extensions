import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, describe, expect, it } from "vitest";

import { UnifiedExecUnavailableError } from "./errors.js";
import installUnifiedExec, { type UnifiedExecInstallOptions } from "./install.js";
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

interface HarnessOptions extends UnifiedExecInstallOptions {
  readonly hasUI?: boolean;
}

async function makeHarness(options: HarnessOptions = {}) {
  const tools = new Map<string, CallableTool>();
  const commands = new Set<string>();
  const handlers = new Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>();
  const notifications: Array<{ message: string; level: string }> = [];
  let activeTools = ["bash", "read"];
  const ui = {
    theme: {
      fg: (_color: string, text: string) => text,
    },
    notify(message: string, level: string) {
      notifications.push({ message, level });
    },
    setWidget() {},
  };
  const context = {
    cwd: process.cwd(),
    hasUI: options.hasUI ?? false,
    ui,
  } as unknown as ExtensionContext;
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool as unknown as CallableTool);
    },
    registerFlag() {},
    registerCommand(name: string) {
      commands.add(name);
    },
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
  await runtime.runPromise(
    installUnifiedExec(pi, options.ptyProbe === undefined ? {} : { ptyProbe: options.ptyProbe }),
  );

  return {
    tools,
    commands,
    notifications,
    get activeTools() {
      return activeTools;
    },
    emit(event: string, eventData: unknown = {}) {
      return (handlers.get(event) ?? []).reduce(
        async (pending, handler) => [...(await pending), await handler(eventData, context)],
        Promise.resolve<unknown[]>([]),
      );
    },
    async call(name: string, parameters: Record<string, unknown>, signal?: AbortSignal) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`missing tool: ${name}`);
      return tool.execute("test-call", parameters, signal, undefined, context);
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
    expect(harness.commands).toContain("processes");
    expect(harness.activeTools).toEqual(["read"]);
  });

  it("warns in UI mode when PTY support is unavailable", async () => {
    const harness = await makeHarness({
      hasUI: true,
      ptyProbe: Effect.fail(
        new UnifiedExecUnavailableError({
          message:
            "tty: true requires @homebridge/node-pty-prebuilt-multiarch, but it failed to load.",
        }),
      ),
    });

    await harness.emit("session_start");

    expect(harness.notifications).toEqual([
      {
        level: "warning",
        message:
          "unified-exec: tty: true requires @homebridge/node-pty-prebuilt-multiarch, but it failed to load.",
      },
    ]);
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

  it("keeps the transient Agent inventory synchronized", async () => {
    const harness = await makeHarness();
    await harness.emit("session_start");
    const started = await harness.call("exec_command", {
      cmd: "cat",
      yield_time_ms: 1_000,
    });
    const sessionId = (started.details as ResponseShape).session_id!;

    try {
      await harness.emit("before_agent_start", { type: "before_agent_start" });
      const [contextResult] = await harness.emit("context", { type: "context", messages: [] });
      const messages = (contextResult as { messages: Array<{ content: string }> }).messages;
      expect(messages.at(-1)?.content).toContain(`<background_processes total="1" active="1">`);
      expect(messages.at(-1)?.content).toContain(`#${sessionId} running`);
      expect(messages.at(-1)?.content).toContain(`cmd="cat"`);

      const [laterContextResult] = await harness.emit("context", {
        type: "context",
        messages: [],
      });
      expect(laterContextResult).toBeUndefined();
    } finally {
      await harness.call("kill_session", { session_id: sessionId });
    }
  });

  it("interrupts the tool wait without terminating the owned process", async () => {
    const harness = await makeHarness();
    await harness.emit("session_start");
    const abort = new AbortController();
    const pending = harness.call(
      "exec_command",
      { cmd: "sleep 30", yield_time_ms: 5_000 },
      abort.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    abort.abort();
    await expect(pending).rejects.toBeDefined();
    await harness.emit("session_tree", {
      type: "session_tree",
      newLeafId: "earlier-branch",
      oldLeafId: "current-branch",
    });

    const listed = await harness.call("list_sessions", {});
    const details = listed.details as {
      active_count: number;
      sessions: Array<{ session_id: number }>;
    };
    expect(details.active_count).toBe(1);
    await harness.call("kill_session", { session_id: details.sessions[0]!.session_id });
  });

  it("terminates a command when shutdown races its initial wait", async () => {
    const harness = await makeHarness();
    await harness.emit("session_start");
    const pending = harness.call("exec_command", {
      cmd: "sleep 30",
      yield_time_ms: 5_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });

    const result = await pending;
    const details = result.details as ResponseShape;
    expect(details.session_id).toBeUndefined();
    expect(details.signal !== undefined || details.exit_code !== undefined).toBe(true);

    const listed = await harness.call("list_sessions", {});
    expect(listed.details).toMatchObject({ active_count: 0, sessions: [] });
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
