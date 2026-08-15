import type { Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { transformActiveTools } from "./policy.js";
import { injectShellSkillsPrompt } from "./skills-prompt.js";

const TEST_SKILL = {
  name: "test-skill",
  description: "A test skill",
  filePath: "/skills/test-skill/SKILL.md",
  baseDir: "/skills/test-skill",
  sourceInfo: {},
  disableModelInvocation: false,
} as Skill;

describe("transformActiveTools", () => {
  it("replaces shell-redundant tools and adds image viewing when bash is active", () => {
    expect(transformActiveTools(["read", "bash", "edit", "write", "grep", "find", "ls"])).toEqual([
      "bash",
      "edit",
      "view_image",
    ]);
  });

  it("reduces the built-in Explore and Plan tool set to bash and image viewing", () => {
    expect(transformActiveTools(["read", "bash", "grep", "find", "ls"])).toEqual([
      "bash",
      "view_image",
    ]);
  });

  it("treats exec_command as having the same shell capabilities as bash", () => {
    expect(
      transformActiveTools(["read", "exec_command", "edit", "write", "grep", "find", "ls"]),
    ).toEqual(["exec_command", "edit", "view_image"]);
  });

  it("preserves both shell tools when both are active", () => {
    expect(transformActiveTools(["read", "bash", "exec_command", "ls"])).toEqual([
      "bash",
      "exec_command",
      "view_image",
    ]);
  });

  it("preserves the complete unified-exec family", () => {
    expect(
      transformActiveTools([
        "read",
        "exec_command",
        "write_stdin",
        "kill_session",
        "list_sessions",
        "ls",
      ]),
    ).toEqual(["exec_command", "write_stdin", "kill_session", "list_sessions", "view_image"]);
  });

  it("preserves restricted tools exactly when no shell tool is available", () => {
    expect(transformActiveTools(["read", "grep", "find", "ls"])).toEqual([
      "read",
      "grep",
      "find",
      "ls",
    ]);
  });

  it("does not grant a tool to an agent with no active tools", () => {
    expect(transformActiveTools([])).toEqual([]);
  });

  it("deduplicates the resulting active set", () => {
    expect(transformActiveTools(["bash", "view_image", "view_image"])).toEqual([
      "bash",
      "view_image",
    ]);
  });
});

describe("injectShellSkillsPrompt", () => {
  it("restores skill metadata with exec_command guidance when read was replaced", () => {
    const prompt = injectShellSkillsPrompt("base", ["exec_command"], [TEST_SKILL]);

    expect(prompt).toContain("base\n\nThe following skills");
    expect(prompt).toContain(
      "Use exec_command to load a skill's file when the task matches its description.",
    );
    expect(prompt).toContain("<name>test-skill</name>");
    expect(prompt).not.toContain("read tool");
  });

  it("does not inject when read is already active", () => {
    expect(injectShellSkillsPrompt("base", ["read", "exec_command"], [TEST_SKILL])).toBeUndefined();
  });

  it("does not duplicate an existing skills section", () => {
    expect(
      injectShellSkillsPrompt("base\n<available_skills>", ["exec_command"], [TEST_SKILL]),
    ).toBeUndefined();
  });

  it("does not inject without a shell tool or visible skills", () => {
    expect(injectShellSkillsPrompt("base", ["edit"], [TEST_SKILL])).toBeUndefined();
    expect(
      injectShellSkillsPrompt(
        "base",
        ["exec_command"],
        [{ ...TEST_SKILL, disableModelInvocation: true }],
      ),
    ).toBeUndefined();
  });
});
