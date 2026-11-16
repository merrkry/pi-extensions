import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  /** Holds `pids/` and `secrets/`, which fixtures write and checks read. */
  stateDirectory: string;
  port: number;
  /** Whether the agent exited on its own within the case's budget. */
  finished: boolean;
  wallSeconds: number;
  calls: ToolCall[];
  finalText: string;
  /** When the final answer was recorded, in milliseconds since the epoch. */
  finalAt: number | undefined;
  /** Fixture processes the runner started before the agent. */
  setupPids: number[];
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/** A task distilled from a recorded or benchmark failure; README.md names the source. */
export interface Case {
  name: string;
  budgetSeconds: number;
  files: Record<string, string>;
  /** Named pipes to create in the working directory; nothing writes to them. */
  fifos?: string[];
  /** Python run to completion in the working directory before the agent starts. */
  prepare?: string;
  prompt: (port: number) => string;
  /** Fixture scripts to start before the agent, outside its process groups. */
  setup?: string[];
  check: (run: Run) => Promise<Check[]>;
}

/** Agents name their shell tools differently. */
export const SHELL_TOOLS = new Set(["bash", "exec_command"]);
export const SESSION_TOOLS = new Set(["process", "write_stdin"]);

/**
 * Fixtures record their pids, so checks can tell which are alive and cleanup can stop them, and
 * record digests of per-run values that answers must contain. Digests keep the values useless to
 * a model that finds the state directory.
 */
const register = (name: string) => `import hashlib, os
_STATE = os.environ["EVAL_STATE"]
open(os.path.join(_STATE, "pids", f"${name}.{os.getpid()}"), "w").close()


def record(key, value):
    with open(os.path.join(_STATE, "secrets", key), "w") as file:
        file.write(hashlib.sha256(str(value).encode()).hexdigest())


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
export async function registered(stateDirectory: string, name?: string): Promise<number[]> {
  const entries = await readdir(join(stateDirectory, "pids"));
  return entries
    .filter((entry) => name === undefined || entry.startsWith(`${name}.`))
    .map((entry) => Number(entry.slice(entry.lastIndexOf(".") + 1)));
}

async function livePids(run: Run, name: string): Promise<number[]> {
  const pids = await registered(run.stateDirectory, name);
  const live = [];
  for (const pid of pids) if (await alive(pid)) live.push(pid);
  return live;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const recorded = (run: Run, key: string) =>
  readFile(join(run.stateDirectory, "secrets", key), "utf8").catch(() => undefined);

/** Whether `text` is, or contains as a word, the value recorded under `key`. */
async function matches(run: Run, key: string, text: string | undefined): Promise<boolean> {
  const expected = await recorded(run, key);
  if (expected === undefined || text === undefined) return false;
  const words = [text.trim(), ...text.split(/[^\w.-]+/u)];
  return words.some((word) => word && digest(word) === expected);
}

const contentOf = (run: Run, name: string) =>
  readFile(join(run.workdir, name), "utf8").catch(() => undefined);

const check = (name: string, ok: boolean, detail?: string): Check =>
  detail === undefined ? { name, ok } : { name, ok, detail };

const within = (run: Run, seconds: number) =>
  check(
    `finished within ${seconds} s`,
    run.finished && run.wallSeconds <= seconds,
    `${Math.round(run.wallSeconds)} s`,
  );

const leavesNothing = async (run: Run, name: string) =>
  check(`leaves no ${name} behind`, (await livePids(run, name)).length === 0);

const unchanged = async (run: Run, name: string, source: string) =>
  check(`${name} is unchanged`, (await contentOf(run, name)) === source);

/**
 * Shell results ended by a signal the model did not send through process kill or timeout_ms,
 * e.g. a pkill -f pattern that matched the command's own shell.
 */
export function unrequestedSignalExits(calls: ToolCall[]): number {
  return calls.filter(
    (call) =>
      SHELL_TOOLS.has(call.name) &&
      /exited with code (?:137|143)\b/u.test(call.text) &&
      !/stopped by/u.test(call.text),
  ).length;
}

const STOPPED_EARLY =
  /\b(?:hang|hangs|hung|stuck|deadlock\w*|never (?:finish|complete|exit)\w*|(?:did not|didn't|does not|doesn't|not) (?:finish|complete|terminate|exit|progress)\w*|no final loss|block(?:s|ed|ing)?)\b/iu;

/** Final answers use markdown, whose emphasis would split the phrases checks look for. */
const plain = (text: string) => text.replaceAll(/[*_`]/gu, "");

const SERVICE = `${register("service")}import secrets


def handshake():
    token = secrets.token_hex(4)
    record("token", token)
    breakpoint()
    answer = input("confirm token: ")
    if answer.strip() == token:
        open("ready.txt", "w").write("ok\\n")
        print("service ready")
    else:
        open("failed.txt", "w").write(answer)
        print("handshake failed")


handshake()
`;

