import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getFastModeStore } from "../shared/fast-mode.js";

const TEST_AGENT_DIR = "/tmp/pi-codex-fast-mode-sdk-test";
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let piExtensions: ExtensionFactory;

describe.sequential("codex-fast-mode SDK integration", () => {
  beforeAll(async () => {
    process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR;
    piExtensions = (await import("../index.js")).default;
  });

  afterAll(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  beforeEach(() => {
    getFastModeStore().setEnabled(false);
  });

  it("does not reset process-global toggles while later sessions bind", async () => {
    const parent = await createSession();
    const childAfterEnable = await createSession();
    const childAfterDisable = await createSession();

    try {
      await parent.prompt("/fast");
      await childAfterEnable.bindExtensions({});
      expect(getFastModeStore().enabled).toBe(true);

      await parent.prompt("/fast");
      await childAfterDisable.bindExtensions({});
      expect(getFastModeStore().enabled).toBe(false);
    } finally {
      parent.dispose();
      childAfterEnable.dispose();
      childAfterDisable.dispose();
    }
  });
});

async function createSession() {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: TEST_AGENT_DIR,
    extensionFactories: [piExtensions],
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    settingsManager,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    noTools: "all",
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });
  return session;
}
