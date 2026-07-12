/**
 * create-subagent-session.ts — Assembly factory for born-complete child sessions (issue #265).
 *
 * `createSubagentSession()` does the assembly portion that the old runner's
 * `runAgent()` did up front: detect the environment, assemble the session config,
 * create the SDK session, publish `spawning`/`session-created`, bind extensions,
 * and apply the recursion guard. It returns a fully usable `SubagentSession` —
 * `Subagent` then only coordinates (turn loop, steer, dispose).
 *
 * The factory takes a resolved `cwd` value, never the WorkspaceProvider: `cwd`
 * is a value the factory consumes directly (detectEnv, assembleSessionConfig,
 * createSession), so threading the provider through here would be a relay smell.
 */

import type { Model } from "@earendil-works/pi-ai";
import { type AgentSession, type SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfigLookup } from "#src/config/agent-types";
import { getProfileAllowedToolNames, UNIFIED_EXEC_TOOL_NAMES } from "#src/config/tool-profiles";
import type { ChildLifecyclePublisher } from "#src/lifecycle/child-lifecycle";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { SubagentSession } from "#src/lifecycle/subagent-session";
import type { EnvInfo } from "#src/session/env";
import { type AssemblerIO, assembleSessionConfig } from "#src/session/session-config";
import type { ParentSessionInfo, ShellExec, SubagentType, ThinkingLevel } from "#src/types";

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES = ["subagent", "get_subagent_result", "steer_subagent"];

/**
 * Finalize the child's tools after extensions bind. Built-in read-only agents
 * prefer unified-exec over bash, retain its complete session-control family,
 * and gain image inspection. Other agents only receive the recursion guard.
 */
function finalizeChildTools(session: AgentSession, useReadOnlyToolProfile: boolean): void {
  if (useReadOnlyToolProfile) {
    // This profile intentionally treats registered capabilities as authorized,
    // so it may reactivate a tool another extension made inactive.
    const registered = new Set(session.getAllTools().map((tool) => tool.name));
    let shellTools: string[];
    if (registered.has("exec_command")) {
      const missing = UNIFIED_EXEC_TOOL_NAMES.filter((name) => !registered.has(name));
      if (missing.length > 0) {
        throw new Error(`Incomplete unified-exec tool family; missing: ${missing.join(", ")}`);
      }
      shellTools = [...UNIFIED_EXEC_TOOL_NAMES];
    } else {
      shellTools = registered.has("bash") ? ["bash"] : [];
    }
    const imageTools = registered.has("view_image") ? ["view_image"] : [];
    session.setActiveToolsByName([...shellTools, ...imageTools]);
    return;
  }

  const filtered = session.getActiveToolNames().filter((t) => !EXCLUDED_TOOL_NAMES.includes(t));
  session.setActiveToolsByName(filtered);
}

// ── IO boundary ───────────────────────────────────────────────────────────────

/** Minimal resource-loader contract used by the factory. */
export interface ResourceLoaderLike {
  reload(): Promise<void>;
}

/** Minimal session-manager contract used by the factory. */
export interface SessionManagerLike {
  newSession(opts: { parentSession?: string }): void;
  getSessionFile(): string | undefined;
  getSessionId(): string;
}

/** Options passed to EnvironmentIO/SessionFactoryIO methods. */
export interface ResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
  systemPromptOverride?: () => string;
  /** Override the append system prompt. Receives the current base value; return the replacement. */
  appendSystemPromptOverride?: (base: string[]) => string[];
}

/** Options passed to SessionFactoryIO.createSession. */
export interface CreateSessionOptions {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManagerLike;
  settingsManager: SettingsManager;
  modelRegistry: unknown;
  model?: unknown;
  /** Undefined leaves extension tools unrestricted; [] is a hard empty allowlist. */
  tools?: string[];
  resourceLoader: ResourceLoaderLike;
  thinkingLevel?: ThinkingLevel;
}

/**
 * Environment discovery - detect runtime context and resolve directories.
 *
 * Decouples the factory from direct process/SDK reads so each can be stubbed
 * independently in tests.
 */
export interface EnvironmentIO {
  detectEnv: (exec: ShellExec, cwd: string) => Promise<EnvInfo>;
  getAgentDir: () => string;
  deriveSessionDir: (parentSessionFile: string | undefined, effectiveCwd: string) => string;
}

/**
 * Session factory - create SDK objects for a child agent session.
 *
 * Decouples the factory from direct Pi SDK imports and sibling-module IO,
 * making it testable via plain stub objects without vi.mock().
 */
export interface SessionFactoryIO {
  createResourceLoader: (opts: ResourceLoaderOptions) => ResourceLoaderLike;
  createSessionManager: (cwd: string, sessionDir: string) => SessionManagerLike;
  createSettingsManager: (cwd: string, agentDir: string) => SettingsManager;
  createSession: (opts: CreateSessionOptions) => Promise<{ session: AgentSession }>;
  assemblerIO: AssemblerIO;
}

