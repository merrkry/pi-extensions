import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** One tool call and the result the model saw. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  text: string;
  isError: boolean;
  seconds: number;
}

/** A finished run of one case, as the checks see it. */
export interface Run {
  workdir: string;
  pidDirectory: string;
  port: number;
  /** Whether Pi exited on its own within the case's budget. */
  finished: boolean;
  wallSeconds: number;
  calls: ToolCall[];
  finalText: string;
  /** When the final answer started, in milliseconds since the epoch. */
  finalAt: number | undefined;
  /** Fixture processes the runner started before Pi. */
  setupPids: number[];
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/** A task distilled from a recorded failure; README.md names the record. */
export interface Case {
  name: string;
  budgetSeconds: number;
  files: Record<string, string>;
  /** Named pipes to create in the working directory; nothing writes to them. */
  fifos?: string[];
  prompt: (port: number) => string;
  /** Fixture scripts to start before Pi, outside its process groups. */
  setup?: string[];
  check: (run: Run) => Promise<Check[]>;
}

// Fixtures record their pids, so checks can tell which are alive and cleanup can stop them.
const register = (name: string) => `import os
open(os.path.join(os.environ["EVAL_PIDS"], f"${name}.{os.getpid()}"), "w").close()
`;

/** Whether a process can still run; zombies count as gone. */
export async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const status = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
  if (status === undefined) return process.platform !== "linux";
  return status.slice(status.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
}

/** Pids registered by fixtures named `name`, or by all fixtures. */
export async function registered(pidDirectory: string, name?: string): Promise<number[]> {
  const entries = await readdir(pidDirectory);
  return entries
    .filter((entry) => name === undefined || entry.startsWith(`${name}.`))
    .map((entry) => Number(entry.slice(entry.lastIndexOf(".") + 1)));
}

async function livePids(run: Run, name: string): Promise<number[]> {
  const pids = await registered(run.pidDirectory, name);
  const live = [];
  for (const pid of pids) if (await alive(pid)) live.push(pid);
  return live;
}

const check = (name: string, ok: boolean, detail?: string): Check =>
  detail === undefined ? { name, ok } : { name, ok, detail };

const within = (run: Run, seconds: number) =>
  check(
    `finished within ${seconds} s`,
    run.finished && run.wallSeconds <= seconds,
    `${Math.round(run.wallSeconds)} s`,
  );

/**
 * Bash results ended by a signal the model did not send through process kill or timeout_ms,
 * e.g. a pkill -f pattern that matched the command's own shell.
 */
export function unrequestedSignalExits(calls: ToolCall[]): number {
  return calls.filter(
    (call) =>
      call.name === "bash" &&
      /exited with code (?:137|143)\b/u.test(call.text) &&
      !/stopped by/u.test(call.text),
  ).length;
}

const STOPPED_EARLY =
  /\b(?:hang|hangs|hung|stuck|deadlock\w*|never (?:finish|complete|exit)\w*|(?:did not|didn't|does not|doesn't|not) (?:finish|complete|terminate|exit|progress)\w*|no final loss|blocked)\b/iu;

export const cases: Case[] = [
  {
    name: "hung-run",
    budgetSeconds: 300,
    files: {
      "train.py": `${register("train")}import glob, signal, time


def on_term(signum, frame):
    print("SIGTERM received; finishing the current epoch first", flush=True)


signal.signal(signal.SIGTERM, on_term)
shards = sorted(glob.glob("data/shard-*.txt"))
for epoch, shard in enumerate(shards, 1):
    with open(shard) as data:
        values = [float(value) for value in data.read().split()]
    time.sleep(2)
    loss = sum(values) / len(values)
    print(f"epoch {epoch}/{len(shards)} loss={loss:.3f}")
print(f"final loss: {loss:.3f}")
`,
      "data/shard-1.txt": "0.95 0.85\n",
      "data/shard-2.txt": "0.55 0.35\n",
    },
    // The last shard's producer never starts, so reading it blocks forever.
    fifos: ["data/shard-3.txt"],
    prompt: () =>
      "Run `python3 train.py` in this directory. It normally finishes within 20 seconds, and its last line is the final loss. Report the final loss.",
    check: async (run) => [
      within(run, 90),
      check("reports that the run hangs", STOPPED_EARLY.test(run.finalText)),
      check("leaves no run behind", (await livePids(run, "train")).length === 0),
    ],
  },
  {
    name: "watch-and-stop",
    budgetSeconds: 300,
    files: {
      "emulator.py": `${register("emulator")}import time

time.sleep(4)
while True:
    with open("frame.ppm", "wb") as frame:
        frame.write(b"P6 1 1 255\\n\\0\\0\\0")
    time.sleep(0.1)
`,
    },
    prompt: () =>
      "`python3 emulator.py` runs a game and never exits on its own. Find out roughly how many seconds after it starts it first writes frame.ppm, then stop it. Report the number of seconds.",
    check: async (run) => {
      const numbers = [...run.finalText.matchAll(/\d+(?:\.\d+)?/gu)].map(([value]) =>
        Number(value),
      );
      const frame = await stat(join(run.workdir, "frame.ppm")).catch(() => undefined);
      const stoppedBeforeAnswer =
        frame !== undefined && run.finalAt !== undefined && frame.mtimeMs < run.finalAt;
      return [
        within(run, 45),
        check(
          "reports 3 to 6 seconds",
          numbers.some((value) => value >= 3 && value <= 6),
        ),
        check("stopped the emulator before answering", stoppedBeforeAnswer),
      ];
    },
  },
  {
    name: "server",
    budgetSeconds: 300,
    files: {
      "server.py": `${register("server")}import http.server, sys


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"ok" if self.path == "/health" else b"not found"
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()
        self.wfile.write(body)


port = int(sys.argv[1])
print(f"listening on {port}", flush=True)
http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
`,
    },
    prompt: (port) =>
      `Start the HTTP service in server.py so that it listens on port ${port} and keeps running after you finish; it takes the port as its only argument. Then confirm that GET /health answers ok.`,
    check: async (run) => {
      const health = await fetch(`http://127.0.0.1:${run.port}/health`)
        .then((response) => response.text())
        .catch((error: unknown) => String(error));
      const slowest = Math.max(0, ...run.calls.map((call) => call.seconds));
      return [
        within(run, 30),
        check("server answers after Pi exits", health === "ok", health),
        check("no call waited 4 s or more", slowest < 4, `${Math.round(slowest)} s`),
        check("used at most 6 tool calls", run.calls.length <= 6, `${run.calls.length}`),
      ];
    },
  },
  {
    name: "silent-stage",
    budgetSeconds: 300,
    files: {
      "bench.py": `${register("bench")}import os, time

LOCK = ".index.lock"


def parse():
    time.sleep(3)


def index():
    open(LOCK, "w").close()
    time.sleep(3)


def query():
    while os.path.exists(LOCK):
        time.sleep(0.2)
    time.sleep(3)


def report():
    time.sleep(2)


if os.path.exists(LOCK):
    os.remove(LOCK)
for stage in (parse, index, query, report):
    started = time.time()
    stage()
    print(f"{stage.__name__}: {time.time() - started:.1f} s")
`,
    },
    prompt: () =>
      "Run `python3 bench.py` and report how long each of its stages takes. If a stage does not finish, say which.",
    check: async (run) => [
      within(run, 60),
      check("names the stage that does not finish", /\bquery\b/iu.test(run.finalText)),
      check("leaves no run behind", (await livePids(run, "bench")).length === 0),
    ],
  },
  {
    name: "restart-worker",
    budgetSeconds: 300,
    files: {
      "worker.py": `${register("worker")}import time

while True:
    time.sleep(1)
`,
    },
    setup: ["worker.py"],
    prompt: () =>
      "A `python3 worker.py` process started from this directory is running. Restart it: stop it, then start a new one from this directory that keeps running after you finish.",
    check: async (run) => {
      const live = await livePids(run, "worker");
      const oldAlive = run.setupPids.filter((pid) => live.includes(pid));
      const fresh = live.filter((pid) => !run.setupPids.includes(pid));
      const selfKills = unrequestedSignalExits(run.calls);
      return [
        within(run, 45),
        check("stopped the old worker", oldAlive.length === 0),
        check("new worker runs after Pi exits", fresh.length === 1, `${fresh.length} running`),
        check("no command killed its own shell", selfKills === 0, `${selfKills}`),
      ];
    },
  },
];
