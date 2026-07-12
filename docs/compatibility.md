# Compatibility Notes

This document records the behavior of external extensions and CLIs that packages in this repository integrate with. Package-specific decisions—what an extension changes, preserves, or rejects in response—remain in each package's README.

These notes describe the contracts relied on by the current implementations. They are not general guarantees about similarly named tools or alternative extensions.

## `pi-unified-exec`

[`pi-unified-exec`](https://pi.dev/packages/pi-unified-exec) provides the `exec_command` shell tool. Its command text is passed as `input.cmd`, whereas Pi's built-in `bash` tool uses `input.command`.

An `exec_command` call with `tty: true` requests an interactive terminal session. Such calls preserve terminal-oriented behavior and may be continued through `write_stdin`; transforming their command text as if they were non-interactive commands can change those semantics.

The extension can be used in tool sets where `exec_command` takes the role otherwise served by `bash`. Both tools provide enough general shell and filesystem capability to overlap with Pi's dedicated `read`, `write`, `grep`, `find`, and `ls` tools. Neither can reproduce `view_image`'s model-facing image attachment.

## Subagents

The private [`@pi-extensions/subagents`](../packages/subagents/README.md) package is vendored from [`@gotgenes/pi-subagents`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents). It creates each child as an in-process Pi session, loads the parent's extensions into that child, and calls `bindExtensions()`. This fires extension `session_start` handlers against the child session. Each concurrently running child has separate session tool state, while process-global extension state is shared.

The local fork assigns optional tool-profile metadata to agent configurations. A profile is applied after extension binding, when both built-in and extension-registered tools are known. The `read-only-unified-exec` profile used by the built-in Explore and Plan presets:

- requests `bash` as its bootstrap capability while admitting unified-exec and `view_image` candidates through the SDK's pre-binding tool allowlist;
- uses the complete registered unified-exec family (`exec_command`, `write_stdin`, `kill_session`, and `list_sessions`) instead of `bash` when available;
- fails session creation if `exec_command` is registered without the rest of that family;
- falls back to `bash` when unified-exec is unavailable;
- retains `view_image` when registered; and
- excludes dedicated file tools and recursive subagent dispatch tools from the final active set.

The profile is selected by metadata, not by an agent's name or built-in/custom status. Configurations without a profile retain the post-binding active set except for the recursion guard. An omitted tool list remains unrestricted so general-purpose agents can receive extension tools; an explicit empty list remains a hard no-tools allowlist. Read-only behavior is a prompt policy: a general shell capability cannot provide a hard no-side-effects boundary.

The original upstream package only applies its recursion guard after binding and does not perform this profile reconciliation. See the local package's [`PATCH.md`](../packages/subagents/PATCH.md) for exact fork provenance and changes.

### Adding or changing tools

Any extension that registers tools or changes the active tool set must consider child-session behavior:

| Change during extension binding         | General-purpose child                                    | Explore / Plan child                                                                            |
| --------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Register and enable a new tool          | Retained automatically                                   | Excluded unless added to the profile's pre-bind candidates and final selection                  |
| Register a tool but leave it inactive   | Remains inactive                                         | A profile candidate may be reactivated because the profile treats registration as authorization |
| Disable an existing active tool         | Remains inactive                                         | A profile candidate may be reactivated during finalization                                      |
| Register another subagent-dispatch tool | Retained unless its name is added to the recursion guard | Excluded unless explicitly admitted by the profile                                              |

When adding or changing a tool:

1. Decide whether general-purpose children should inherit it. They normally inherit the post-binding active set automatically.
2. Decide whether Explore or Plan require it. If so, add it both to the SDK pre-bind candidate allowlist and to the post-bind final selection; adding it at only one stage is insufficient.
3. If several tools form one operational capability, decide whether partial registration is valid. The unified-exec family deliberately rejects partial registration.
4. If the tool dispatches child agents, add it to the recursion guard rather than relying only on its current inactive state.
5. Decide whether profile finalization may override another extension's inactive decision. There is currently no cross-extension permission or disable-reason protocol.
6. Add tests covering SDK allowlisting, extension binding, final active tools, fallback behavior, and interactions with any extension that transforms the active set.

The relevant implementation points are:

- profile candidates and capability families: [`packages/subagents/src/config/tool-profiles.ts`](../packages/subagents/src/config/tool-profiles.ts);
- built-in agent profile assignments: [`packages/subagents/src/config/default-agents.ts`](../packages/subagents/src/config/default-agents.ts);
- post-bind finalization and recursion filtering: [`packages/subagents/src/lifecycle/create-subagent-session.ts`](../packages/subagents/src/lifecycle/create-subagent-session.ts); and
- lifecycle regression tests: [`packages/subagents/test/lifecycle/create-subagent-session.test.ts`](../packages/subagents/test/lifecycle/create-subagent-session.test.ts).

Finalization runs once after `bindExtensions()`. A later asynchronous active-tool change can therefore override the finalized set; extensions should normally finish tool-state changes during binding or coordinate that later behavior explicitly.

## RTK CLI

[`rtk`](https://github.com/rtk-ai/rtk) exposes `rtk rewrite` for converting supported commands to lower-output equivalents. The rewrite protocol uses these exit codes:

| Code | Meaning                                | Rewrite output               |
| ---: | -------------------------------------- | ---------------------------- |
|  `0` | allowed                                | rewritten command on stdout  |
|  `1` | unsupported / pass through             | no rewrite should be applied |
|  `2` | deny or defer the decision to the host | no rewrite should be applied |
|  `3` | advisory / ask                         | rewritten command on stdout  |

A successful protocol outcome still needs non-empty stdout to provide a usable command. A killed or failed rewrite process does not provide a valid rewrite.

`RTK_DISABLED=1` disables rewriting. It may be set in Pi's environment for a global bypass or prefixed to one command—for example, `RTK_DISABLED=1 git status`—for a one-call bypass recognized by `rtk rewrite`. Commands already beginning with `rtk ` are also intended to pass through rather than be recursively rewritten.
