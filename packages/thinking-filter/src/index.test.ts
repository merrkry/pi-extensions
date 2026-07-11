import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import thinkingFilter, { filterThinking } from "./index.js";

describe("filterThinking", () => {
  it.each(["\n", "\r\n", "\r"])("removes markers followed by %j", (lineEnding) => {
    expect(filterThinking(`first<!-- -->${lineEnding}second<!-- -->${lineEnding}`)).toBe(
      "firstsecond",
    );
  });

  it("removes every marker and its surrounding trailing whitespace", () => {
    expect(filterThinking("first  <!-- -->  \nsecond\t<!-- -->\t\n  ")).toBe("first  second");
  });

  it.each(
    Array.from({ length: "<!-- -->".length - 1 }, (_, index) => "<!-- -->".slice(0, index + 1)),
  )("holds back a partial streaming marker: %j", (partialMarker) => {
    expect(filterThinking(`content ${partialMarker}`, true)).toBe("content");
  });

  it("does not remove an incomplete marker from finalized content", () => {
    expect(filterThinking("content <!-- -")).toBe("content <!-- -");
  });

  it("does not hold back a suffix that cannot become a marker", () => {
    expect(filterThinking("content <!-- x", true)).toBe("content <!-- x");
  });

  it.each(["", "\n", "\r\n", "\r"])("removes a split marker followed by %j", (lineEnding) => {
    const chunks = ["content", "<!-- ", `-->${lineEnding}`];
    let raw = "";
    const rendered = chunks.map((chunk) => {
      raw += chunk;
      return filterThinking(raw, true);
    });

    expect(rendered).toEqual(["content", "content", "content"]);
  });
});

describe("thinking-filter extension", () => {
  it("preserves raw state when each stream event has a new message object", () => {
    let onUpdate: ((event: unknown) => void) | undefined;
    let onEnd: ((event: unknown) => unknown) | undefined;
    const pi = {
      on(event: string, handler: unknown) {
        if (event === "message_update") {
          onUpdate = handler as (event: unknown) => void;
        } else if (event === "message_end") {
          onEnd = handler as (event: unknown) => unknown;
        }
      },
    } as unknown as ExtensionAPI;
    thinkingFilter(pi);

    const block = { type: "thinking" as const, thinking: "" };
    const chunks = ["content", "<!-- ", "-->"];
    const rendered: string[] = [];
    const messages: object[] = [];

    onUpdate?.({
      type: "message_update",
      message: createAssistantMessage(block),
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: undefined },
    });

    for (const chunk of chunks) {
      block.thinking += chunk;
      const message = createAssistantMessage(block);
      messages.push(message);
      onUpdate?.({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: chunk,
          partial: undefined,
        },
      });
      rendered.push(block.thinking);
    }

    expect(new Set(messages).size).toBe(chunks.length);
    expect(rendered).toEqual(["content", "content", "content"]);
    expect(onEnd).toBeDefined();
  });
});

function createAssistantMessage(block: { type: "thinking"; thinking: string }) {
  return {
    role: "assistant" as const,
    provider: "openai-codex",
    content: [block],
  };
}
