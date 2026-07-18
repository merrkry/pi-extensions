import { stripVTControlCharacters } from "node:util";

import {
  DynamicBorder,
  truncateHead,
  truncateTail,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";

import { formatHomePath } from "../shared/display-path.js";
import { errorMessage, type UnifiedExecError } from "./errors.js";
import type { AgentSessionSnapshot, SessionSnapshot, UnifiedExecApi } from "./service.js";

const AGENT_COMMAND_MAX_BYTES = 128;
const AGENT_OUTPUT_MAX_BYTES_PER_SESSION = 256;
const AGENT_OUTPUT_MAX_LINES_PER_SESSION = 4;
type ManagementAction =
  | { readonly type: "details"; readonly sessionId: number }
  | { readonly type: "interrupt"; readonly sessionId: number }
  | { readonly type: "kill"; readonly sessionId: number };

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
        sessionDuration(session, now),
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
  selectedSessionId?: number,
): Promise<void> {
  const initial = await Effect.runPromise(manager.inventory);
  const action = await showProcessManager(manager, context, initial, selectedSessionId);
  if (!action) return;
  const session = (await Effect.runPromise(manager.inventory)).find(
    (candidate) => candidate.sessionId === action.sessionId,
  );
  if (!session) return manageProcessesInTui(manager, context, action.sessionId);
  if (action.type === "details") {
    context.ui.notify(renderDetails(session), "info");
    return manageProcessesInTui(manager, context, action.sessionId);
  }
  if (session.phase === "exited") {
    return manageProcessesInTui(manager, context, action.sessionId);
  }
  try {
    if (action.type === "interrupt") {
      if (!isDuplicateSignal(session, "SIGINT")) {
        const result = await Effect.runPromise(manager.interrupt(session.sessionId));
        if (!result.sent && result.session.phase !== "exited") {
          context.ui.notify(
            `Interrupt is unavailable for pipe session ${session.sessionId} on Windows.`,
            "warning",
          );
        }
      }
    } else if (!isDuplicateSignal(session, "SIGKILL")) {
      await Effect.runPromise(manager.signal(session.sessionId, "SIGKILL"));
    }
  } catch (cause) {
    if (!isSessionNotFound(cause)) context.ui.notify(managementError(cause), "error");
  }
  return manageProcessesInTui(manager, context, action.sessionId);
}

class ProcessManagerComponent implements Component {
  private sessions: readonly SessionSnapshot[];
  private selectedSessionId: number | undefined;

  constructor(
    sessions: readonly SessionSnapshot[],
    selectedSessionId: number | undefined,
    private readonly getMaximumVisible: () => number,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly refresh: () => void,
    private readonly finish: (action: ManagementAction | undefined) => void,
  ) {
    this.sessions = sessions;
    this.selectedSessionId = sessions.some((session) => session.sessionId === selectedSessionId)
      ? selectedSessionId
      : sessions[0]?.sessionId;
  }

  update(sessions: readonly SessionSnapshot[]): void {
    this.sessions = sessions;
    if (!sessions.some((session) => session.sessionId === this.selectedSessionId)) {
      this.selectedSessionId = sessions[0]?.sessionId;
    }
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const border = new DynamicBorder();
    const maximumVisible = this.getMaximumVisible();
    const lines = [
      ...border.render(width),
      truncateToWidth(this.theme.fg("accent", this.theme.bold("Background processes")), width),
      "",
    ];
    if (this.sessions.length === 0) {
      lines.push(this.theme.fg("muted", "  No owned processes."));
    } else {
      const selectedIndex = Math.max(
        0,
        this.sessions.findIndex((session) => session.sessionId === this.selectedSessionId),
      );
      const start = Math.min(
        Math.max(0, selectedIndex - maximumVisible + 1),
        Math.max(0, this.sessions.length - maximumVisible),
      );
      const visible = this.sessions.slice(start, start + maximumVisible);
      if (start > 0) lines.push(this.theme.fg("dim", `  ${start} processes above`));
      for (const [index, session] of visible.entries()) {
        if (index > 0) lines.push("");
        lines.push(
          ...renderProcessCard(
            session,
            session.sessionId === this.selectedSessionId,
            width,
            this.theme,
          ),
        );
      }
      const below = this.sessions.length - start - visible.length;
      if (below > 0) lines.push(this.theme.fg("dim", `  ${below} processes below`));
    }
    lines.push(
      "",
      truncateToWidth(
        this.theme.fg(
          "dim",
          "up/down navigate · enter details · i interrupt · k kill · r refresh · esc close",
        ),
        width,
        "...",
      ),
      ...border.render(width),
    );
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "r")) {
      this.refresh();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-this.getMaximumVisible());
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(this.getMaximumVisible());
      return;
    }
    const selected = this.selectedSessionId;
    if (selected === undefined) return;
    const session = this.sessions.find((candidate) => candidate.sessionId === selected);
    if (!session) return;
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.finish({ type: "details", sessionId: selected });
    } else if (matchesKey(data, "i")) {
      if (session.phase === "exited" || isDuplicateSignal(session, "SIGINT")) return;
      this.finish({ type: "interrupt", sessionId: selected });
    } else if (matchesKey(data, "k")) {
      if (session.phase === "exited" || isDuplicateSignal(session, "SIGKILL")) return;
      this.finish({ type: "kill", sessionId: selected });
    }
  }

  invalidate(): void {
    // All themed content is rebuilt on every render.
  }

  private moveSelection(delta: number): void {
    if (this.sessions.length === 0) return;
    const current = Math.max(
      0,
      this.sessions.findIndex((session) => session.sessionId === this.selectedSessionId),
    );
    const next = Math.max(0, Math.min(this.sessions.length - 1, current + delta));
    this.selectedSessionId = this.sessions[next]?.sessionId;
  }
}

