import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";

import installUpstreamCodexCompaction from "./upstream.js";

const installUpstream: ExtensionFactory = installUpstreamCodexCompaction;

/** Install the pinned upstream extension into this bundle's deterministic hook order. */
export default function installCodexCompaction(pi: ExtensionAPI): Effect.Effect<void> {
  return Effect.sync(() => installUpstream(pi));
}
