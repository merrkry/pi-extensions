import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEX_THINKING_MARKER = "<!-- -->";
const CODEX_THINKING_SUFFIX = /<!-- -->[\t ]*(?:\r\n|\n|\r)?/g;

export function filterThinking(thinking: string, streaming = false): string {
  let filtered = thinking.replace(CODEX_THINKING_SUFFIX, "").trimEnd();

  // Do not briefly render a marker while it is split across stream deltas.
  if (streaming) {
    for (
      let length = Math.min(filtered.length, CODEX_THINKING_MARKER.length - 1);
      length > 0;
      length--
    ) {
      if (CODEX_THINKING_MARKER.startsWith(filtered.slice(-length))) {
        filtered = filtered.slice(0, -length).trimEnd();
        break;
      }
    }
  }

  return filtered;
}

export default function thinkingFilter(pi: ExtensionAPI) {
  // message_update has no replacement return value. Pi forwards the mutable
  // thinking block to the TUI after extension handlers run, so update it in place.
  // Keep raw content independently of the message object: providers such as faux
  // shallow-copy the message for every event while retaining the same content block.
  const rawThinking = new Map<number, string>();

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant" || event.message.provider !== "openai-codex") return;

    const update = event.assistantMessageEvent;
    if (
      update.type !== "thinking_start" &&
      update.type !== "thinking_delta" &&
      update.type !== "thinking_end"
    )
      return;

    const part = event.message.content[update.contentIndex];
    if (part?.type !== "thinking") return;

    if (update.type === "thinking_start") {
      rawThinking.clear();
      rawThinking.set(update.contentIndex, part.thinking);
    } else if (update.type === "thinking_delta") {
      rawThinking.set(
        update.contentIndex,
        (rawThinking.get(update.contentIndex) ?? part.thinking.slice(0, -update.delta.length)) +
          update.delta,
      );
    } else {
      rawThinking.set(update.contentIndex, update.content);
    }

    part.thinking = filterThinking(
      rawThinking.get(update.contentIndex) ?? "",
      update.type !== "thinking_end",
    );
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || event.message.provider !== "openai-codex") return;

    rawThinking.clear();

    let changed = false;
    const content = event.message.content.map((part) => {
      if (part.type !== "thinking") return part;

      const thinking = filterThinking(part.thinking);
      if (thinking === part.thinking) return part;

      changed = true;
      return { ...part, thinking };
    });

    if (!changed) return;
    return { message: { ...event.message, content } };
  });
}
