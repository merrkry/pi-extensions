# AGENTS.md

This is a monorepo of several Pi Coding Agent extensions.

User's Pi setup is at `${PI_CONFIG_DIR:-$HOME/.pi}`.

## Documentation

- See [compatibility notes](docs/compatibility.md) for the external extensions and CLIs relied on by packages in this repository, including the checklist for how newly registered or activated tools interact with child subagent sessions. Each package README documents that package's own integration behavior.

## Workflows

- Use `pnpm format` for formatting.
- Use `pnpm check` for verification. Pass `[<package-dir>...]` to only execute on selected packages, e.g. `pnpm check better-tui-chrome early-env`.
- Use `pnpm apply [<package-dir>...]` to install extension packages to user's Pi setup.
- Unless explicitly permitted, you should not execute any command that modifies user's Pi setup.
