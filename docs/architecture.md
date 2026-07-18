# Architecture

## Shape

This repository produces one Pi extension bundle. Features are internal modules, not independently installable packages.

```text
src/
├── index.ts       # Pi boundary and application lifetime
├── app/           # service composition and feature installation
├── <feature>/     # feature code and Pi adapter
└── shared/        # genuinely shared contracts and utilities
```

A feature should keep its core behavior and Pi integration together under one folder. Use role-oriented filenames such as `install.ts`, `service.ts`, or `policy.ts`; an `index.ts` is not required. Small features may remain in one file, while larger ones should separate pure core logic from Pi-facing glue.

## Unified exec

`src/unified-exec/` is the internal Effect-based successor to the external `pi-unified-exec` extension. Pure protocol, shell, buffering, and rendering code stays separate from process ownership. `UnifiedExec` is the capability boundary: its scoped Layer owns the session registry, bounds concurrent spawns, serializes operations per session, exposes typed failures, and terminates remaining process trees when its scope closes.

Pi tool callbacks are the error-display boundary. Calls run as interruptible Effects using Pi's abort signal; interrupting a wait does not terminate the owned process. A one-element sliding Effect Queue bridges process callbacks into interruptible output waits without losing a notification between draining and waiting. The service registry is protected by a semaphore, while each session has its own semaphore to prevent concurrent polls from racing to drain the same output.

The module is a product-focused redesign derived from `pi-unified-exec`, not a line-for-line port. It preserves the four core tool names and session-oriented behavior. Tool rendering, the footer process count, `/processes`, and the one-shot Agent-run inventory are Pi boundary concerns built from immutable service snapshots. Processes are owned by the current Pi session runtime: turn cancellation and `/tree` preserve them, while session replacement, reload, and shutdown terminate them. The PTY implementation uses the maintained official `node-pty` package; pipe mode remains available if the optional native module cannot load.

## Composition

`src/app/` is the composition root:

- installation order is explicit;
- service implementations are assembled there;
- feature implementation details stay in their owning modules.

Modules must not communicate through incidental import, extension, or handler registration order. Order in the composition root exists to make startup deterministic, not to carry state between features.

Dependencies should point toward contracts and core logic. A feature may expose a narrow capability contract when another feature needs it, but consumers must not import its live implementation.

## Effect

Use Effect where it gives the domain stronger semantics: typed failures, external-data decoding, cancellation, concurrency, shared state, or managed resources. Keep straightforward pure transformations and rendering as plain TypeScript.

Expected failures should remain typed until the owning Pi adapter decides how they appear to the user or model. Resources and background work must have explicit lifetimes and structured cancellation; avoid floating Promises, manual cancellation chains, and unscoped timers or subscriptions.

Use stable Effect APIs by default. Pi-facing tool schemas remain TypeBox schemas at the host boundary.

## Cross-module capabilities

Cross-module behavior is expressed through typed Effect services:

- `Context.Service` defines a capability contract;
- `Layer` provides and composes implementations;
- state or event streams remain encapsulated behind the service that owns them.

Do not replace explicit services with a growing parameter list, an omnibus service bag, a global service locator, or a generic internal event bus. Use `pi.events` only for intentional interoperability with external extensions, with a documented contract.

Create a service only when a capability crosses a module boundary. Private feature state and helpers should remain private.

## Lifetimes

The application runtime owns extension-lifetime services. Session-specific resources start from Pi session lifecycle handlers and are released on session shutdown. Process-global behavior, when required, is hidden inside the relevant service implementation rather than exposed to consumers.

## Adding a feature

When adding functionality:

1. Put the feature in its own module and keep Pi glue at its boundary.
2. Model failures and resource lifetime before adding recovery logic.
3. Introduce a service only for capabilities consumed by another module.
4. Compose new Layers and installation explicitly under `src/app/`.
5. Add focused core or integration tests at the boundary being introduced.
6. Update [compatibility notes](compatibility.md) only when an external contract changes.
