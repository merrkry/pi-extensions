import { spawn as cpSpawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import * as Effect from "effect/Effect";

import { UnifiedExecUnavailableError } from "./errors.js";
import { IS_WINDOWS, resolveBinary } from "./shell.js";

export interface SpawnOptions {
  readonly command: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly tty: boolean;
  readonly cols?: number;
  readonly rows?: number;
  readonly windowsVerbatimArguments?: boolean;
}

export type ExitCallback = (
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  failureMessage?: string,
) => void;

export interface SpawnedChild {
  readonly pid: number | undefined;
  readonly tty: boolean;
  write(data: Uint8Array): boolean;
  onData(handler: (chunk: Uint8Array) => void): () => void;
  onExit(handler: ExitCallback): void;
  kill(signal?: NodeJS.Signals): void;
  resize(cols: number, rows: number): void;
}

interface PtyProcess {
  readonly pid: number;
  onData(callback: (data: string | Buffer) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      encoding?: null | string;
    },
  ): PtyProcess;
}

let ptyModule: PtyModule | undefined;
let ptyLoadFailure: string | undefined;
let ptyLoading: Promise<PtyModule> | undefined;

function loadPtyPromise(): Promise<PtyModule> {
  return (ptyLoading ??= import("node-pty")
    .then((imported) => {
      const candidate = imported as unknown as Partial<PtyModule> & { default?: PtyModule };
      const loaded =
        typeof candidate.spawn === "function" ? (candidate as PtyModule) : candidate.default;
      if (!loaded) throw new Error("module has no spawn export");
      ptyModule = loaded;
      return loaded;
    })
    .catch((cause: unknown) => {
      ptyLoadFailure = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    }));
}

export const loadPty = Effect.tryPromise({
  try: () => loadPtyPromise(),
  catch: (cause) =>
    new UnifiedExecUnavailableError({
      message: `tty: true requires node-pty, but it failed to load: ${
        cause instanceof Error ? cause.message : String(cause)
      }. Call with tty: false to use pipes instead.`,
      cause,
    }),
});

export function ptyLoadError(): string | undefined {
  return ptyLoadFailure;
}

export function isPtyAvailable(): boolean {
  return ptyModule !== undefined;
}

const SIGNAL_NAMES: Record<number, NodeJS.Signals> = {};
for (const [name, number] of Object.entries(osConstants.signals)) {
  if (SIGNAL_NAMES[number] === undefined) SIGNAL_NAMES[number] = name as NodeJS.Signals;
}

export function signalNameFromNumber(number: number): NodeJS.Signals | null {
  return SIGNAL_NAMES[number] ?? null;
}

function taskkillPath(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return `${root}\\System32\\taskkill.exe`;
}

function killWindowsTree(pid: number): void {
  try {
    const child = cpSpawn(taskkillPath(), ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => undefined);
  } catch {
    // The exit callback remains the source of truth; callers report an unconfirmed kill.
  }
}

function disposeWindowsConpty(child: unknown): void {
  try {
    const childRecord = child as Record<string, unknown>;
    const agent = childRecord["_agent"] as Record<string, unknown> | undefined;
    const inputSocket = agent?.["_inSocket"] as { destroy?(): void } | undefined;
    const outputSocket = agent?.["_outSocket"] as { destroy?(): void } | undefined;
    const worker = agent?.["_conoutSocketWorker"] as { dispose?(): void } | undefined;
    inputSocket?.destroy?.();
    outputSocket?.destroy?.();
    worker?.dispose?.();
  } catch {
    // node-pty internals are best-effort cleanup on Windows.
  }
}

export function spawnChild(options: SpawnOptions, loadedPty?: PtyModule): SpawnedChild {
  if (options.tty) {
    const module = loadedPty ?? ptyModule;
    if (!module) throw new Error(`node-pty is unavailable: ${ptyLoadFailure ?? "not loaded"}`);
    return spawnPty(module, options);
  }
  return spawnPipes(options);
}

