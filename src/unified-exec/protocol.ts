import { randomBytes } from "node:crypto";
import { constants as osConstants } from "node:os";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";

import { sanitizeTerminalOutput, type TerminalSafeText } from "../shared/sanitize-terminal.js";
import { InvalidInputError } from "./errors.js";
import { unescapeChars } from "./unescape.js";

export const MIN_YIELD_TIME_MS = 1_000;
export const MAX_YIELD_TIME_MS = 1_800_000;
export const DEFAULT_YIELD_MS = 5_000;
export const EARLY_EXIT_GRACE_PERIOD_MS = 500;
// Keep empty polls below Anthropic's five-minute prompt-cache TTL so a wait cannot
// outlive the cached prompt prefix. Cache-insensitive runs can raise this via the env override.
export const DEFAULT_MAX_EMPTY_POLL_MS = 290_000;
export const MAX_EMPTY_POLL_ENV_VAR = "PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS";

export interface ExecCommandArgs {
  readonly cmd: string;
  readonly workdir?: string;
  readonly tty?: boolean;
  readonly yield_time_ms?: number;
}

export interface WriteStdinArgs {
  readonly session_id: number;
  readonly chars?: string;
  readonly chars_b64?: string;
  readonly yield_time_ms?: number;
}

export type TruncationMetadata = Omit<TruncationResult, "content">;

interface ResponseBase {
  readonly chunk_id: string;
  readonly wall_time_seconds: number;
  readonly output: TerminalSafeText;
  readonly original_token_count: number;
  readonly tty: boolean;
  readonly failure_message?: TerminalSafeText;
  readonly log_path?: TerminalSafeText;
  readonly cwd?: TerminalSafeText;
  readonly command?: TerminalSafeText;
  readonly yield_time_ms?: number;
  readonly truncation?: TruncationMetadata;
}

export interface StreamingResponseShape extends ResponseBase {
  readonly phase: "stream";
  readonly session_id: number;
  readonly exit_code?: never;
  readonly signal?: never;
}

export interface YieldedResponseShape extends ResponseBase {
  readonly phase: "yielded";
  readonly session_id: number;
  readonly exit_code?: never;
  readonly signal?: never;
}

export interface ExitedResponseShape extends ResponseBase {
  readonly phase: "exited";
  readonly session_id?: never;
  readonly exit_code?: number;
  readonly signal?: NodeJS.Signals;
}

export type ResponseShape = StreamingResponseShape | YieldedResponseShape | ExitedResponseShape;

export interface FinalizeInput {
  readonly startedAt: number;
  readonly collected: Uint8Array;
  readonly sessionId?: number;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly failure?: string | null;
  readonly tty: boolean;
  readonly logPath?: string;
  readonly cwd?: string;
  readonly command?: string;
  readonly yieldTimeMs?: number;
}

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

export function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function resolveWriteInput(
  args: WriteStdinArgs,
): Effect.Effect<Uint8Array | undefined, InvalidInputError> {
  return Effect.suspend(() => {
    const hasChars = typeof args.chars === "string" && args.chars.length > 0;
    const hasBase64 = typeof args.chars_b64 === "string" && args.chars_b64.length > 0;
    if (hasChars && hasBase64) {
      return Effect.fail(
        new InvalidInputError({
          message: "write_stdin: pass either `chars` or `chars_b64`, not both.",
        }),
      );
    }
    if (hasBase64) {
      const base64 = args.chars_b64!.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
        return Effect.fail(
          new InvalidInputError({ message: "write_stdin: `chars_b64` is not valid base64." }),
        );
      }
      return Effect.succeed(new Uint8Array(Buffer.from(base64, "base64")));
    }
    return Effect.succeed(hasChars ? encoder.encode(unescapeChars(args.chars!)) : undefined);
  });
}

export function clampYield(ms: number | undefined, maximum = MAX_YIELD_TIME_MS): number {
  const candidate = typeof ms === "number" && ms > 0 ? Math.floor(ms) : DEFAULT_YIELD_MS;
  return Math.min(maximum, Math.max(MIN_YIELD_TIME_MS, candidate));
}

export function resolveMaxEmptyPollMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_EMPTY_POLL_ENV_VAR]?.trim();
  if (!raw) return DEFAULT_MAX_EMPTY_POLL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_EMPTY_POLL_MS;
  return Math.min(MAX_YIELD_TIME_MS, Math.max(MIN_YIELD_TIME_MS, Math.floor(parsed)));
}

export function normalizeSignal(
  raw: string | undefined,
): Effect.Effect<NodeJS.Signals, InvalidInputError> {
  return Effect.suspend(() => {
    if (!raw) return Effect.succeed("SIGTERM");
    const upper = raw.trim().toUpperCase();
    const name = upper.startsWith("SIG") ? upper : `SIG${upper}`;
    return name in osConstants.signals
      ? Effect.succeed(name as NodeJS.Signals)
      : Effect.fail(
          new InvalidInputError({
            message: `unknown signal "${raw}" (use SIGTERM, SIGINT, SIGKILL, …)`,
          }),
        );
  });
}

export function finalizeResponse(input: FinalizeInput): ResponseShape {
  const rawText = decode(input.collected);
  const truncation = truncateTail(rawText, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const { content: _rawContent, ...truncationMetadata } = truncation;
  const base: ResponseBase = {
    chunk_id: randomBytes(3).toString("hex"),
    wall_time_seconds: (Date.now() - input.startedAt) / 1000,
    output: sanitizeTerminalOutput(truncation.content),
    original_token_count: Math.ceil(input.collected.length / 4),
    tty: input.tty,
    ...(input.failure ? { failure_message: sanitizeTerminalOutput(input.failure) } : {}),
    ...(input.logPath ? { log_path: sanitizeTerminalOutput(input.logPath) } : {}),
    ...(input.cwd ? { cwd: sanitizeTerminalOutput(input.cwd) } : {}),
    ...(input.command ? { command: sanitizeTerminalOutput(input.command) } : {}),
    ...(input.yieldTimeMs ? { yield_time_ms: input.yieldTimeMs } : {}),
    ...(truncation.truncated ? { truncation: truncationMetadata } : {}),
  };
  if (input.sessionId !== undefined) {
    return { ...base, phase: "yielded", session_id: input.sessionId };
  }
  return {
    ...base,
    phase: "exited",
    ...(input.exitCode === undefined || input.exitCode === null
      ? {}
      : { exit_code: input.exitCode }),
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

export function renderResponseText(shape: ResponseShape): string {
  const lines = [shape.session_id === undefined ? "[exited]" : "[still running]"];
  if (shape.session_id !== undefined) lines.push(`session_id: ${shape.session_id}`);
  if (shape.exit_code !== undefined) lines.push(`exit_code: ${shape.exit_code}`);
  if (shape.signal) lines.push(`signal: ${shape.signal}`);
  if (shape.failure_message) lines.push(`failure: ${shape.failure_message}`);
  if (shape.log_path) lines.push(`log_path: ${shape.log_path}`);
  if (shape.cwd) lines.push(`cwd: ${shape.cwd}`);
  lines.push(`wall_time_seconds: ${shape.wall_time_seconds.toFixed(3)}`);
  lines.push(`chunk_id: ${shape.chunk_id}`);
  lines.push(`original_token_count: ${shape.original_token_count}`);
  lines.push(`tty: ${shape.tty}`);
  const marker = shape.truncation ? truncationMarker(shape.truncation, shape.log_path) : undefined;
  return `${lines.join("\n")}\n---\n${shape.output || "(no output)"}${marker ? `\n\n${marker}` : ""}`;
}

function truncationMarker(truncation: TruncationMetadata, logPath: string | undefined): string {
  const full = logPath ? `. Full output: ${logPath}` : "";
  if (truncation.lastLinePartial) {
    return `[Showing last ${formatSize(truncation.outputBytes)} of final line (line ${truncation.totalLines} is larger than the ${formatSize(DEFAULT_MAX_BYTES)} limit)${full}]`;
  }
  const start = truncation.totalLines - truncation.outputLines + 1;
  const size =
    truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
  return `[Showing lines ${start}-${truncation.totalLines} of ${truncation.totalLines}${size}${full}]`;
}
