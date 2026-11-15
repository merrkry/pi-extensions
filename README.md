# pi-extensions

Extensions for the [Pi coding agent](https://pi.dev), loaded in a fixed order
from one entry point:

- [DeepSeek Search](src/deepseek-search/README.md)
- [Async Bash](src/async-bash/README.md)

The build produces `index.js`, the extension entry point, and `settings.js`,
which applies settings overrides.

## Install

The Nix flake provides the build as `packages.<system>.pi-extensions`, and
as `pi-extensions` through `overlays.default`. Pi loads the extensions from a
directory containing `index.js`, such as `~/.pi/agent/extensions/<name>`.

Pi supplies its SDK packages and TypeBox at runtime, so the build leaves them
external.

## Develop

`mise run dev` builds the current sources and starts Pi with only these
extensions. Settings, provider logins, and sessions persist in `.dev/agent`.

`mise run check` runs formatting, lint, and type checks, and the tests under
Node and Bun.
