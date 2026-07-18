import { stripVTControlCharacters } from "node:util";

import {
  DynamicBorder,
  truncateHead,
  truncateTail,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  SelectList,
  truncateToWidth,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";

import { errorMessage, type UnifiedExecError } from "./errors.js";
import type { AgentSessionSnapshot, SessionSnapshot, UnifiedExecApi } from "./service.js";

const AGENT_COMMAND_MAX_BYTES = 128;
const AGENT_OUTPUT_MAX_BYTES_PER_SESSION = 256;
const AGENT_OUTPUT_MAX_LINES_PER_SESSION = 4;
const STATUS_KEY = "unified-exec";

type ManagementAction =
  | { readonly type: "details"; readonly sessionId: number }
  | { readonly type: "term"; readonly sessionId: number }
  | { readonly type: "kill"; readonly sessionId: number }
  | { readonly type: "refresh" };

export function updateProcessStatus(
  context: Pick<ExtensionCommandContext, "ui">,
  sessions: readonly SessionSnapshot[],
): void {
  const active = sessions.filter((session) => session.phase !== "exited").length;
  const color = active > 0 ? "accent" : "dim";
  context.ui.setStatus(STATUS_KEY, context.ui.theme.fg(color, `exec ${active}`));
}

export function clearProcessStatus(context: Pick<ExtensionCommandContext, "ui">): void {
  context.ui.setStatus(STATUS_KEY, undefined);
}

export function renderAgentInventory(
  sessions: readonly AgentSessionSnapshot[],
  now = Date.now(),
): string | undefined {
  if (sessions.length === 0) return undefined;
  const active = sessions.filter((session) => session.phase !== "exited").length;
  const lines = [`<background_processes total="${sessions.length}" active="${active}">`];
  for (const session of sessions) {
    lines.push(
      `#${session.sessionId} ${describeAgentState(session)} ${session.tty ? "tty" : "pipe"} running_for=${formatElapsed(
        now - session.startedAt,
      )} cwd=${JSON.stringify(session.cwd)} cmd=${JSON.stringify(commandSummary(session.command))}`,
    );
  }
  lines.push(...renderOutputTails(sessions));
  if (sessions.some((session) => session.tty && session.outputBytesTotal > 0)) {
    lines.push("tty output tails omitted: raw PTY streams have no stable logical tail");
  }
  lines.push("</background_processes>");
  return lines.join("\n");
}

export async function manageProcesses(
  manager: UnifiedExecApi,
  context: ExtensionCommandContext,
): Promise<void> {
  if (!context.hasUI) return;
  if (context.mode !== "tui") {
    await manageProcessesWithDialogs(manager, context);
    return;
  }

  await manageProcessesInTui(manager, context);
}

async function manageProcessesInTui(
  manager: UnifiedExecApi,
  context: ExtensionCommandContext,
): Promise<void> {
  const initial = await Effect.runPromise(manager.inventory);
  const action = await showProcessManager(manager, context, initial);
  if (!action) return;
  if (action.type === "refresh") return manageProcessesInTui(manager, context);
  const session = (await Effect.runPromise(manager.inventory)).find(
    (candidate) => candidate.sessionId === action.sessionId,
  );
  if (!session) {
    context.ui.notify(`Session ${action.sessionId} no longer exists.`, "warning");
    return manageProcessesInTui(manager, context);
  }
  if (action.type === "details") {
    context.ui.notify(renderDetails(session), "info");
    return manageProcessesInTui(manager, context);
  }
  if (session.phase === "exited") {
    context.ui.notify(`Session ${session.sessionId} has already exited.`, "warning");
    return manageProcessesInTui(manager, context);
  }
  if (action.type === "kill") {
    const confirmed = await context.ui.confirm(
      `Kill session ${session.sessionId}?`,
      `Send SIGKILL immediately to this process tree?\n\n${singleLine(session.command, 256)}`,
    );
    if (!confirmed) return manageProcessesInTui(manager, context);
  }
  const signal: NodeJS.Signals = action.type === "term" ? "SIGTERM" : "SIGKILL";
  try {
    await Effect.runPromise(manager.signal(session.sessionId, signal));
    context.ui.notify(`${signal} sent to session ${session.sessionId}.`, "info");
  } catch (cause) {
    context.ui.notify(managementError(cause), "error");
  }
  return manageProcessesInTui(manager, context);
}

class ProcessManagerComponent implements Component {
  private sessions: readonly SessionSnapshot[];
  private selectedSessionId: number | undefined;
  private list: SelectList | undefined;

  constructor(
    sessions: readonly SessionSnapshot[],
    private readonly maximumVisible: number,
    private readonly theme: Theme,
    private readonly finish: (action: ManagementAction | undefined) => void,
  ) {
    this.sessions = sessions;
    this.selectedSessionId = sessions[0]?.sessionId;
    this.rebuildList();
  }

  update(sessions: readonly SessionSnapshot[]): void {
    this.sessions = sessions;
    if (!sessions.some((session) => session.sessionId === this.selectedSessionId)) {
      this.selectedSessionId = sessions[0]?.sessionId;
    }
    this.rebuildList();
  }

  refreshElapsed(): void {
    this.rebuildList();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const top = new DynamicBorder((text: string) => this.theme.fg("borderAccent", text));
    const bottom = new DynamicBorder((text: string) => this.theme.fg("borderMuted", text));
    const lines = [
      ...top.render(width),
      truncateToWidth(this.theme.fg("accent", this.theme.bold("Background processes")), width),
    ];
    if (this.list) {
      lines.push(...this.list.render(width));
    } else {
      lines.push(this.theme.fg("muted", "  No owned processes."));
    }
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "dim",
          "↑↓ navigate · enter details · t TERM · k KILL · r refresh · esc close",
        ),
        width,
        "...",
      ),
      ...bottom.render(width),
    );
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "r")) {
      this.finish({ type: "refresh" });
      return;
    }
    const selected = this.selectedSessionId;
    if (selected !== undefined && matchesKey(data, "t")) {
      this.finish({ type: "term", sessionId: selected });
      return;
    }
    if (selected !== undefined && matchesKey(data, "k")) {
      this.finish({ type: "kill", sessionId: selected });
      return;
    }
    if (!this.list && (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))) {
      this.finish(undefined);
      return;
    }
    this.list?.handleInput(data);
  }

  invalidate(): void {
    this.list?.invalidate();
  }

  private rebuildList(): void {
    if (this.sessions.length === 0) {
      this.list = undefined;
      return;
    }
    const items: SelectItem[] = this.sessions.map((session) => ({
      value: String(session.sessionId),
      label: renderListLabel(session, this.theme),
      description: session.cwd,
    }));
    const list = new SelectList(items, Math.min(items.length, this.maximumVisible), {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    });
    const selectedIndex = items.findIndex((item) => Number(item.value) === this.selectedSessionId);
    list.setSelectedIndex(Math.max(0, selectedIndex));
    list.onSelectionChange = (item) => {
      this.selectedSessionId = Number(item.value);
    };
    list.onSelect = (item) => {
      this.finish({ type: "details", sessionId: Number(item.value) });
    };
    list.onCancel = () => this.finish(undefined);
    this.list = list;
  }
}

