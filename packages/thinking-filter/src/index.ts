import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEX_THINKING_SUFFIX = "<!-- -->";

export default function thinkingFilter(pi: ExtensionAPI) {
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || event.message.provider !== "openai-codex") {
      return;
    }

    let changed = false;
    const content = event.message.content.map((part) => {
      if (part.type !== "thinking") return part;

      const withoutTrailingWhitespace = part.thinking.trimEnd();
      if (!withoutTrailingWhitespace.endsWith(CODEX_THINKING_SUFFIX)) return part;

      changed = true;
      return {
        ...part,
        thinking: withoutTrailingWhitespace.slice(0, -CODEX_THINKING_SUFFIX.length).trimEnd(),
      };
    });

    if (!changed) return;

    return {
      message: {
        ...event.message,
        content,
      },
    };
  });
}
