import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { HeadTailBuffer } from "./buffer.js";
import { ptyRuntimeFailure } from "./child.js";
import {
  clampYield,
  DEFAULT_MAX_EMPTY_POLL_MS,
  MAX_EMPTY_POLL_ENV_VAR,
  MAX_YIELD_TIME_MS,
  resolveMaxEmptyPollMs,
  resolveWriteInput,
} from "./protocol.js";
import { unescapeChars } from "./unescape.js";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("HeadTailBuffer", () => {
  it("retains a stable head and the newest tail", () => {
    const buffer = new HeadTailBuffer(10);
    buffer.pushChunk(encode("0123456789"));
    buffer.pushChunk(encode("abcdef"));

    expect(decode(buffer.toBytes())).toBe("01234bcdef");
    expect(buffer.omittedBytes).toBe(6);
  });

  it("owns input chunks and resets after draining", () => {
    const source = encode("hello");
    const buffer = new HeadTailBuffer(10);
    buffer.pushChunk(source);
    source.fill(0);

    expect(decode(buffer.toBytes())).toBe("hello");
    expect(decode(buffer.drainChunks()[0]!)).toBe("hello");
    expect(buffer.retainedBytes).toBe(0);
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