async function showProcessManager(
  manager: UnifiedExecApi,
  context: ExtensionCommandContext,
  initial: readonly SessionSnapshot[],
): Promise<ManagementAction | undefined> {
  return context.ui.custom<ManagementAction | undefined>((tui, theme, _keybindings, done) => {
    const maximumVisible = Math.max(3, Math.min(14, tui.terminal.rows - 8));
    const component = new ProcessManagerComponent(initial, maximumVisible, theme, done);
    const unsubscribe = Effect.runSync(
      manager.subscribe((sessions) => {
        component.update(sessions);
        tui.requestRender();
      }),
    );
    const timer = setInterval(() => {
      component.refreshElapsed();
      tui.requestRender();
    }, 1_000);
    timer.unref();
    return {
      render: (width) => component.render(width),
      handleInput: (data) => {
        component.handleInput(data);
        tui.requestRender();
      },
      invalidate: () => component.invalidate(),
      dispose: () => {
        clearInterval(timer);
        unsubscribe();
      },
    };
  });
}

async function manageProcessesWithDialogs(
  manager: UnifiedExecApi,
  context: ExtensionCommandContext,
): Promise<void> {
  const sessions = await Effect.runPromise(manager.inventory);
  if (sessions.length === 0) {
    context.ui.notify("No owned processes.", "info");
    return;
  }
  const labels = sessions.map((session) => plainListLabel(session));
  const selected = await context.ui.select("Background processes", labels);
  if (!selected) return;
  const session = sessions[labels.indexOf(selected)];
  if (!session) return;
  const action = await context.ui.select(`Session ${session.sessionId}`, [
    "View details",
    "Send SIGTERM",
    "Send SIGKILL",
  ]);
  if (action === "View details") {
    context.ui.notify(renderDetails(session), "info");
    return;
  }
  if (action !== "Send SIGTERM" && action !== "Send SIGKILL") return;
  if (session.phase === "exited") {
    context.ui.notify(`Session ${session.sessionId} has already exited.`, "warning");
    return;
  }
  if (action === "Send SIGKILL") {
    const confirmed = await context.ui.confirm(
      `Kill session ${session.sessionId}?`,
      "Send SIGKILL immediately to this process tree?",
    );
    if (!confirmed) return;
  }
  const signal = action === "Send SIGTERM" ? "SIGTERM" : "SIGKILL";
  try {
    await Effect.runPromise(manager.signal(session.sessionId, signal));
    context.ui.notify(`${signal} sent to session ${session.sessionId}.`, "info");
  } catch (cause) {
    context.ui.notify(managementError(cause), "error");
  }
}

