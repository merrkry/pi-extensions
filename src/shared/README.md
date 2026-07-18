# Shared Capabilities

This directory contains narrow contracts that are genuinely shared by feature modules. It is not a general utility bucket.

## Fast Mode

`FastMode` is a process-wide Effect service holding the Codex fast-mode toggle and its subscriptions. Codex Fast Mode mutates it; Better TUI Chrome observes it. The explicit capability keeps those features independent of installation order and avoids communication through Pi event-handler ordering.