const CONSOLE = `${register("console")}import os, random, sys, termios, tty

if not (os.isatty(0) and os.isatty(1)):
    print("console.py: stdin and stdout must be a terminal", file=sys.stderr)
    sys.exit(1)
key = random.choice("adhjkmqsxz")
code = f"{random.randrange(10**6):06d}"
record("code", code)
print(f"Press '{key}' to unlock: ", end="", flush=True)
saved = termios.tcgetattr(0)
tty.setcbreak(0)
try:
    while os.read(0, 1).decode(errors="ignore") != key:
        print("\\nwrong key, try again: ", end="", flush=True)
    print(f"\\nunlock code: {code}", flush=True)
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, saved)
`;

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
      check("reports that the run hangs", STOPPED_EARLY.test(plain(run.finalText))),
      check("leaves no run behind", (await livePids(run, "train")).length === 0),
    ],
  },
  {
    name: "watch-and-stop",
    budgetSeconds: 300,
    files: {
      "emulator.py": `${register("emulator")}import time

HEARTBEAT = os.path.join(_STATE, "heartbeat")
time.sleep(4)
while True:
    with open("frame.ppm", "wb") as frame:
        frame.write(b"P6 1 1 255\\n\\0\\0\\0")
    open(HEARTBEAT, "w").close()
    time.sleep(0.1)
`,
    },
    prompt: () =>
      "`python3 emulator.py` runs a game and never exits on its own. Find out roughly how many seconds after it starts it first writes frame.ppm, then stop it. Report the number of seconds.",
    check: async (run) => {
      const numbers = [...run.finalText.matchAll(/\d+(?:\.\d+)?/gu)].map(([value]) =>
        Number(value),
      );
      // The heartbeat lives outside the working directory, which the model may clean up.
      const beat = await stat(join(run.stateDirectory, "heartbeat")).catch(() => undefined);
      const stoppedBeforeAnswer =
        beat !== undefined && run.finalAt !== undefined && beat.mtimeMs < run.finalAt;
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
  {
    name: "debugger-repl",
    budgetSeconds: 300,
    files: { "service.py": SERVICE },
    prompt: () =>
      "Start the service with `python3 service.py` and get it to the 'service ready' state without editing any files. Report the handshake token it used.",
    check: async (run) => {
      const ready = await contentOf(run, "ready.txt");
      const failed = await contentOf(run, "failed.txt");
      return [
        within(run, 90),
        check("reached service ready", ready !== undefined && failed === undefined),
        check("reports the token", await matches(run, "token", run.finalText)),
        await unchanged(run, "service.py", SERVICE),
        await leavesNothing(run, "service"),
      ];
    },
  },
  {
    name: "overwrite-prompt",
    budgetSeconds: 300,
    files: {
      "unarc.py": `${register("unarc")}import hashlib, json, os, sys

archive = json.load(open(sys.argv[1]))
while True:
    password = input("Password: ")
    if hashlib.sha256(password.encode()).hexdigest() == archive["check"]:
        break
    print("wrong password")
key = hashlib.sha256(password.encode()).digest()
data = bytes(byte ^ key[index % len(key)] for index, byte in enumerate(bytes.fromhex(archive["data"])))
name = archive["name"]
if os.path.exists(name):
    try:
        reply = input(f"{name} exists. Overwrite? [y/N] ")
    except EOFError:
        reply = ""
    if reply.strip().lower() != "y":
        print(f"skipped {name}")
        sys.exit(0)
open(name, "wb").write(data)
print(f"extracted {name}")
`,
      "notes.txt": "archive password: tangerine-42\n",
      "secret.txt": "decoy-0000\n",
    },
    prepare: `import hashlib, json, os, secrets
password = "tangerine-42"
content = f"secret-{secrets.token_hex(4)}"
key = hashlib.sha256(password.encode()).digest()
data = bytes(byte ^ key[index % len(key)] for index, byte in enumerate(content.encode()))
archive = {"name": "secret.txt", "check": hashlib.sha256(password.encode()).hexdigest(), "data": data.hex()}
json.dump(archive, open("secrets.arc", "w"))
open(os.path.join(os.environ["EVAL_STATE"], "secrets", "content"), "w").write(hashlib.sha256(content.encode()).hexdigest())
`,
    prompt: () =>
      "Extract secrets.arc with `python3 unarc.py secrets.arc`; the password is in notes.txt. Then write the content of the extracted secret.txt to answer.txt.",
    check: async (run) => {
      const answer = (await contentOf(run, "answer.txt"))?.trim();
      return [
        within(run, 60),
        check(
          "answer.txt holds the extracted secret",
          await matches(run, "content", answer),
          answer,
        ),
        await leavesNothing(run, "unarc"),
      ];
    },
  },
  {
    name: "needs-tty",
    budgetSeconds: 300,
    files: { "console.py": CONSOLE },
    prompt: () =>
      "Get the unlock code from `python3 console.py` and write it to code.txt. Do not modify console.py.",
    check: async (run) => {
      const written = (await contentOf(run, "code.txt"))?.trim();
      return [
        within(run, 90),
        check("code.txt holds the unlock code", await matches(run, "code", written), written),
        await unchanged(run, "console.py", CONSOLE),
        await leavesNothing(run, "console"),
      ];
    },
  },
  {
    name: "ctrl-c-summary",
    budgetSeconds: 300,
    files: {
      "collector.py": `${register("collector")}import json, random, secrets, time

nonce = secrets.token_hex(4)
record("nonce", nonce)
values = []
try:
    while True:
        values.append(random.random())
        if len(values) % 5 == 0:
            print(f"{len(values)} samples", flush=True)
        time.sleep(0.2)
except KeyboardInterrupt:
    mean = sum(values) / len(values)
    with open("summary.json", "w") as summary:
        json.dump({"n": len(values), "mean": round(mean, 4), "nonce": nonce}, summary)
    print(f"interrupted after {len(values)} samples, mean {mean:.4f}")
`,
    },
    prompt: () =>
      "Run `python3 collector.py` for at least 5 seconds, then stop it the way you would with Ctrl-C, so that it writes summary.json. Report the mean.",
    check: async (run) => {
      const raw = await contentOf(run, "summary.json");
      const summary = raw
        ? (JSON.parse(raw) as { n: number; mean: number; nonce: string })
        : undefined;
      const valid =
        summary !== undefined && summary.n >= 25 && (await matches(run, "nonce", summary.nonce));
      const reported =
        summary !== undefined &&
        (run.finalText.includes(summary.mean.toFixed(4)) ||
          run.finalText.includes(summary.mean.toFixed(3)));
      return [
        within(run, 60),
        check("summary.json written after 5 s or more", valid, raw),
        check("reports the mean", reported),
        await leavesNothing(run, "collector"),
      ];
    },
  },
  {
    name: "flood-once",
    budgetSeconds: 300,
    files: {
      "suite.py": `${register("suite")}import random, secrets, sys, time

TESTS = 400_000
failing = random.randrange(TESTS * 3 // 10, TESTS * 7 // 10)
name = f"test_{secrets.token_hex(3)}"
expected, got = secrets.token_hex(4), secrets.token_hex(4)
record("name", name)
record("expected", f"0x{expected}")
record("got", f"0x{got}")
for index in range(TESTS):
    if index == failing:
        sys.stdout.write(f"FAILED {name}: expected 0x{expected} got 0x{got}\\n")
    else:
        sys.stdout.write(f"test_{index:06d} ... ok\\n")
    if index % 20_000 == 0:
        sys.stdout.flush()
        time.sleep(1)
print(f"1 failed, {TESTS - 1} passed (details above)")
`,
    },
    prompt: () =>
      "Run `python3 suite.py` once. It takes about 20 seconds and is expensive, so do not run it again. Report which test failed and its error message.",
    check: async (run) => {
      const runs = (await registered(run.stateDirectory, "suite")).length;
      const reported = await Promise.all(
        ["name", "expected", "got"].map((key) => matches(run, key, run.finalText)),
      );
      return [
        within(run, 75),
        check("reports the failing test and message", reported.every(Boolean)),
        check("ran the suite once", runs === 1, `${runs} runs`),
      ];
    },
  },
  {
    name: "redraw-stall",
    budgetSeconds: 300,
    files: {
      "fetch.py": `${register("fetch")}import argparse, hashlib, os, sys, time

parser = argparse.ArgumentParser(description="Download the dataset to data.bin.")
parser.add_argument("--mirror", type=int, default=1, help="1: primary, 2: fallback")
mirror = parser.parse_args().mirror
total, done, started = 65.0, 0.0, time.time()
spinner = "|/-\\\\"
step = 0
while done < total:
    step += 1
    elapsed = time.time() - started
    if mirror == 2 or done < total * 0.63:
        done = min(total, done + (8.0 if mirror == 2 else 3.1) * 0.02)
    bar = "#" * int(20 * done / total)
    sys.stdout.write(f"\\r[{bar:<20}] {done:5.1f}/{total} MB {spinner[step % 4]} elapsed {elapsed:5.1f}s")
    sys.stdout.flush()
    time.sleep(0.02)
data = os.urandom(1 << 20)
open("data.bin", "wb").write(data)
digest = hashlib.sha256(data).hexdigest()
record("sha256", digest)
print(f"\\ndone, sha256 {digest}")
`,
      "README.txt":
        "fetch.py downloads the dataset to data.bin. If the primary mirror is slow or stalls, pass --mirror 2.\n",
    },
    prompt: () =>
      "Download the dataset with `python3 fetch.py`. It usually takes about 15 seconds. Report the sha256 it prints.",
    check: async (run) => {
      return [
        within(run, 90),
        check("reports the sha256", await matches(run, "sha256", run.finalText)),
        await leavesNothing(run, "fetch"),
      ];
    },
  },
];
