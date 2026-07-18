# AGENTS.md

This repository contains one Pi Coding Agent package with one bundled extension entry point. Feature code remains modular under `src/`.

Pi's configuration root is `${PI_CONFIG_DIR:-$HOME/.pi}`. Its agent directory is `${PI_CODING_AGENT_DIR}` when set, otherwise `${PI_CONFIG_DIR:-$HOME/.pi}/agent`.

## Documentation

- See [compatibility notes](docs/compatibility.md) for the external extension and CLI contracts used by the bundle.
- Keep `src/index.ts` composition order explicit and coordinate features through typed shared code rather than event-order assumptions.

## Workflows

- Use `pnpm format` for formatting.
- Use `pnpm check` for full verification; scripts do not accept package targets.
- Use `pnpm apply` to build and atomically install `dist/index.js` as `extensions/pi-extensions/index.js` under Pi's agent directory.
- Unless explicitly permitted, do not run `pnpm apply` or any command that modifies the user's Pi setup.
