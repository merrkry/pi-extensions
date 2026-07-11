# AGENTS.md

This is a monorepo of several Pi Coding Agent extensions.

User's Pi setup is at `${PI_CONFIG_DIR:-$HOME/.pi}`.

## Workflows

- Use `pnpm format` for formatting.
- Use `pnpm check` for verification. Pass `[<package-dir>...]` to only execute on selected packages, e.g. `pnpm check better-tui-chrome early-env`.
- Use `pnpm apply [<package-dir>...]` to install extension packages to user's Pi setup. Do not execute this unless explicitly permitted.
