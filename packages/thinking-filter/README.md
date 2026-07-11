# Thinking Filter

Cleans thinking content from the `openai-codex` provider while it streams and when the message is finalized. The extension removes every `<!-- -->` marker together with its following line ending and trims trailing whitespace from each thinking block. Partial markers split across stream deltas are held back so they never flash in the TUI. It supports LF, CRLF, and CR line endings, including blocks formed by multiple consecutive thinking outputs.