function renderListLabel(session: SessionSnapshot, theme: Theme): string {
  const icon =
    session.phase === "running"
      ? theme.fg("success", "●")
      : session.phase === "stopping"
        ? theme.fg("warning", "◐")
        : theme.fg("dim", "○");
  return `${icon} #${session.sessionId} ${formatElapsed(Date.now() - session.startedAt)} ${
    session.tty ? "tty" : "pipe"
  } ${singleLine(session.command, 128)}`;
}

function plainListLabel(session: SessionSnapshot): string {
  return `#${session.sessionId} ${session.phase} ${formatElapsed(
    Date.now() - session.startedAt,
  )} ${session.tty ? "tty" : "pipe"} ${singleLine(session.command, 128)}`;
}

function renderDetails(session: SessionSnapshot): string {
  return [
    `Session ${session.sessionId} — ${describeAgentState(session)}`,
    `pid: ${session.pid ?? "?"}`,
    `mode: ${session.tty ? "tty" : "pipe"}`,
    `running time: ${formatElapsed(Date.now() - session.startedAt)}`,
    `cwd: ${session.cwd}`,
    `command: ${singleLine(session.command, 1_024)}`,
    `output bytes: ${session.outputBytesTotal}`,
    `log: ${session.logPath}`,
  ].join("\n");
}

function renderOutputTails(sessions: readonly AgentSessionSnapshot[]): string[] {
  const lines: string[] = [];
  for (const session of sessions) {
    if (session.tty) continue;
    const output = sanitizeOutput(session.outputTail ?? "");
    if (!output.trim()) continue;
    const truncated = truncateTail(output, {
      maxBytes: AGENT_OUTPUT_MAX_BYTES_PER_SESSION,
      maxLines: AGENT_OUTPUT_MAX_LINES_PER_SESSION,
    }).content.trim();
    if (!truncated) continue;
    lines.push(
      `output_tail #${session.sessionId}:`,
      ...truncated.split("\n").map((line) => `  ${line}`),
    );
  }
  return lines;
}

function describeAgentState(session: SessionSnapshot): string {
  if (session.phase === "stopping") return `stopping(${session.requestedSignal ?? "signal"})`;
  if (session.phase === "exited") {
    if (session.exitSignal) return `exited(signal=${session.exitSignal})`;
    return `exited(code=${session.exitCode ?? "?"})`;
  }
  return "running";
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function commandSummary(command: string): string {
  const normalized = singleLine(command, Number.MAX_SAFE_INTEGER);
  const truncated = truncateHead(normalized, {
    maxBytes: AGENT_COMMAND_MAX_BYTES,
    maxLines: 1,
  });
  return truncated.truncated ? `${truncated.content}…` : truncated.content;
}

function sanitizeOutput(value: string): string {
  const withoutAnsi = stripVTControlCharacters(value)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  return [...withoutAnsi]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 && code !== 9 && code !== 10 ? " " : character;
    })
    .join("");
}

function singleLine(value: string, maximum: number): string {
  const printable = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
  const normalized = printable.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 3)}...`;
}

function managementError(cause: unknown): string {
  if (cause && typeof cause === "object" && "_tag" in cause) {
    return errorMessage(cause as UnifiedExecError);
  }
  return cause instanceof Error ? cause.message : String(cause);
}
