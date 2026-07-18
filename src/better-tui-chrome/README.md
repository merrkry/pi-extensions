# Better TUI Chrome

Keeps Pi's normal editor behavior while tightening the surrounding chrome. It installs a custom editor and footer only in TUI mode; print, JSON, and RPC sessions keep Pi's default UI.

The editor adds a small outer inset and colors its border from the active thinking level or shell-input mode. The footer shows the model, shared Codex fast-mode state, thinking level, context usage, working directory, and Git branch. It invalidates cached context information on model, turn, message, and compaction lifecycle events, and restores Pi's default components on session shutdown.

This module consumes the process-wide [`FastMode`](../shared/README.md#fast-mode) capability rather than depending on codex-fast-mode installation order.
