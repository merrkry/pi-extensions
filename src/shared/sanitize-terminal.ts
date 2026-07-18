import { stripVTControlCharacters } from "node:util";

declare const terminalSafeTextBrand: unique symbol;

/** Text that has crossed the terminal-safety boundary. */
export type TerminalSafeText = string & {
  readonly [terminalSafeTextBrand]: true;
};

/**
 * Make untrusted text safe to hand to a terminal renderer.
 *
 * ANSI/VT sequences are removed as a unit first. Any remaining C0/C1 controls
 * (including a bare or truncated ESC sequence) are then removed, while tabs
 * and logical line breaks remain useful as output formatting.
 */
export function sanitizeTerminalOutput(value: string): TerminalSafeText {
  const withoutSequences = stripVTControlCharacters(value)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");

  return [...withoutSequences]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (code === 9 || code === 10) return true;
      return code > 31 && code !== 127 && (code < 128 || code > 159);
    })
    .join("") as TerminalSafeText;
}
