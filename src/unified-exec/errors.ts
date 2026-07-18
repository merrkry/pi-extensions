import * as Data from "effect/Data";

export class UnifiedExecUnavailableError extends Data.TaggedError("UnifiedExecUnavailableError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SessionNotFoundError extends Data.TaggedError("SessionNotFoundError")<{
  readonly sessionId: number;
}> {}

export class SessionShuttingDownError extends Data.TaggedError("SessionShuttingDownError")<{}> {}

export class SessionCapacityError extends Data.TaggedError("SessionCapacityError")<{
  readonly maximum: number;
}> {}

export class InvalidInputError extends Data.TaggedError("InvalidInputError")<{
  readonly message: string;
}> {}

export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class StdinWriteError extends Data.TaggedError("StdinWriteError")<{
  readonly sessionId: number;
  readonly message: string;
}> {}

export class TerminationError extends Data.TaggedError("TerminationError")<{
  readonly sessionId: number;
  readonly signal: NodeJS.Signals;
}> {}

export type UnifiedExecError =
  | UnifiedExecUnavailableError
  | SessionNotFoundError
  | SessionShuttingDownError
  | SessionCapacityError
  | InvalidInputError
  | SpawnError
  | StdinWriteError
  | TerminationError;

export function errorMessage(error: UnifiedExecError): string {
  if (error instanceof SessionNotFoundError) {
    return `unknown session_id: ${error.sessionId}`;
  }
  if (error instanceof SessionShuttingDownError) {
    return "unified-exec: session is shutting down; not starting new commands.";
  }
  if (error instanceof SessionCapacityError) {
    return `unified-exec: session limit reached (${error.maximum}); stop or reap a session before starting another command.`;
  }
  if (error instanceof TerminationError) {
    return `failed to terminate session ${error.sessionId} with ${error.signal}; the process is still running`;
  }
  return error.message;
}
