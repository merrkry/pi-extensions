const SHELL_REPLACED_TOOLS = new Set(["read", "write", "grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "exec_command"]);

export function transformActiveTools(initiallyActive: readonly string[]): string[] {
  if (!initiallyActive.some((toolName) => SHELL_TOOLS.has(toolName))) {
    return [...new Set(initiallyActive)];
  }

  const activeTools = initiallyActive.filter((toolName) => !SHELL_REPLACED_TOOLS.has(toolName));
  return [...new Set([...activeTools, "view_image"])];
}
