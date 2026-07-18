import { describe, expect, it, vi } from "vitest";

import { createFastModeStore } from "./fast-mode.js";

describe("fast-mode store", () => {
  it("coordinates process users and stops notifying disposed subscriptions", () => {
    const store = createFastModeStore();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = store.subscribe(first);
    store.subscribe(second);

    expect(store.toggle()).toBe(true);
    expect(first).toHaveBeenCalledWith(true);
    expect(second).toHaveBeenCalledWith(true);

    unsubscribeFirst();
    store.setEnabled(false);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenLastCalledWith(false);
  });
});
