import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { SubagentSession } from "#src/lifecycle/subagent-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import {
  createAgentLookup,
  createChildLifecycleMock,
  createFactorySession,
  createSubagentSessionDeps,
  createSubagentSessionIO,
} from "#test/helpers/subagent-session-io";

/** Mock AgentConfigLookup. */
const mockAgentLookup = createAgentLookup();

let io: ReturnType<typeof createSubagentSessionIO>;

const exec = vi.fn();

beforeEach(() => {
  io = createSubagentSessionIO();
});

/** Arrange: build a factory session and wire it as the created session. Returns it for assertions. */
function arrangeFactory(opts?: Parameters<typeof createFactorySession>[0]) {
  const session = createFactorySession(opts);
  io.createSession.mockResolvedValue({ session });
  return session;
}

/** The standard deps bag for the default `io`/`exec`/`registry` wiring. */
function defaultDeps() {
  return createSubagentSessionDeps({ io, exec, registry: mockAgentLookup });
}

describe("createSubagentSession — assembly", () => {
  let session: ReturnType<typeof createFactorySession>;

  beforeEach(() => {
    session = createFactorySession();
    io.createSession.mockResolvedValue({ session });
  });

  it("returns a born-complete SubagentSession wrapping the created session", async () => {
    const sub = await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(sub).toBeInstanceOf(SubagentSession);
    expect(sub.session).toBe(session);
  });

  it("exposes the persisted session file as outputFile", async () => {
    const sub = await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(sub.outputFile).toBe("/sessions/child.jsonl");
  });

  it("binds extensions before returning", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith({});
  });

  it("admits every profile candidate through AgentSession's pre-bind allowlist", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "renamed-reader" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.createSession.mock.calls[0][0].tools).toEqual([
      "read",
      "bash",
      "exec_command",
      "write_stdin",
      "kill_session",
      "list_sessions",
      "view_image",
    ]);
  });

  it("does not expand an explicit pre-bind allowlist when no profile is configured", async () => {
    const registry = createAgentLookup({ toolProfile: undefined, builtinToolNames: ["read"] });

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "custom" },
      createSubagentSessionDeps({ io, exec, registry }),
    );

    expect(io.createSession.mock.calls[0][0].tools).toEqual(["read"]);
  });

  it("passes undefined through so unrestricted agents can receive extension tools", async () => {
    const registry = createAgentLookup({
      name: "general-purpose",
      toolProfile: undefined,
      builtinToolNames: undefined,
    });

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "general-purpose" },
      createSubagentSessionDeps({ io, exec, registry }),
    );

    expect(io.createSession.mock.calls[0][0].tools).toBeUndefined();
  });

  it("passes an empty allowlist through without turning tools back on", async () => {
    const registry = createAgentLookup({ toolProfile: undefined, builtinToolNames: [] });

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "no-tools" },
      createSubagentSessionDeps({ io, exec, registry }),
    );

    expect(io.createSession.mock.calls[0][0].tools).toEqual([]);
  });

  it("passes the effective cwd and agentDir to the loader, settings, and session", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore", cwd: "/tmp/worktree" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.getAgentDir).toHaveBeenCalledTimes(1);
    expect(io.createResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/worktree", agentDir: "/mock/agent-dir" }),
    );
    expect(io.createSettingsManager).toHaveBeenCalledWith("/tmp/worktree", "/mock/agent-dir");
    expect(io.createSessionManager).toHaveBeenCalledWith(
      "/tmp/worktree",
      "/mock/session-dir/tasks",
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/worktree", agentDir: "/mock/agent-dir" }),
    );
  });

  it("suppresses AGENTS.md/CLAUDE.md/APPEND_SYSTEM.md for subagents", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.createResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({
        noContextFiles: true,
        appendSystemPromptOverride: expect.any(Function),
      }),
    );
    const loaderOpts = io.createResourceLoader.mock.calls[0][0];
    expect(loaderOpts.appendSystemPromptOverride()).toEqual([]);
  });

  it("calls newSession with parentSession when parentSessionId is provided", async () => {
    await createSubagentSession(
      {
        snapshot: STUB_SNAPSHOT,
        type: "Explore",
        parentSession: {
          parentSessionFile: "/sessions/parent.jsonl",
          parentSessionId: "parent-id-123",
        },
      },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    const sm = io.createSessionManager.mock.results[0].value;
    expect(sm.newSession).toHaveBeenCalledWith({ parentSession: "parent-id-123" });
  });
});

