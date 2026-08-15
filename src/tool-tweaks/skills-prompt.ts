import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

const SKILLS_MARKER = "<available_skills>";
const READ_SKILL_GUIDANCE =
  "Use the read tool to load a skill's file when the task matches its description.";

export function injectShellSkillsPrompt(
  systemPrompt: string,
  activeTools: readonly string[],
  skills: Skill[],
): string | undefined {
  if (activeTools.includes("read") || systemPrompt.includes(SKILLS_MARKER)) return undefined;

  let shellTool: "exec_command" | "bash" | undefined;
  if (activeTools.includes("exec_command")) shellTool = "exec_command";
  else if (activeTools.includes("bash")) shellTool = "bash";
  if (!shellTool) return undefined;

  const skillsPrompt = formatSkillsForPrompt(skills);
  if (!skillsPrompt || !skillsPrompt.includes(READ_SKILL_GUIDANCE)) return undefined;

  const shellGuidance = `Use ${shellTool} to load a skill's file when the task matches its description.`;
  const adaptedPrompt = skillsPrompt.replace(READ_SKILL_GUIDANCE, shellGuidance);
  return `${systemPrompt}${adaptedPrompt}`;
}
