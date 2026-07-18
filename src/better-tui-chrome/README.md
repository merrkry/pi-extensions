# Better TUI Chrome

Keeps Pi's normal editor behavior while tightening the surrounding chrome. It installs a custom editor and footer only in TUI mode; print, JSON, and RPC sessions keep Pi's default UI.

The editor adds a small outer inset and colors its border from the active thinking level or shell-input mode. The footer shows the model, shared Codex fast-mode state, thinking level, context usage, working directory, and Git branch. Active Unified Exec sessions use Pi's existing above-editor status area: the working message includes the count while the Agent runs, and an idle-only one-line widget shows the count otherwise; zero active processes add no UI. It invalidates cached context information on model, turn, message, and compaction lifecycle events, and restores Pi's default components on session shutdown.

This module consumes the process-wide [`FastMode`](../shared/README.md#fast-mode) capability and the scoped `UnifiedExec` inventory rather than depending on feature installation order. Its home-relative cwd display uses the shared [`formatHomePath`](../shared/README.md#display-paths) platform abstraction instead of maintaining a footer-specific path formatter.