function maximumVisibleProcesses(terminalRows: number): number {
  return Math.max(1, Math.min(8, Math.floor((terminalRows - 7) / 4)));
}

async function showProcessManager(
  manager: UnifiedExecApi,
  context: ExtensionCommandContext,
  initial: readonly SessionSnapshot[],
  selectedSessionId: number | undefined,
): Promise<ManagementAction | undefined> {
  return context.ui.custom<ManagementAction | undefined>((tui, theme, keybindings, done) => {
    let component: ProcessManagerComponent;
    const refresh = () => {
      void Effect.runPromise(manager.inventory).then(
        (sessions) => {
          component.update(sessions);
          tui.requestRender();
        },
        (cause) => context.ui.notify(managementError(cause), "error"),
      );
    };
    component = new ProcessManagerComponent(
      initial,
      selectedSessionId,
      () => maximumVisibleProcesses(tui.terminal.rows),
      theme,
      keybindings,
      refresh,
      done,
    );
    const unsubscribe = Effect.runSync(
      manager.subscribe((sessions) => {
        component.update(sessions);
        tui.requestRender();
      }),
    );
    const timer = setInterval(() => {
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
    "Interrupt",
    "Kill",
  ]);
  if (action === "View details") {
    context.ui.notify(renderDetails(session), "info");
    return;
  }
  if (action !== "Interrupt" && action !== "Kill") return;
  if (session.phase === "exited") return;
  try {
    if (action === "Interrupt") {
      if (isDuplicateSignal(session, "SIGINT")) return;
      const result = await Effect.runPromise(manager.interrupt(session.sessionId));
      if (!result.sent && result.session.phase !== "exited") {
        context.ui.notify(
          `Interrupt is unavailable for pipe session ${session.sessionId} on Windows.`,
          "warning",
        );
      }
    } else {
      if (isDuplicateSignal(session, "SIGKILL")) return;
      await Effect.runPromise(manager.signal(session.sessionId, "SIGKILL"));
    }
  } catch (cause) {
    if (!isSessionNotFound(cause)) context.ui.notify(managementError(cause), "error");
  }
}

function renderProcessCard(
  session: SessionSnapshot,
  selected: boolean,
  width: number,
  theme: Theme,
): string[] {
  const selector = selected ? theme.fg("accent", ">") : " ";
  const id = selected
    ? theme.fg("accent", theme.bold(`#${session.sessionId}`))
    : theme.bold(`#${session.sessionId}`);
  const state =
    session.phase === "running"
      ? theme.fg("success", "running")
      : session.phase === "stopping"
        ? theme.fg("warning", "exiting")
        : theme.fg("dim", "exited");
  const header = `${selector} ${id}  ${state}  ${formatElapsed(
    sessionDuration(session, Date.now()),
  )}  ${session.tty ? "tty" : "pipe"}`;
  return [
    truncateToWidth(header, width, "..."),
    ...renderProcessValue(session.command, width, theme, "toolOutput"),
    ...renderProcessValue(formatHomePath(session.cwd), width, theme, "muted"),
  ];
}

function renderProcessValue(
  value: string,
  width: number,
  theme: Theme,
  color: "toolOutput" | "muted",
): string[] {
  const prefix = "  ";
  const prefixWidth = visibleWidth(prefix);
  if (width <= prefixWidth) return [prefix.slice(0, width)];
  const contentWidth = width - prefixWidth;
  const wrapped = new Text(theme.fg(color, sanitizeDisplayValue(value)), 0, 0).render(contentWidth);
  let first = wrapped[0] ?? "";
  if (wrapped.length > 1) {
    first = truncateToWidth(first, Math.max(1, contentWidth - 4), "") + theme.fg("dim", " ...");
  }
  return [truncateToWidth(`${prefix}${first}`, width, "...")];
}

function sanitizeDisplayValue(value: string): string {
  const withoutAnsi = stripVTControlCharacters(value);
  return [...withoutAnsi]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (code === 9) return "  ";
      return code < 32 && code !== 10 ? " " : character;
    })
    .join("");
}

function plainListLabel(session: SessionSnapshot): string {
  return `#${session.sessionId} ${session.phase} ${formatElapsed(
    sessionDuration(session, Date.now()),
  )} ${session.tty ? "tty" : "pipe"} ${singleLine(session.command, 128)}`;
}

function renderDetails(session: SessionSnapshot): string {
  return [
    `Session ${session.sessionId} — ${describeAgentState(session)}`,
    `pid: ${session.pid ?? "?"}`,
    `mode: ${session.tty ? "tty" : "pipe"}`,
    `running time: ${formatElapsed(sessionDuration(session, Date.now()))}`,
    `cwd: ${formatHomePath(session.cwd)}`,
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

function sessionDuration(session: SessionSnapshot, now: number): number {
  return Math.max(0, (session.endedAt ?? now) - session.startedAt);
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

function isDuplicateSignal(session: SessionSnapshot, signal: NodeJS.Signals): boolean {
  return session.requestedSignal === signal || session.requestedSignal === "SIGKILL";
}

function isSessionNotFound(cause: unknown): boolean {
  return Boolean(
    cause &&
    typeof cause === "object" &&
    "_tag" in cause &&
    cause["_tag"] === "SessionNotFoundError",
  );
}

function managementError(cause: unknown): string {
  if (cause && typeof cause === "object" && "_tag" in cause) {
    return errorMessage(cause as UnifiedExecError);
  }
  return cause instanceof Error ? cause.message : String(cause);
}