function spawnPty(module: PtyModule, options: SpawnOptions): SpawnedChild {
  let [file, ...args] = options.command;
  if (!file) throw new Error("cannot spawn an empty command");
  if (IS_WINDOWS) file = resolveBinary(file);
  const ptyArgs = IS_WINDOWS && options.windowsVerbatimArguments ? args.join(" ") : args;
  const child = module.spawn(file, ptyArgs, {
    cwd: options.cwd,
    env: options.env,
    cols: options.cols ?? 120,
    rows: options.rows ?? 30,
    name: "xterm-256color",
    encoding: null,
  });
  const dataHandlers = new Set<(chunk: Uint8Array) => void>();
  const exitHandlers = new Set<ExitCallback>();
  let exited = false;
  const dataSubscription = child.onData((data) => {
    const chunk = typeof data === "string" ? Buffer.from(data) : new Uint8Array(data);
    for (const handler of dataHandlers) handler(chunk);
  });
  const exitSubscription = child.onExit(({ exitCode, signal }) => {
    if (exited) return;
    exited = true;
    dataSubscription.dispose();
    exitSubscription.dispose();
    const signalName = signal === undefined ? null : signalNameFromNumber(signal);
    for (const handler of exitHandlers) handler(signalName ? null : exitCode, signalName);
    exitHandlers.clear();
    dataHandlers.clear();
    if (IS_WINDOWS) setImmediate(() => disposeWindowsConpty(child));
  });
  return {
    pid: child.pid,
    tty: true,
    write(data) {
      if (exited) return false;
      try {
        child.write(Buffer.from(data));
        return true;
      } catch {
        return false;
      }
    },
    onData(handler) {
      dataHandlers.add(handler);
      return () => dataHandlers.delete(handler);
    },
    onExit(handler) {
      if (!exited) exitHandlers.add(handler);
    },
    kill(signal = "SIGTERM") {
      if (exited) return;
      if (IS_WINDOWS) return killWindowsTree(child.pid);
      try {
        child.kill(signal);
      } catch {
        // Already exited.
      }
    },
    resize(cols, rows) {
      if (exited) return;
      try {
        child.resize(cols, rows);
      } catch {
        // Resize races with exit.
      }
    },
  };
}

function spawnPipes(options: SpawnOptions): SpawnedChild {
  const [file, ...args] = options.command;
  if (!file) throw new Error("cannot spawn an empty command");
  const child: ChildProcess = cpSpawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    detached: !IS_WINDOWS,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
  });
  const dataHandlers = new Set<(chunk: Uint8Array) => void>();
  const exitHandlers = new Set<ExitCallback>();
  let exited = false;
  const onChunk = (chunk: Buffer) => {
    const view = new Uint8Array(chunk);
    for (const handler of dataHandlers) handler(view);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  child.stdin?.on("error", () => undefined);
  const finalize = (
    code: number | null,
    signal: NodeJS.Signals | null,
    failureMessage?: string,
  ) => {
    if (exited) return;
    exited = true;
    for (const handler of exitHandlers) handler(code, signal, failureMessage);
    exitHandlers.clear();
    dataHandlers.clear();
  };
  child.once("close", (code, signal) => finalize(code, signal));
  child.once("error", (cause) => {
    const base = cause.message;
    const message = /ENOENT/.test(base)
      ? `${base} (check shell binary and workdir: ${options.cwd})`
      : base;
    finalize(null, null, `process error: ${message}`);
  });
  return {
    pid: child.pid,
    tty: false,
    write(data) {
      const stdin = child.stdin;
      if (exited || !stdin || stdin.destroyed || stdin.writableEnded) return false;
      try {
        stdin.write(Buffer.from(data));
        return true;
      } catch {
        return false;
      }
    },
    onData(handler) {
      dataHandlers.add(handler);
      return () => dataHandlers.delete(handler);
    },
    onExit(handler) {
      if (!exited) exitHandlers.add(handler);
    },
    kill(signal = "SIGTERM") {
      if (exited || !child.pid) return;
      if (IS_WINDOWS) return killWindowsTree(child.pid);
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          process.kill(child.pid, signal);
        } catch {
          // Already exited.
        }
      }
    },
    resize() {
      // Pipe mode has no terminal dimensions.
    },
  };
}
