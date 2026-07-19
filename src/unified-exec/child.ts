import { spawn as cpSpawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import * as Effect from "effect/Effect";

import { UnifiedExecUnavailableError } from "./errors.js";
import { IS_WINDOWS } from "./shell.js";

export interface SpawnOptions {
  readonly command: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly tty: boolean;
  readonly cols?: number;
  readonly rows?: number;
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
  end(data: Uint8Array): boolean;
  onData(handler: (chunk: Uint8Array) => void): () => void;
  onExit(handler: ExitCallback): void;
  pauseOutput(): void;
  resumeOutput(): void;
  interrupt(): boolean;
  kill(signal?: NodeJS.Signals): void;
  resize(cols: number, rows: number): void;
}

interface PtyProcess {
  readonly pid: number;
  onData(callback: (data: string | Buffer) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string | Buffer): void;
  pause(): void;
  resume(): void;
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

const PTY_PACKAGE = "@homebridge/node-pty-prebuilt-multiarch";

let ptyModule: PtyModule | undefined;
let ptyLoadFailure: UnifiedExecUnavailableError | undefined;

export function ptyRuntimeFailure(versions?: {
  readonly bun?: string;
}): UnifiedExecUnavailableError | undefined {
  const bunVersion =
    versions === undefined
      ? (process.versions as NodeJS.ProcessVersions & { readonly bun?: string }).bun
      : versions.bun;
  if (!bunVersion) return undefined;
  return new UnifiedExecUnavailableError({
    message: `PTY mode is unavailable under Bun ${bunVersion}; run Pi with Node.js 22.19 or newer, or call with tty: false to use pipes.`,
  });
}

function loadPtyModule(): Effect.Effect<PtyModule, UnifiedExecUnavailableError> {
  const runtimeFailure = ptyRuntimeFailure();
  if (runtimeFailure) return Effect.fail(runtimeFailure);
  return Effect.tryPromise({
    try: () => import("@homebridge/node-pty-prebuilt-multiarch"),
    catch: (cause) =>
      new UnifiedExecUnavailableError({
        message: `tty: true requires ${PTY_PACKAGE}, but it failed to load: ${
          cause instanceof Error ? cause.message : String(cause)
        }. Call with tty: false to use pipes instead.`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((imported) => {
      const candidate = imported as unknown as Partial<PtyModule> & { default?: PtyModule };
      const loaded =
        typeof candidate.spawn === "function" ? (candidate as PtyModule) : candidate.default;
      return loaded
        ? Effect.succeed(loaded)
        : Effect.fail(
            new UnifiedExecUnavailableError({
              message: `tty: true requires ${PTY_PACKAGE}, but the loaded module has no spawn export. Call with tty: false to use pipes instead.`,
            }),
          );
    }),
  );
}

export const loadPty: Effect.Effect<PtyModule, UnifiedExecUnavailableError> = Effect.suspend(() => {
  if (ptyModule) return Effect.succeed(ptyModule);
  if (ptyLoadFailure) return Effect.fail(ptyLoadFailure);
  return loadPtyModule().pipe(
    Effect.tap((loaded) =>
      Effect.sync(() => {
        ptyModule = loaded;
      }),
    ),
    Effect.tapError((failure) =>
      Effect.sync(() => {
        ptyLoadFailure = failure;
      }),
    ),
  );
});

export function ptyLoadError(): string | undefined {
  return ptyLoadFailure?.message;
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
    // node-pty-compatible internals are best-effort cleanup on Windows.
  }
}

export function spawnChild(options: SpawnOptions, loadedPty?: PtyModule): SpawnedChild {
  const normalized = { ...options, env: childProcessEnvironment(options.env, options.tty) };
  if (options.tty) {
    const module = loadedPty ?? ptyModule;
    if (!module) {
      throw new Error(
        `@homebridge/node-pty-prebuilt-multiarch is unavailable: ${ptyLoadFailure ?? "not loaded"}`,
      );
    }
    return spawnPty(module, normalized);
  }
  return spawnPipes(normalized);
}

export function childProcessEnvironment(
  inherited: NodeJS.ProcessEnv,
  tty: boolean,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  if (tty) {
    if (!env.TERM || env.TERM === "dumb") env.TERM = "xterm-256color";
    return env;
  }

  env.TERM = "dumb";
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  env.CLICOLOR = "0";
  env.CLICOLOR_FORCE = "0";
  delete env.COLORTERM;
  return env;
}

function spawnPty(module: PtyModule, options: SpawnOptions): SpawnedChild {
  const [file, ...args] = options.command;
  if (!file) throw new Error("cannot spawn an empty command");
  const child = module.spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    cols: options.cols ?? 120,
    rows: options.rows ?? 30,
    name: options.env.TERM ?? "xterm-256color",
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
    end() {
      return false;
    },
    onData(handler) {
      dataHandlers.add(handler);
      return () => dataHandlers.delete(handler);
    },
    onExit(handler) {
      if (!exited) exitHandlers.add(handler);
    },
    pauseOutput() {
      if (exited) return;
      try {
        child.pause();
      } catch {
        // Output can race process exit.
      }
    },
    resumeOutput() {
      if (exited) return;
      try {
        child.resume();
      } catch {
        // Output can race process exit.
      }
    },
    interrupt() {
      if (exited) return false;
      if (IS_WINDOWS) {
        try {
          child.write(Buffer.from([0x03]));
          return true;
        } catch {
          return false;
        }
      }
      try {
        child.kill("SIGINT");
        return true;
      } catch {
        return false;
      }
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
    end(data) {
      const stdin = child.stdin;
      if (exited || !stdin || stdin.destroyed || stdin.writableEnded) return false;
      try {
        stdin.end(Buffer.from(data));
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
    pauseOutput() {
      child.stdout?.pause();
      child.stderr?.pause();
    },
    resumeOutput() {
      child.stdout?.resume();
      child.stderr?.resume();
    },
    interrupt() {
      if (exited || !child.pid || IS_WINDOWS) return false;
      try {
        process.kill(-child.pid, "SIGINT");
        return true;
      } catch {
        try {
          process.kill(child.pid, "SIGINT");
          return true;
        } catch {
          return false;
        }
      }
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