describe("createSubagentSession — lifecycle ordering", () => {
  let session: ReturnType<typeof createFactorySession>;
  let lifecycle: ReturnType<typeof createChildLifecycleMock>;

  beforeEach(() => {
    session = createFactorySession();
    io.createSession.mockResolvedValue({ session });
    lifecycle = createChildLifecycleMock();
  });

  it("emits spawning before session-created", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.spawning).toHaveBeenCalledOnce();
    const spawnOrder = lifecycle.spawning.mock.invocationCallOrder[0];
    const createdOrder = lifecycle.sessionCreated.mock.invocationCallOrder[0];
    expect(spawnOrder).toBeLessThan(createdOrder);
  });

  it("emits session-created before bindExtensions()", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.sessionCreated).toHaveBeenCalledOnce();
    const createdOrder = lifecycle.sessionCreated.mock.invocationCallOrder[0];
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    expect(createdOrder).toBeLessThan(bindOrder);
  });

  it("carries the session id and parent session id in session-created", async () => {
    io.deriveSessionDir.mockReturnValue("/custom/session/dir");

    await createSubagentSession(
      {
        snapshot: STUB_SNAPSHOT,
        type: "Explore",
        parentSession: {
          parentSessionFile: "/sessions/parent.jsonl",
          parentSessionId: "parent-session-42",
        },
      },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.sessionCreated).toHaveBeenCalledWith({
      sessionId: "child-session-id",
      parentSessionId: "parent-session-42",
    });
  });

  it("does not emit completed or disposed during creation", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.completed).not.toHaveBeenCalled();
    expect(lifecycle.disposed).not.toHaveBeenCalled();
  });
});

describe("createSubagentSession — dispose on creation failure", () => {
  it("disposes the session and emits disposed when bindExtensions throws, then rethrows", async () => {
    const session = createFactorySession();
    session.bindExtensions = vi.fn().mockRejectedValue(new Error("bind failed"));
    io.createSession.mockResolvedValue({ session });
    io.deriveSessionDir.mockReturnValue("/custom/session/dir");
    const lifecycle = createChildLifecycleMock();

    await expect(
      createSubagentSession(
        { snapshot: STUB_SNAPSHOT, type: "Explore" },
        createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
      ),
    ).rejects.toThrow("bind failed");

    // session-created fired, so disposed must fire to avoid a registry leak.
    expect(lifecycle.sessionCreated).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledWith({ sessionId: "child-session-id" });
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});

describe("createSubagentSession — post-bind tool profiles", () => {
  // Extension-registered tools join the available set during bindExtensions.
  // Tool profiles are applied only after binding and are selected by explicit
  // agent metadata rather than agent names.

  it("calls setActiveToolsByName once, after bindExtensions", async () => {
    const session = arrangeFactory({
      toolsBeforeBind: ["read"],
      toolsAfterBind: ["read", "extension_tool"],
    });

    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore" }, defaultDeps());

    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(1);
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const setOrder = session.setActiveToolsByName.mock.invocationCallOrder[0];
    expect(setOrder).toBeGreaterThan(bindOrder);
  });

  it.each([
    {
      name: "includes extension-registered tools",
      toolsAfterBind: ["read", "extension_tool"],
      expected: [],
    },
    {
      name: "excludes EXCLUDED_TOOL_NAMES while keeping other tools",
      toolsAfterBind: ["read", "subagent", "get_subagent_result", "steer_subagent", "external"],
      expected: [],
    },
    {
      name: "runs the guard unconditionally when no extension tools register",
      toolsAfterBind: ["read"],
      expected: [],
    },
  ])("post-bind set: $name", async ({ toolsAfterBind, expected }) => {
    const session = arrangeFactory({ toolsBeforeBind: ["read"], toolsAfterBind });

    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore" }, defaultDeps());

    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(1);
    expect(session.setActiveToolsByName.mock.calls[0][0]).toEqual(expected);
  });

  it("activates the complete unified-exec family and image viewing for the read-only profile", async () => {
    const toolsAfterBind = [
      "bash",
      "read",
      "exec_command",
      "write_stdin",
      "kill_session",
      "list_sessions",
      "view_image",
      "subagent",
    ];
    const session = arrangeFactory({ toolsBeforeBind: ["bash"], toolsAfterBind });

    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore" }, defaultDeps());

    expect(session.setActiveToolsByName.mock.calls[0][0]).toEqual([
      "exec_command",
      "write_stdin",
      "kill_session",
      "list_sessions",
      "view_image",
    ]);
  });

  it("falls back to bash and keeps image viewing when unified-exec is unavailable", async () => {
    const session = arrangeFactory({
      toolsBeforeBind: ["bash"],
      toolsAfterBind: ["bash", "read", "view_image"],
    });

    const deps = createSubagentSessionDeps({
      io,
      exec,
      registry: createAgentLookup({ name: "renamed-reader" }),
    });

    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "renamed-reader" }, deps);

    expect(session.setActiveToolsByName.mock.calls[0][0]).toEqual(["bash", "view_image"]);
  });

  it("rejects an incomplete unified-exec registration", async () => {
    const session = arrangeFactory({
      toolsBeforeBind: ["bash"],
      toolsAfterBind: ["exec_command", "write_stdin", "view_image"],
    });

    await expect(
      createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "renamed" }, defaultDeps()),
    ).rejects.toThrow("Incomplete unified-exec tool family; missing: kill_session, list_sessions");
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("uses ordinary recursion filtering when the agent has no tool profile", async () => {
    const session = arrangeFactory({
      toolsBeforeBind: ["read"],
      toolsAfterBind: ["read", "external", "subagent"],
    });
    const deps = createSubagentSessionDeps({
      io,
      exec,
      registry: createAgentLookup({ toolProfile: undefined }),
    });

    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore" }, deps);

    expect(session.setActiveToolsByName.mock.calls[0][0]).toEqual(["read", "external"]);
  });
});
