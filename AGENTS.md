# AGENTS.md

Pi extensions bundled into one ordered entry point. Mise installs the toolchain
and runs the tasks.

## Run and reload

`mise run dev` builds the extensions and starts a development Pi. To pass Pi
arguments, use `mise run dev -- <args>`.

The development instance keeps settings, provider logins, and sessions in
`.dev/agent`. Retain this directory between runs. Use a separate temporary
agent directory for automated checks.

After editing extensions, run `mise run build`, then `/reload` in Pi. Restart
the development instance after changing dependencies.

## Extend Pi

Keep the required factory load order in `src/index.ts`. Add external extensions
as production dependencies pinned to a version or Git commit.

Use Effect v4 for I/O, cancellation, and resource lifetimes. Keep pure
transformations as ordinary functions. Use TypeBox for Pi tool schemas and
Effect Schema to decode external responses.

Follow [Pi's dependency rules](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#declare-dependencies).
Declare host SDK packages and TypeBox as `peerDependencies` with a `"*"` range,
and keep local development copies in `devDependencies`. Leave host packages
external when bundling, so extensions share Pi's classes and registries.

## Nix package

`nix/package.nix` fetches dependencies with a fixed-output hash over
`pnpm-lock.yaml`. After changing the lockfile, run `mise run nix:hash:update`,
then `mise run nix:hash:check`.

The package must pin pnpm with `pnpm_<major>`, matching the pnpm major version
in `mise.toml`: pnpm's store format, and with it the hash, changes between major
versions, and nixpkgs' `pnpm` follows the latest one. Bump both together, then
update the hash.

## Verify changes

Run `mise run check`. For dependency or bundling changes, also run
`nix build .#pi-extensions`.

For changes to how async bash behaves or what its prompts say, also run
`mise run eval:async-bash -- --repeat 3`, and the same with `--extension`
pointing at a build of the base commit, then compare the two.

Test runs are cached by the inputs listed in `vite.config.ts`. When tests start
reading other files, add them there.
