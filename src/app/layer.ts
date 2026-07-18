import * as Layer from "effect/Layer";

import { FastModeLive } from "../shared/fast-mode.js";

/**
 * Process/extension-lifetime capabilities only. Background resources tied to a
 * Pi session belong in session lifecycle scopes, not this application layer.
 */
export const AppLayer = Layer.mergeAll(FastModeLive);
