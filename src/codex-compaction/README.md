# Codex Compaction

Installs the pinned [`@ogulcancelik/pi-codex-compaction`](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-compaction) extension inside this bundle. The upstream extension integrates OpenAI Codex remote compaction v2 with Pi's normal compaction lifecycle, persists opaque replacement history in Pi compaction entries, and rewrites subsequent compatible Codex requests from that checkpoint.

The adapter deliberately imports the package's published `index.ts` entry because the package currently declares it only through `pi.extensions`, not a JavaScript `exports` map. The exact dependency version is pinned so an entry-path or source-layout change is encountered only during an explicit upgrade and fails during typecheck or build.

Installation follows Codex Fast Mode so the upstream request-shape cache observes `service_tier: "priority"` when fast mode is active. Do not also install the upstream package separately: duplicate factories would register duplicate compaction hooks.

Upstream configuration is read from `~/.pi/agent/pi-codex-compaction.json` and trusted project-local `.pi/pi-codex-compaction.json`. Its default proactive compaction policy is enabled at 90% context usage.
