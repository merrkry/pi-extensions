export type FastModeListener = (enabled: boolean) => void;

export interface FastModeStore {
  readonly enabled: boolean;
  setEnabled(enabled: boolean): void;
  toggle(): boolean;
  subscribe(listener: FastModeListener): () => void;
}

const GLOBAL_FAST_MODE_STORE = Symbol.for("@pi-extensions/fast-mode:store");

export function createFastModeStore(initialEnabled = false): FastModeStore {
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

export function getFastModeStore(): FastModeStore {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_FAST_MODE_STORE]?: FastModeStore;
  };
  return (scope[GLOBAL_FAST_MODE_STORE] ??= createFastModeStore());
}
