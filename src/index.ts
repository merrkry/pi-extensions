import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import installEarlyEnv from "./early-env/install.js";
import installBetterTuiChrome from "./better-tui-chrome/install.js";
import installCodexFastMode from "./codex-fast-mode/install.js";
import installRtk from "./rtk/install.js";
import { getFastModeStore } from "./shared/fast-mode.js";
import installThinkingFilter from "./thinking-filter/install.js";
import installToolTweaks from "./tool-tweaks/install.js";

export default async function piExtensions(pi: ExtensionAPI): Promise<void> {
  // Composition order is intentional. Early env runs first (and once already at
  // module evaluation), shared state users are wired directly, synchronous event
  // handlers remain deterministic, and optional RTK discovery runs last.
  installEarlyEnv(pi);

  const fastMode = getFastModeStore();
  installCodexFastMode(pi, fastMode);
  installBetterTuiChrome(pi, fastMode);
  installThinkingFilter(pi);
  installToolTweaks(pi);

  await installRtk(pi);
}
