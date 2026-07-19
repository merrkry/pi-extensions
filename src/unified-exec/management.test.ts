import { describe, expect, it } from "vitest";

import { hideSessionsExitedAtOpen } from "./management.js";
import type { SessionPhase, SessionSnapshot } from "./service.js";

function snapshot(sessionId: number, phase: SessionPhase): SessionSnapshot {
  return {
    sessionId,
    phase,
    pid: sessionId,
    command: `command-${sessionId}`,
    cwd: "/tmp",
    tty: false,
    startedAt: 1,
    endedAt: phase === "exited" ? 2 : undefined,
    requestedSignal: undefined,
    exitCode: phase === "exited" ? 0 : null,
    exitSignal: null,
    failureMessage: null,
    outputBytesTotal: 0,
    logPath: `/tmp/${sessionId}.log`,
  };
}

describe("process manager visibility", () => {
  it("hides only sessions that had exited when the manager opened", () => {
    const filterInventory = hideSessionsExitedAtOpen([
      snapshot(1, "exited"),
      snapshot(2, "running"),
    ]);

    const visible = filterInventory([
      snapshot(1, "exited"),
      snapshot(2, "exited"),
      snapshot(3, "exited"),
      snapshot(4, "running"),
    ]);

    expect(visible.map((session) => session.sessionId)).toEqual([2, 3, 4]);
  });
});
