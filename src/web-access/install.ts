import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import installUpstreamWebAccess from "./upstream.js";

const installUpstream: ExtensionFactory = installUpstreamWebAccess;
const bundleDirectory = dirname(fileURLToPath(import.meta.url));
const skillDirectory = join(bundleDirectory, "skills");

/** Install the pinned upstream extension and expose its bundled skill through Pi. */
export default function installWebAccess(pi: ExtensionAPI): Effect.Effect<void> {
  return Effect.sync(() => {
    installUpstream(pi);
    pi.on("resources_discover", () => ({ skillPaths: [skillDirectory] }));
  });
}
