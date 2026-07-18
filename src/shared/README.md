# Shared Capabilities

This directory contains narrow contracts and platform abstractions that are genuinely shared by feature modules. It is not a general utility bucket.

## Display Paths

`formatHomePath` produces a platform-aware `~` display path for locations contained by `os.homedir()`. It uses Node's active-platform `resolve`, `relative`, `sep`, and `isAbsolute` operations so Windows drives and separators work without environment-variable or raw-prefix assumptions. Unified Exec and Better TUI Chrome share this formatter.

## Fast Mode

`FastMode` is a process-wide Effect service holding the Codex fast-mode toggle and its subscriptions. Codex Fast Mode mutates it; Better TUI Chrome observes it. The explicit capability keeps those features independent of installation order and avoids communication through Pi event-handler ordering.
