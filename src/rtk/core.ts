import * as Option from "effect/Option";

export interface RewriteTarget {
  readonly command: string;
  apply(rewritten: string): void;
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly killed: boolean;
}

export function getRewriteTarget(event: {
  toolName: string;
  input: Record<string, unknown>;
}): Option.Option<RewriteTarget> {
  if (event.toolName === "bash") {
    if (typeof event.input.command !== "string" || event.input.command.trim() === "") {
      return Option.none();
    }
    return Option.some({
      command: event.input.command,
      apply: (rewritten) => {
        event.input.command = rewritten;
      },
    });
  }

  if (event.toolName === "exec_command") {
    if (
      event.input.tty === true ||
      typeof event.input.cmd !== "string" ||
      event.input.cmd.trim() === ""
    ) {
      return Option.none();
    }
    return Option.some({
      command: event.input.cmd,
      apply: (rewritten) => {
        event.input.cmd = rewritten;
      },
    });
  }

  return Option.none();
}

export function parseSemver(raw: string): Option.Option<readonly [number, number, number]> {
  const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return Option.none();
  return Option.some([
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ] as const);
}

export function extractRewrittenCommand(result: ExecResult): Option.Option<string> {
  // RTK exit 0 is allowed and 3 is advisory; both may carry a rewrite.
  if (result.killed || (result.code !== 0 && result.code !== 3)) return Option.none();
  const rewritten = result.stdout.trim();
  return rewritten === "" ? Option.none() : Option.some(rewritten);
}
