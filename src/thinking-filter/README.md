# Thinking Filter

Cleans thinking content from the `openai-codex` provider while it streams and when the message is finalized.

The filter removes every `<!-- -->` marker together with its following line ending and trims trailing whitespace from each thinking block. Partial markers split across stream deltas are held back so they never flash in the TUI. LF, CRLF, and CR line endings are supported, including blocks formed by multiple consecutive thinking outputs.

Raw streaming content is tracked independently by content index because some providers shallow-copy the message between events while retaining the same content block. Session shutdown and finalized messages clear that temporary state.
