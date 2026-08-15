import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import piExtensions from "../index.js";

const TEST_AGENT_DIR = "/tmp/pi-tool-tweaks-sdk-test";
const TEST_SKILL_DESCRIPTION = "Verify shell-backed skill prompt injection";

describe.sequential("tool-tweaks provider integration", () => {
  beforeAll(async () => {
    const skillDir = `${TEST_AGENT_DIR}/skills/prompt-probe`;
    await rm(TEST_AGENT_DIR, { recursive: true, force: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      `${skillDir}/SKILL.md`,
      `---\nname: prompt-probe\ndescription: ${TEST_SKILL_DESCRIPTION}\n---\nProbe instructions.\n`,
    );
  });

  afterAll(() => rm(TEST_AGENT_DIR, { recursive: true, force: true }));

  it("sends skills with exec_command guidance after replacing read", async () => {
    const request = await captureProviderRequest();

    expect(request.tools?.map((tool) => tool.name)).not.toContain("read");
    expect(request.systemPrompt).toContain(TEST_SKILL_DESCRIPTION);
    expect(request.systemPrompt).toContain(
      "Use exec_command to load a skill's file when the task matches its description.",
    );
    expect(request.systemPrompt).not.toContain("Use the read tool");
    expect(request.systemPrompt?.match(/<available_skills>/g)).toHaveLength(1);
  });

  it("defers to Pi's native skills prompt when read remains active", async () => {
    const request = await captureProviderRequest(["read"]);

    expect(request.tools?.map((tool) => tool.name)).toEqual(["read"]);
    expect(request.systemPrompt).toContain(TEST_SKILL_DESCRIPTION);
    expect(request.systemPrompt).toContain(
      "Use the read tool to load a skill's file when the task matches its description.",
    );
    expect(request.systemPrompt?.match(/<available_skills>/g)).toHaveLength(1);
  });
});

async function captureProviderRequest(tools?: string[]): Promise<Context> {
  let captured: Context | undefined;
  const faux = fauxProvider({ provider: "prompt-capture", api: "prompt-capture" });
  faux.setResponses([
    (context) => {
      captured = context;
      return fauxAssistantMessage("captured");
    },
  ]);

  const captureProvider: ExtensionFactory = (pi) => pi.registerProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: TEST_AGENT_DIR,
    extensionFactories: [piExtensions, captureProvider],
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    settingsManager,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    model: faux.getModel(),
    ...(tools === undefined ? {} : { tools }),
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  try {
    await session.bindExtensions({ mode: "print" });
    await session.prompt("Capture this provider request.");
    if (!captured) throw new Error("faux provider did not receive a request");
    return captured;
  } finally {
    session.dispose();
  }
}
