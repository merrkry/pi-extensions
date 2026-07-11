import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SERVICE_TIER = "priority";
const STATUS_KEY = "codex-fast-mode";
const STATE_EVENT = "codex-fast-mode:state";
const STATE_REQUEST_EVENT = "codex-fast-mode:state-request";
const GLOBAL_STATE_KEY = Symbol.for("@pi-extensions/codex-fast-mode:state");

type FastModeState = { enabled: boolean };

function getGlobalState(): FastModeState {
  const globalScope = globalThis as unknown as Record<symbol, unknown>;
  const existing = globalScope[GLOBAL_STATE_KEY];
  if (isRecord(existing) && typeof existing.enabled === "boolean") {
    return existing as FastModeState;
  }

  const state: FastModeState = { enabled: false };
  globalScope[GLOBAL_STATE_KEY] = state;
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function codexFastMode(pi: ExtensionAPI) {
  const state = getGlobalState();

  function publishState(): void {
    pi.events.emit(STATE_EVENT, { enabled: state.enabled });
  }

  pi.events.on(STATE_REQUEST_EVENT, publishState);

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, state.enabled ? "fast" : undefined);
    publishState();
  });

  pi.registerCommand("fast", {
    description: "Toggle Codex fast mode globally (priority service tier)",
    handler: async (_args, ctx) => {
      state.enabled = !state.enabled;
      ctx.ui.setStatus(STATUS_KEY, state.enabled ? "fast" : undefined);
      ctx.ui.notify(`Codex fast mode ${state.enabled ? "enabled" : "disabled"}`, "info");
      publishState();
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (
      !state.enabled ||
      !model ||
      model.provider !== "openai-codex" ||
      !ctx.modelRegistry.isUsingOAuth(model) ||
      !isRecord(event.payload)
    ) {
      return;
    }

    return {
      ...event.payload,
      service_tier: SERVICE_TIER,
    };
  });
}
