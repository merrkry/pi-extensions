# Web Access

This module installs the exactly pinned `pi-web-access` package inside the root bundle so its extension registration participates in the deterministic application composition order.

The package publishes its Pi entry as `index.ts` without a JavaScript export. `upstream.js` deliberately imports that entry for esbuild, while `upstream.d.ts` keeps this repository's stricter TypeScript settings at the `ExtensionFactory` boundary.

The build copies the upstream `skills/` directory next to `dist/index.js`. The module exposes that directory through Pi's `resources_discover` event, so the bundled `librarian` skill works in development and after `pnpm run apply` without a separate package installation.

Do not also load `npm:pi-web-access` from Pi settings; doing so creates two independent extension instances with duplicate registrations and lifecycle state.
