import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppLayer } from "../app/layer.js";
import { FastMode } from "../shared/fast-mode.js";

const TEST_AGENT_DIR = "/tmp/pi-codex-fast-mode-sdk-test";
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let piExtensions: ExtensionFactory;
const serviceRuntime = ManagedRuntime.make(AppLayer);

describe.sequential("codex-fast-mode SDK integration", () => {
  beforeAll(async () => {
    process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR;
    piExtensions = (await import("../index.js")).default;
  });

  afterAll(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await serviceRuntime.dispose();
  });

  beforeEach(async () => {
    await serviceRuntime.runPromise(FastMode.useSync((fastMode) => fastMode.setEnabled(false)));
  });

  it("does not reset process-global toggles while later sessions bind", async () => {
    const parent = await createSession();
    const childAfterEnable = await createSession();
    const childAfterDisable = await createSession();

    try {
      await parent.prompt("/fast");
      await childAfterEnable.bindExtensions({});
      expect(await fastModeEnabled()).toBe(true);

      await parent.prompt("/fast");
      await childAfterDisable.bindExtensions({});
      expect(await fastModeEnabled()).toBe(false);
    } finally {
      parent.dispose();
      childAfterEnable.dispose();
      childAfterDisable.dispose();
    }
  });
});

function fastModeEnabled(): Promise<boolean> {
  return serviceRuntime.runPromise(FastMode.useSync((fastMode) => fastMode.enabled));
}

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
