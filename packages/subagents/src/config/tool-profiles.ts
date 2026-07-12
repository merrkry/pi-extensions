import type { AgentToolProfile } from "#src/types";

export const UNIFIED_EXEC_TOOL_NAMES = [
  "exec_command",
  "write_stdin",
  "kill_session",
  "list_sessions",
] as const;

const PROFILE_ALLOWED_TOOL_NAMES: Record<AgentToolProfile, readonly string[]> = {
  "read-only-unified-exec": ["bash", ...UNIFIED_EXEC_TOOL_NAMES, "view_image"],
};

/**
 * Expand a session's hard tool allowlist with capabilities its post-bind
 * profile may select. Unregistered extension tools remain unavailable.
 */
export function getProfileAllowedToolNames(
  profile: AgentToolProfile | undefined,
  initialToolNames: readonly string[] | undefined,
): string[] | undefined {
  // Preserve the SDK's three states: undefined is unrestricted, [] denies all,
  // and a non-empty array is a hard allowlist. A profile intentionally replaces
  // either base state with its explicit candidate allowlist.
  if (!profile) return initialToolNames === undefined ? undefined : [...initialToolNames];
  return [...new Set([...(initialToolNames ?? []), ...PROFILE_ALLOWED_TOOL_NAMES[profile]])];
}
