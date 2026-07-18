import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { installApp } from "./app/install.js";
import { AppLayer } from "./app/layer.js";

export default async function piExtensions(pi: ExtensionAPI): Promise<void> {
  const runtime = ManagedRuntime.make(AppLayer);
  let disposal: Promise<void> | undefined;
  const dispose = () => (disposal ??= runtime.dispose());

  try {
    await runtime.runPromise(installApp(pi));

    // Registered last so module shutdown handlers release their session state first.
    pi.on("session_shutdown", () => dispose());
  } catch (error) {
    await dispose();
    throw error;
  }
}
