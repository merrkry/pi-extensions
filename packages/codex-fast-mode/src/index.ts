import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SERVICE_TIER = "priority";
const STATUS_KEY = "codex-fast-mode";
const STATE_EVENT = "codex-fast-mode:state";
const STATE_REQUEST_EVENT = "codex-fast-mode:state-request";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function codexFastMode(pi: ExtensionAPI) {
  let enabled = false;

  function publishState(): void {
    pi.events.emit(STATE_EVENT, { enabled });
  }

  pi.events.on(STATE_REQUEST_EVENT, publishState);

  pi.on("session_start", publishState);

  pi.registerCommand("fast", {
    description: "Toggle Codex fast mode (priority service tier)",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      ctx.ui.setStatus(STATUS_KEY, enabled ? "fast" : undefined);
      ctx.ui.notify(`Codex fast mode ${enabled ? "enabled" : "disabled"}`, "info");
      publishState();
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (
      !enabled ||
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
