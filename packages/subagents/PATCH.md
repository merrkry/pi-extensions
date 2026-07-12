# Patch Notes

This file tracks the upstream snapshot and the local changes carried by this fork.
Update it whenever upstream is synchronized or local behavior diverges further.

## Upstream

- Original project: [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)
- Immediate upstream fork: [`@gotgenes/pi-subagents`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents)
- Vendored version: `@gotgenes/pi-subagents@18.0.1`
- Vendored commit: [`df49079e98736824994f82c98035b321a9b2ce78`](https://github.com/gotgenes/pi-packages/tree/df49079e98736824994f82c98035b321a9b2ce78/packages/pi-subagents)

## Local changes

### Monorepo integration

- Renamed the private workspace package to `@pi-extensions/subagents` and placed it in `packages/subagents`.
- Marked the package private; this fork is not currently published.
- Adapted package metadata, TypeScript configuration, formatting, linting, tests, and build commands to this repository's workflows.
- Retained the upstream MIT license and compatibility identifiers used by integrations.

### Tool allowlist semantics

- Preserve Pi SDK's three distinct tool states: omitted means extension tools are unrestricted, an empty list denies all tools, and a non-empty list is a hard allowlist.
- Keep general-purpose unrestricted so it receives extension tools like the parent session, while preserving `tools: none` and explicit custom-agent allowlists.

### Read-only agent tool profile

- Explore and Plan request only the built-in shell as their bootstrap tool. Before session creation, their profile expands the SDK's hard tool allowlist with unified-exec and `view_image` candidates so extension-registered tools are not filtered out during binding.
- After extension binding, replace the built-in shell and redundant dedicated file tools with the complete registered unified-exec family: `exec_command`, `write_stdin`, `kill_session`, and `list_sessions`.
- Add `view_image` when registered, preserving image inspection that a shell cannot provide.
- Fall back to the built-in shell when unified-exec is unavailable.
- Continue excluding recursive subagent dispatch tools from child sessions.
- Select this behavior through explicit `toolProfile` metadata. The built-in Explore and Plan definitions use the profile; names and whether a configuration is built-in do not affect profile execution.
- Treat `exec_command` registration as an assertion that the complete unified-exec family is present, and fail child-session creation if that invariant is broken.

The complete unified-exec family is intentionally exposed so a child can control long-running command sessions. Read-only behavior is a prompt-level policy rather than a hard capability boundary.

### Read-only prompts

- Removed instructions tied to specific tool names.
- Describe the required behavior in capability terms and require all operations to remain read-only.
