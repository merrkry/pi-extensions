import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";

import codexFastMode from "./index.js";

const GLOBAL_STATE_KEY = Symbol.for("@pi-extensions/codex-fast-mode:state");

describe.sequential("codex-fast-mode SDK integration", () => {
  beforeEach(() => {
    delete (globalThis as unknown as Record<symbol, unknown>)[GLOBAL_STATE_KEY];
  });

  it("carries global toggles into sessions bound after enabling and disabling", async () => {
    const eventBus = createEventBus();
    const states: boolean[] = [];
    eventBus.on("codex-fast-mode:state", (data) => {
      states.push((data as { enabled: boolean }).enabled);
    });

    const parent = await createSession(eventBus);
    const childAfterEnable = await createSession(eventBus);
    const childAfterDisable = await createSession(eventBus);

    try {
      await parent.prompt("/fast");
      await childAfterEnable.bindExtensions({});
      expect(states.at(-1)).toBe(true);

      await parent.prompt("/fast");
      await childAfterDisable.bindExtensions({});
      expect(states.at(-1)).toBe(false);
    } finally {
      parent.dispose();
      childAfterEnable.dispose();
      childAfterDisable.dispose();
    }
  });
});

async function createSession(eventBus: ReturnType<typeof createEventBus>) {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: "/tmp/pi-codex-fast-mode-sdk-test",
    eventBus,
    extensionFactories: [codexFastMode],
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
