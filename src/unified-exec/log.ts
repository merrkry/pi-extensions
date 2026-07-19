import { closeSync, createWriteStream, openSync, type WriteStream } from "node:fs";

export const DEFAULT_SESSION_LOG_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_RUNTIME_LOG_MAX_BYTES = 256 * 1024 * 1024;
export const SESSION_LOG_MAX_BYTES_ENV_VAR = "PI_UNIFIED_EXEC_SESSION_LOG_MAX_BYTES";
export const RUNTIME_LOG_MAX_BYTES_ENV_VAR = "PI_UNIFIED_EXEC_RUNTIME_LOG_MAX_BYTES";
const LOG_HIGH_WATER_MARK_BYTES = 64 * 1024;

export type LogStatus = "complete" | "capped" | "write_error" | "backpressure_drop";
export type LogAppendResult = "written" | "backpressured" | "dropped";
const LOG_STATUS_PRIORITY: Record<LogStatus, number> = {
  complete: 0,
  backpressure_drop: 1,
  capped: 2,
  write_error: 3,
};

export interface LogSnapshot {
  readonly status: LogStatus;
  readonly bytesWritten: number;
  readonly bytesDropped: number;
  readonly errorMessage: string | undefined;
}

export class LogBudget {
  private usedBytesInternal = 0;

  constructor(readonly maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new Error(`log maxBytes must be a non-negative finite number (got ${maxBytes})`);
    }
  }

  reserve(requestedBytes: number): number {
    const granted = Math.min(requestedBytes, Math.max(0, this.maxBytes - this.usedBytesInternal));
    this.usedBytesInternal += granted;
    return granted;
  }

  get usedBytes(): number {
    return this.usedBytesInternal;
  }
}

export class SessionLog {
  private statusValue: LogStatus = "complete";
  private bytesWrittenValue = 0;
  private bytesDroppedValue = 0;
  private errorMessageValue: string | undefined;
  private blocked = false;
  private ended = false;
  private closed = false;
  private readonly writableListeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly statusListeners = new Set<() => void>();

  private constructor(
    readonly path: string,
    private readonly stream: WriteStream,
    private readonly budget: LogBudget,
    private readonly maxBytes: number,
  ) {
    stream.on("drain", () => {
      this.blocked = false;
      this.notify(this.writableListeners);
    });
    stream.on("error", (cause) => {
      this.errorMessageValue ??= cause.message;
      this.setStatus("write_error");
      this.blocked = false;
      this.notify(this.writableListeners);
    });
    stream.on("close", () => {
      this.closed = true;
      this.notify(this.closeListeners);
    });
  }

  static open(path: string, budget: LogBudget, maxBytes: number): SessionLog {
    closeSync(openSync(path, "w", 0o600));
    const stream = createWriteStream(path, {
      flags: "a",
      highWaterMark: LOG_HIGH_WATER_MARK_BYTES,
    });
    return new SessionLog(path, stream, budget, Math.max(0, Math.floor(maxBytes)));
  }

  append(chunk: Uint8Array): LogAppendResult {
    if (chunk.length === 0) return "written";
    if (this.ended || this.statusValue === "write_error") {
      this.bytesDroppedValue += chunk.length;
      return "dropped";
    }
    if (this.blocked) {
      this.setStatus("backpressure_drop");
      this.bytesDroppedValue += chunk.length;
      return "dropped";
    }

    const sessionRemaining = Math.max(0, this.maxBytes - this.bytesWrittenValue);
    const allowed = this.budget.reserve(Math.min(chunk.length, sessionRemaining));
    if (allowed < chunk.length) {
      this.setStatus("capped");
      this.bytesDroppedValue += chunk.length - allowed;
    }
    if (allowed === 0) return "dropped";

    this.bytesWrittenValue += allowed;
    const writable = this.stream.write(Buffer.from(chunk.subarray(0, allowed)));
    if (writable) return allowed === chunk.length ? "written" : "dropped";
    this.blocked = true;
    return "backpressured";
  }

  onWritable(listener: () => void): () => void {
    this.writableListeners.add(listener);
    return () => this.writableListeners.delete(listener);
  }

  onStatusChange(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    if (this.closed) listener();
    return () => this.closeListeners.delete(listener);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.closed || this.stream.destroyed) {
      this.closed = true;
      this.notify(this.closeListeners);
      return;
    }
    this.stream.end();
  }

  snapshot(): LogSnapshot {
    return {
      status: this.statusValue,
      bytesWritten: this.bytesWrittenValue,
      bytesDropped: this.bytesDroppedValue,
      errorMessage: this.errorMessageValue,
    };
  }

  private setStatus(status: LogStatus): void {
    if (LOG_STATUS_PRIORITY[status] <= LOG_STATUS_PRIORITY[this.statusValue]) return;
    this.statusValue = status;
    this.notify(this.statusListeners);
  }

  private notify(listeners: ReadonlySet<() => void>): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Logging must not disrupt process ownership or output collection.
      }
    }
  }
}

export function resolveLogMaxBytes(
  name: typeof SESSION_LOG_MAX_BYTES_ENV_VAR | typeof RUNTIME_LOG_MAX_BYTES_ENV_VAR,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}