/**
 * IO boundary injected into createSubagentSession().
 *
 * Intersection of EnvironmentIO and SessionFactoryIO — callers satisfy both
 * sub-interfaces via TypeScript's structural typing.
 */
export type SubagentSessionIO = EnvironmentIO & SessionFactoryIO;

/**
 * Dependencies injected at construction time — the IO boundary plus the two
 * static domain deps (exec, registry) every creation needs.
 */
export interface SubagentSessionDeps {
  io: SubagentSessionIO;
  exec: ShellExec;
  registry: AgentConfigLookup;
  /** Publishes the child-execution lifecycle so consumers can observe it. */
  lifecycle: ChildLifecyclePublisher;
}

/** Per-spawn parameters — the fields that vary per child session. */
export interface CreateSubagentSessionParams {
  snapshot: ParentSnapshot;
  type: SubagentType;
  /** Resolved workspace cwd; undefined → parent cwd. */
  cwd?: string;
  /** Parent session identity (file path + session ID). */
  parentSession?: ParentSessionInfo;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
}

/**
 * Build a born-complete SubagentSession: assemble config, create the SDK
 * session, publish lifecycle events, bind extensions, apply the recursion guard.
 */
export async function createSubagentSession(
  params: CreateSubagentSessionParams,
  deps: SubagentSessionDeps,
): Promise<SubagentSession> {
  const { snapshot, type } = params;
  const parentSessionId = params.parentSession?.parentSessionId;
  deps.lifecycle.spawning({ agentName: type, parentSessionId });

  // Resolve working directory upfront - needed for detectEnv before assembly.
  const effectiveCwd = params.cwd ?? snapshot.cwd;
  const env = await deps.io.detectEnv(deps.exec, effectiveCwd);

  // Assemble session configuration (synchronous, no SDK objects).
  const cfg = assembleSessionConfig(
    type,
    {
      cwd: snapshot.cwd,
      parentSystemPrompt: snapshot.systemPrompt,
      parentModel: snapshot.model,
      modelRegistry: snapshot.modelRegistry,
    },
    {
      cwd: params.cwd,
      model: params.model,
      thinkingLevel: params.thinkingLevel,
    },
    env,
    deps.registry,
    deps.io.assemblerIO,
  );

  const agentDir = deps.io.getAgentDir();

  // Children always load the parent's extensions and skills.
  // Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md - upstream's
  // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
  // would defeat prompt_mode: replace. Parent context, if wanted, reaches the
  // subagent via prompt_mode: append (parentSystemPrompt is embedded in
  // systemPromptOverride) or inherit_context (conversation).
  const loader = deps.io.createResourceLoader({
    cwd: cfg.effectiveCwd,
    agentDir,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => cfg.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  // Create a persisted SessionManager so transcripts are written in Pi's
  // official JSONL format. Falls back to a temp directory when the parent
  // session is not persisted (e.g. headless/API mode).
  const sessionDir = deps.io.deriveSessionDir(
    params.parentSession?.parentSessionFile,
    cfg.effectiveCwd,
  );
  const sessionManager = deps.io.createSessionManager(cfg.effectiveCwd, sessionDir);
  sessionManager.newSession({ parentSession: params.parentSession?.parentSessionId });
  const sessionId = sessionManager.getSessionId();

  const { session } = await deps.io.createSession({
    cwd: cfg.effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager: deps.io.createSettingsManager(cfg.effectiveCwd, agentDir),
    modelRegistry: snapshot.modelRegistry,
    model: cfg.model,
    // AgentSession treats this as a hard allowlist, including for tools that
    // extensions register later. Admit all profile candidates before binding;
    // finalizeChildTools() selects the active subset afterward.
    tools: getProfileAllowedToolNames(cfg.toolProfile, cfg.toolNames),
    resourceLoader: loader,
    thinkingLevel: cfg.thinkingLevel,
  });

  const subagentSession = new SubagentSession(session, {
    outputFile: sessionManager.getSessionFile(),
    sessionId,
    sessionDir,
    agentName: type,
    agentMaxTurns: cfg.agentMaxTurns,
    parentContext: snapshot.parentContext,
    lifecycle: deps.lifecycle,
  });

  // Publish session-created before bindExtensions() so observers (e.g. the
  // permission system) can register the child synchronously and have their
  // entry in place for the first permission check during child extension
  // initialization. The event bus dispatches synchronously, so a synchronous
  // subscriber completes before this returns.
  deps.lifecycle.sessionCreated({ sessionId, parentSessionId });

  try {
    // Bind extensions so that session_start fires and extensions can initialize.
    await session.bindExtensions({});
    // Finalize tools after bindExtensions so extension-registered capabilities
    // are available and recursive dispatch remains disabled.
    finalizeChildTools(session, cfg.toolProfile === "read-only-unified-exec");
  } catch (err) {
    // Binding failed after session-created — dispose (emit disposed +
    // session.dispose()) before rethrowing so registration is never leaked.
    subagentSession.dispose();
    throw err;
  }

  return subagentSession;
}
