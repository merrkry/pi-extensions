# AGENTS.md

This repository contains one Pi Coding Agent package with one bundled extension entry point. Feature code remains modular under `src/`.

Pi's configuration root is `${PI_CONFIG_DIR:-$HOME/.pi}`. Its agent directory is `${PI_CODING_AGENT_DIR}` when set, otherwise `${PI_CONFIG_DIR:-$HOME/.pi}/agent`.

## Documentation

- See [architecture](docs/architecture.md) for layout, Effect, lifecycle, and cross-module communication conventions.
- See [compatibility notes](docs/compatibility.md) for external extension and CLI contracts.

## Workflows

- Use `pnpm format` for formatting.
- Use `pnpm check` for full verification; scripts do not accept package targets.
- Use `pnpm apply` to build and atomically install `dist/index.js` as `extensions/pi-extensions/index.js` under Pi's agent directory.
- Unless explicitly permitted, do not run `pnpm apply` or any command that modifies the user's Pi setup.
