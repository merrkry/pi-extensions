import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";

import installEarlyEnv from "../early-env/install.js";
import installBetterTuiChrome from "../better-tui-chrome/install.js";
import installCodexFastMode from "../codex-fast-mode/install.js";
import installRtk from "../rtk/install.js";
import { FastMode } from "../shared/fast-mode.js";
import installThinkingFilter from "../thinking-filter/install.js";
import installToolTweaks from "../tool-tweaks/install.js";
import installUnifiedExec from "../unified-exec/install.js";
import { UnifiedExec } from "../unified-exec/service.js";

/** Register modules in deterministic order while services remain explicit requirements. */
export function installApp(pi: ExtensionAPI): Effect.Effect<void, never, FastMode | UnifiedExec> {
  return Effect.gen(function* () {
    // This is the intentional second early-env load; the first remains at module evaluation.
    yield* Effect.sync(() => installEarlyEnv(pi));
    yield* installCodexFastMode(pi);
    yield* installBetterTuiChrome(pi);
    yield* Effect.sync(() => installThinkingFilter(pi));
    yield* installUnifiedExec(pi);
    yield* Effect.sync(() => installToolTweaks(pi));
    yield* installRtk(pi);
  });
}
