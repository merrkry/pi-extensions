import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { pi } from "./src/async-bash/eval/agents.ts";

test("reports failure from the terminal Pi assistant message", async () => {
  const agent = pi({
    provider: "synthetic",
    model: "synthetic",
    thinking: "off",
    key: "unused",
    extension: "",
    baseUrl: "",
    codexTemplate: "",
  });
  const assistant = (stopReason: string, text: string) =>
    JSON.stringify({
      type: "message",
      message: { role: "assistant", stopReason, content: [{ type: "text", text }] },
    });
  const truncated = assistant("length", "The service...");
  expect((await Effect.runPromise(agent.decodeTranscript(truncated))).failure).toBe(
    "Pi assistant stopped with length",
  );

  const completed = assistant("stop", "The service is running.");
  expect(
    (await Effect.runPromise(agent.decodeTranscript([truncated, completed].join("\n")))).failure,
  ).toBeUndefined();
});
