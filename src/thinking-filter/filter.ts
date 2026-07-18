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
