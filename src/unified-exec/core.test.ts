import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { sanitizeTerminalOutput } from "../shared/sanitize-terminal.js";
import { TailByteRing } from "./buffer.js";
import { childProcessEnvironment, ptyRuntimeFailure } from "./child.js";
import {
  clampYield,
  DEFAULT_MAX_EMPTY_POLL_MS,
  MAX_EMPTY_POLL_ENV_VAR,
  MAX_YIELD_TIME_MS,
  resolveMaxEmptyPollMs,
  resolveWriteInput,
  finalizeResponse,
} from "./protocol.js";
import { buildShellCommand } from "./shell.js";
import { unescapeChars } from "./unescape.js";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const resolveStdinShell = () => ({
  shell: "C:\\Windows\\System32\\bash.exe",
  args: ["-s"],
  commandTransport: "stdin" as const,
});

describe("TailByteRing", () => {
  it("retains the newest bytes and reports overwritten output", () => {
    const buffer = new TailByteRing(10);
    buffer.append(encode("0123456789"));
    buffer.append(encode("abcdef"));

    const snapshot = buffer.snapshotFrom(0);
    expect(decode(snapshot.bytes)).toBe("6789abcdef");
    expect(snapshot).toMatchObject({ totalBytes: 16, omittedBytes: 6, endOffset: 16 });
  });

  it("uses non-destructive absolute cursors and owns retained bytes", () => {
    const source = encode("hello");
    const buffer = new TailByteRing(10);
    buffer.append(source);
    source.fill(0);

    const first = buffer.snapshotFrom(0);
    expect(decode(first.bytes)).toBe("hello");
    buffer.append(encode(" world"));
    expect(decode(buffer.snapshotFrom(first.endOffset).bytes)).toBe(" world");
  });

  it("keeps fixed storage under many tiny chunks", () => {
    const buffer = new TailByteRing(32);
    for (let index = 0; index < 100_000; index += 1) buffer.append(encode("x"));

    const snapshot = buffer.snapshotFrom(0);
    expect(snapshot.bytes).toHaveLength(32);
    expect(snapshot.omittedBytes).toBe(100_000 - 32);
  });
});

describe("PTY runtime support", () => {
  it("reports Bun as an explicit typed PTY failure", () => {
    expect(ptyRuntimeFailure({ bun: "1.2.3" })).toMatchObject({
      _tag: "UnifiedExecUnavailableError",
      message: expect.stringContaining("Bun 1.2.3"),
    });
    expect(ptyRuntimeFailure({})).toBeUndefined();
  });
});

describe("shell command construction", () => {
  it("uses Pi's resolved shell argv", () => {
    expect(
      buildShellCommand("printf ok", false, () => ({ shell: "/bin/bash", args: ["-c"] })),
    ).toEqual({ command: ["/bin/bash", "-c", "printf ok"] });
  });

  it("supports Pi's stdin command transport for pipe sessions only", () => {
    const command = buildShellCommand("printf ok", false, resolveStdinShell);
    expect(command.command).toEqual(["C:\\Windows\\System32\\bash.exe", "-s"]);
    expect(decode(command.initialStdin!)).toBe("printf ok");
    expect(() => buildShellCommand("printf ok", true, resolveStdinShell)).toThrow(
      "cannot use a PTY",
    );
  });
});

describe("child terminal environment", () => {
  it("advertises plain output to pipe processes without mutating the parent environment", () => {
    const inherited = {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "3",
      PATH: "/bin",
    };

    expect(childProcessEnvironment(inherited, false)).toEqual({
      TERM: "dumb",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      CLICOLOR: "0",
      CLICOLOR_FORCE: "0",
      PATH: "/bin",
    });
    expect(inherited).toEqual({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "3",
      PATH: "/bin",
    });
  });

  it("gives PTY processes a usable TERM while preserving explicit preferences", () => {
    expect(childProcessEnvironment({ TERM: "dumb", NO_COLOR: "1" }, true)).toEqual({
      TERM: "xterm-256color",
      NO_COLOR: "1",
    });
    expect(childProcessEnvironment({ TERM: "screen-256color" }, true).TERM).toBe("screen-256color");
  });
});

describe("yield limits", () => {
  it("keeps empty polls below the prompt-cache TTL by default", () => {
    const maximum = resolveMaxEmptyPollMs({});

    expect(maximum).toBe(DEFAULT_MAX_EMPTY_POLL_MS);
    expect(clampYield(DEFAULT_MAX_EMPTY_POLL_MS + 1, maximum)).toBe(DEFAULT_MAX_EMPTY_POLL_MS);
  });

  it("allows the empty-poll cap to be raised explicitly up to the absolute limit", () => {
    expect(resolveMaxEmptyPollMs({ [MAX_EMPTY_POLL_ENV_VAR]: "600000" })).toBe(600_000);
    expect(resolveMaxEmptyPollMs({ [MAX_EMPTY_POLL_ENV_VAR]: "9999999" })).toBe(MAX_YIELD_TIME_MS);
  });
});

describe("write_stdin input decoding", () => {
  it("decodes control escapes and preserves unknown escapes", () => {
    expect(unescapeChars("A\\x03\\u{1f642}\\q")).toBe("A\u0003🙂\\q");
  });

  it("accepts valid base64 as exact bytes", async () => {
    const bytes = await Effect.runPromise(resolveWriteInput({ session_id: 1, chars_b64: "AAH/" }));
    expect([...bytes!]).toEqual([0, 1, 255]);
  });

  it("rejects conflicting and malformed channels with typed failures", async () => {
    await expect(
      Effect.runPromise(resolveWriteInput({ session_id: 1, chars: "x", chars_b64: "eA==" })),
    ).rejects.toMatchObject({ _tag: "InvalidInputError" });
    await expect(
      Effect.runPromise(resolveWriteInput({ session_id: 1, chars_b64: "%%%=" })),
    ).rejects.toMatchObject({ _tag: "InvalidInputError" });
  });
});

describe("terminal output sanitization", () => {
  it("removes ANSI sequences and residual terminal controls", () => {
    expect(
      sanitizeTerminalOutput(
        "safe\u001b[31m red\u001b[0m\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007" +
          "\u0000\u0008\u009b2J\rnext\tvalue\u001b[",
      ),
    ).toBe("safe redlink\nnext\tvalue[");
  });

  it("fails closed when an untyped runtime caller violates the string contract", () => {
    expect(sanitizeTerminalOutput(undefined as unknown as string)).toBe("");
  });

  it("reports bytes omitted by the bounded capture", () => {
    const response = finalizeResponse({
      startedAt: Date.now(),
      collected: { bytes: encode("tail"), totalBytes: 100, omittedBytes: 96 },
      tty: false,
    });

    expect(response.output).toBe("tail");
    expect(response.original_token_count).toBe(25);
    expect(response.capture_truncation).toEqual({
      totalBytes: 100,
      retainedBytes: 4,
      omittedBytes: 96,
    });
  });

  it("does not retain raw output in truncation metadata", () => {
    const response = finalizeResponse({
      startedAt: Date.now(),
      collected: {
        bytes: encode(`\u001b[31m${"x\n".repeat(2_000)}\u001b[0m`),
        totalBytes: encode(`\u001b[31m${"x\n".repeat(2_000)}\u001b[0m`).length,
        omittedBytes: 0,
      },
      tty: false,
    });

    expect(response.truncation).toBeDefined();
    expect(response.truncation).not.toHaveProperty("content");
    expect(response.output).not.toContain("\u001b");
  });
});
