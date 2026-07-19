/** Shell resolution delegated to Pi's public cross-platform resolver. */

import { getShellConfig } from "@earendil-works/pi-coding-agent";

export const IS_WINDOWS = process.platform === "win32";

export interface ShellCommand {
  readonly command: string[];
  /** Command bytes for shells such as the legacy WSL bash stub that require stdin transport. */
  readonly initialStdin?: Uint8Array;
}

const encoder = new TextEncoder();

/** Resolve Pi's default shell and build one invocation for `cmd`. */
export function buildShellCommand(
  cmd: string,
  tty: boolean,
  resolveShell: () => ReturnType<typeof getShellConfig> = getShellConfig,
): ShellCommand {
  const config = resolveShell();
  if (config.commandTransport === "stdin") {
    if (tty) {
      throw new Error("the resolved shell requires stdin command transport and cannot use a PTY");
    }
    return {
      command: [config.shell, ...config.args],
      initialStdin: encoder.encode(cmd),
    };
  }
  return { command: [config.shell, ...config.args, cmd] };
}
