import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export type FastModeListener = (enabled: boolean) => void;

export interface FastModeApi {
  readonly enabled: boolean;
  setEnabled(enabled: boolean): void;
  toggle(): boolean;
  subscribe(listener: FastModeListener): () => void;
}

export class FastMode extends Context.Service<FastMode, FastModeApi>()("@pi-extensions/FastMode") {}

const GLOBAL_FAST_MODE_STORE = Symbol.for("@pi-extensions/fast-mode:store");

function makeFastMode(initialEnabled = false): FastModeApi {
  let enabled = initialEnabled;
  const listeners = new Set<FastModeListener>();

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(nextEnabled) {
      if (nextEnabled === enabled) return;
      enabled = nextEnabled;
      for (const listener of listeners) listener(enabled);
    },
    toggle() {
      this.setEnabled(!enabled);
      return enabled;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function getProcessFastMode(): FastModeApi {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_FAST_MODE_STORE]?: FastModeApi;
  };
  return (scope[GLOBAL_FAST_MODE_STORE] ??= makeFastMode());
}

/** Process-lifetime implementation shared by every extension runtime in this process. */
export const FastModeLive = Layer.sync(FastMode, getProcessFastMode);
