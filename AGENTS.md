# AGENTS.md

This repository contains one Pi Coding Agent extension with one bundled extension entry point. Feature code remains modular under `src/`.

User's Pi setup is at `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`.

## Documentation

- See [architecture](docs/architecture.md) for layout, Effect, lifecycle, and cross-module communication conventions.
- See [compatibility notes](docs/compatibility.md) for external extension and CLI contracts.

## Workflows

Run workflow commands from the repository root; scripts do not accept package targets.

- Use `pnpm run format` to format code. Use this to fix formatting issues instead of editing manually.
- Use `pnpm run {format:check,lint,typecheck,test,build}` for individual checks. Use `pnpm exec vitest run <path>` to run individual tests.
- Use `pnpm run check` for full verification. Full verification must pass before calling work done.
- Use `pnpm run dev` to launch a Pi instance. It compiles and loads the extension into a Pi instance with `PI_CODING_AGENT_DIR=.local`.
- Use `pnpm run apply` to build install the extension to user's Pi setup directory.
- Unless explicitly permitted, do not run `pnpm apply` or any command that modifies the user's Pi setup.
