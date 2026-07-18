import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";

import { FastMode } from "../shared/fast-mode.js";

const SERVICE_TIER = "priority";
const STATUS_KEY = "codex-fast-mode";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function installCodexFastMode(
  pi: ExtensionAPI,
): Effect.Effect<void, never, FastMode> {
  return FastMode.useSync((fastMode) => {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.setStatus(STATUS_KEY, fastMode.enabled ? "fast" : undefined);
    });

    pi.registerCommand("fast", {
      description: "Toggle Codex fast mode globally (priority service tier)",
      handler: async (_args, ctx) => {
        const enabled = fastMode.toggle();
        ctx.ui.setStatus(STATUS_KEY, enabled ? "fast" : undefined);
        ctx.ui.notify(`Codex fast mode ${enabled ? "enabled" : "disabled"}`, "info");
      },
    });

    pi.on("before_provider_request", (event, ctx) => {
      const model = ctx.model;
      if (
        !fastMode.enabled ||
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
  });
}
