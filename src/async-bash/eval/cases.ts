import { readdir, readFile } from "node:fs/promises";
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
  /** Holds `secrets/` and `started/`, which fixtures write and checks read. */
  stateDirectory: string;
  port: number;
  /** Whether the agent exited on its own within the case's budget. */
  finished: boolean;
  wallSeconds: number;
  calls: ToolCall[];
  finalText: string;
  /**
   * When the agent started its final answer, in milliseconds since the epoch: the last tool
   * result before it, so anything the agent stopped had stopped by then. Undefined when no tool
   * returned before the answer.
   */
  answerStartedAt: number | undefined;
  /** The fixture processes the runner saw while the agent ran. */
  fixtures: Sighting[];
}

/**
 * A process running one of a case's Python scripts, from the first to the last time the runner saw
 * it, in milliseconds since the epoch. The runner looks every `SIGHTING_INTERVAL_MS`; a run that
 * ended before it looked counts as seen once, when it started.
 */
export interface Sighting {
  /** The script's name without `.py`. */
  name: string;
  pid: number;
  firstSeen: number;
  lastSeen: number;
}

export const SIGHTING_INTERVAL_MS = 200;

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
  /** Python run to completion in the working directory before the agent starts. */
  prepare?: string;
  prompt: (port: number) => string;
  check: (run: Run) => Promise<Check[]>;
}

/** Agents name their shell tools differently. */
export const SHELL_TOOLS = new Set(["bash", "exec_command"]);
export const SESSION_TOOLS = new Set(["process", "write_stdin"]);

/**
 * Fixtures record digests of per-run values that answers must contain. Digests keep the values
 * useless to a model that finds the state directory. Each also marks that it started, for runs too
 * short for the runner to see; the runner tracks longer ones itself.
 */
const RECORDER = `import hashlib, os, sys, time

open(os.path.join(os.environ["EVAL_STATE"], "started", f"{os.path.basename(sys.argv[0])[:-3]}.{os.getpid()}"), "w").close()


def record(key, value):
    with open(os.path.join(os.environ["EVAL_STATE"], "secrets", key), "w") as file:
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

const sightingsOf = (run: Run, name: string) =>
  run.fixtures.filter((fixture) => fixture.name === name);

async function livePids(run: Run, name: string): Promise<number[]> {
  const live = [];
  for (const { pid } of sightingsOf(run, name)) if (await alive(pid)) live.push(pid);
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

/** Whether `text` holds a value recorded under any key starting with `prefix`. */
async function someMatches(run: Run, prefix: string, text: string): Promise<boolean> {
  const keys = await readdir(join(run.stateDirectory, "secrets"));
  for (const key of keys.filter((entry) => entry.startsWith(prefix))) {
    if (await matches(run, key, text)) return true;
  }
  return false;
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

/**
 * Whether the model ran fixture `name` and every run of it had stopped before the model started
 * its answer. Pi stops its sessions when it exits, after the answer, so being gone at check time
 * proves nothing. The runner sees a fixture still running when the answer starts again before Pi
 * exits: generating an answer takes far longer than `SIGHTING_INTERVAL_MS`, at least 0.8 s in
 * recorded runs.
 */
function stoppedBeforeAnswer(run: Run, name: string): Check {
  const label = `ran ${name} and stopped it before answering`;
  const sightings = sightingsOf(run, name);
  if (sightings.length === 0) return check(label, false, "never ran");
  const answer = run.answerStartedAt;
  return check(
    label,
    answer !== undefined && sightings.every((fixture) => fixture.lastSeen < answer),
  );
}

const unchanged = async (run: Run, name: string, source: string) =>
  check(`${name} is unchanged`, (await contentOf(run, name)) === source);

/**
 * Commands ended by a signal the model did not send through process kill or timeout_ms, e.g. a
 * pkill -f pattern that matched the command's own shell. A command still running when its first
 * call returned shows its exit in a session call, possibly in several; each session counts once.
 * Kills are recognized by the call rather than its result text, which differs between builds.
 */
export function unrequestedSignalExits(calls: ToolCall[]): number {
  const killed = new Set<unknown>();
  const commands = new Set<unknown>();
  for (const call of calls) {
    const session = call.args["session_id"];
    if (call.name === "process" && call.args["action"] === "kill") killed.add(session);
    if (
      !/exited with code (?:137|143)\b/u.test(call.text) ||
      /stopped by timeout_ms/u.test(call.text)
    ) {
      continue;
    }
    if (SHELL_TOOLS.has(call.name)) commands.add(call);
    // A list names no session, and every session it shows was seen through another call.
    else if (SESSION_TOOLS.has(call.name) && session !== undefined && !killed.has(session)) {
      commands.add(session);
    }
  }
  return commands.size;
}

const STOPPED_EARLY =
  /\b(?:hang|hangs|hung|stuck|deadlock\w*|never (?:finish|complete|exit)\w*|(?:did not|didn't|does not|doesn't|not) (?:finish|complete|terminate|exit|progress)\w*|no final loss|block(?:s|ed|ing)?)\b/iu;

/** Final answers use markdown, whose emphasis would split the phrases checks look for. */
const plain = (text: string) => text.replaceAll(/[*_`]/gu, "");

const TRAINING_SHARDS = 40;
const HUNG_SHARD = 4;

const TRAIN = `${RECORDER}import signal, subprocess


def on_term(signum, frame):
    print("SIGTERM received; finishing the current epoch first", flush=True)


def load(parts):
    paths = [f"data/{part}" for part in parts]
    return [float(value) for value in subprocess.run(["zcat", *paths], stdout=subprocess.PIPE, check=True).stdout.split()]


signal.signal(signal.SIGTERM, on_term)
manifest = [line.split(":") for line in open("data/manifest.txt").read().splitlines()]
print(f"training on {len(manifest)} shards", flush=True)
for epoch, (shard, parts) in enumerate(manifest, 1):
    values = load(parts.split())
    deadline = time.time() + 4
    while time.time() < deadline:
        sum(index * index for index in range(10_000))
    loss = sum(values) / len(values)
    print(f"epoch {epoch}/{len(manifest)} {shard} loss={loss:.3f}", flush=True)
print(f"final loss: {loss:.3f}", flush=True)
`;

const SERVICE = `${RECORDER}import secrets


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

const CONSOLE = `${RECORDER}import os, random, sys, termios, tty

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
      "train.py": TRAIN,
    },
    // The manifest lists no parts for one shard, so zcat reads the command's stdin, which stays
    // open; TERM only makes train.py print.
    prepare: `import gzip, os
os.makedirs("data")
lines = []
for shard in range(1, ${TRAINING_SHARDS + 1}):
    name = f"shard-{shard:02d}"
    parts = [] if shard == ${HUNG_SHARD} else [f"{name}-{half}.gz" for half in "ab"]
    for index, part in enumerate(parts):
        with gzip.open(f"data/{part}", "wt") as file:
            file.write(f"{(1 - index / 10) / shard:.3f}\\n")
    lines.append(f"{name}: {' '.join(parts)}".rstrip())
open("data/manifest.txt", "w").write("\\n".join(lines) + "\\n")
`,
    prompt: () =>
      "Train the model with `python3 train.py` and report the final loss. Training takes a few minutes. Run it as it is; do not change any files.",
    check: async (run) => [
      within(run, 120),
      check(
        "reports that the run cannot finish",
        STOPPED_EARLY.test(plain(run.finalText)) ||
          /\b(?:crash\w*|fail\w*)\b/iu.test(run.finalText),
      ),
      await unchanged(run, "train.py", TRAIN),
      stoppedBeforeAnswer(run, "train"),
    ],
  },
  {
    name: "watch-and-stop",
    budgetSeconds: 300,
    files: {
      "emulator.py": `${RECORDER}time.sleep(4)
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
      return [
        within(run, 45),
        check(
          "reports 3 to 6 seconds",
          numbers.some((value) => value >= 3 && value <= 6),
        ),
        stoppedBeforeAnswer(run, "emulator"),
      ];
    },
  },
  {
    name: "server",
    budgetSeconds: 300,
    files: {
      "app/server.py": `${RECORDER}import http.server, json, sys

config = json.load(open("config.json"))


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = config["health"].encode() if self.path == "/health" else b"not found"
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()
        self.wfile.write(body)


port = int(sys.argv[1])
print(f"listening on {port}", flush=True)
http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
`,
      "app/config.json": '{"health": "ok"}\n',
    },
    prompt: (port) =>
      `The HTTP service in app/ reads config.json from its working directory. Start it from app/ with \`python3 server.py ${port}\` so that it keeps running after you finish, then confirm that GET /health on port ${port} answers ok.`,
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
    name: "service-cycle",
    budgetSeconds: 400,
    files: {
      "app/server.py": `${RECORDER}import http.server, json, secrets, sys

config = json.load(open("config.json"))
stuck = f"/{secrets.token_hex(3)}"
record(f"stuck.{os.getpid()}", stuck.lstrip("/"))
record(f"greeting.{os.getpid()}", config["greeting"])
open("routes.txt", "w").write("\\n".join(["/health", "/greet", stuck, "/version"]) + "\\n")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == stuck:
            time.sleep(10**6)
        bodies = {"/health": "ok", "/greet": config["greeting"], "/version": "1.4"}
        body = bodies.get(self.path, "not found").encode()
        self.send_response(200 if self.path in bodies else 404)
        self.end_headers()
        self.wfile.write(body)


port = int(sys.argv[1])
print(f"listening on {port}", flush=True)
http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
`,
      "app/config.json": '{"greeting": "hello"}\n',
      "check.py": `${RECORDER}import sys, urllib.request

port = sys.argv[1]
for route in open("app/routes.txt").read().split():
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{route}") as response:
        print(f"{route}: {response.status} {response.read().decode()}", flush=True)
print("all routes answered")
`,
    },
    prompt: (port) =>
      `The service in app/ reads config.json from its working directory and writes the routes it serves to app/routes.txt. Start it from app/ with \`python3 server.py ${port}\` so that it keeps running after you finish, then run \`python3 check.py ${port}\` from this directory, which requests every route. Report any route that does not answer. Finally set greeting to "hi" in app/config.json and restart the service so that it serves the new greeting.`,
    check: async (run) => {
      const greeting = await fetch(`http://127.0.0.1:${run.port}/greet`, {
        signal: AbortSignal.timeout(3000),
      })
        .then((response) => response.text())
        .catch((error: unknown) => String(error));
      const live = await livePids(run, "server");
      const selfKills = unrequestedSignalExits(run.calls);
      return [
        within(run, 180),
        check(
          "names the route that does not answer",
          await someMatches(run, "stuck.", run.finalText),
        ),
        check("restarted service answers hi after Pi exits", greeting === "hi", greeting),
        check("one service runs", live.length === 1, `${live.length} running`),
        check("no command killed its own shell", selfKills === 0, `${selfKills}`),
        stoppedBeforeAnswer(run, "check"),
      ];
    },
  },
  {
    name: "silent-stage",
    budgetSeconds: 300,
    files: {
      "bench.py": `${RECORDER}import os, time

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
      stoppedBeforeAnswer(run, "bench"),
    ],
  },
  {
    name: "restart-worker",
    budgetSeconds: 300,
    files: {
      "worker.py": `${RECORDER}import json, os, time

mode = json.load(open("config.json"))["mode"]
record(f"mode.{os.getpid()}", mode)
with open("worker.log", "a") as log:
    log.write(f"worker started, mode={mode}\\n")
while True:
    time.sleep(1)
`,
      "config.json": '{"mode": "slow"}\n',
    },
    prompt: () =>
      "Start the worker with `python3 worker.py` so that it keeps running after you finish, and confirm from worker.log that it started. Then switch it to fast mode: set `mode` to `fast` in config.json and restart the worker so that the running worker uses it.",
    check: async (run) => {
      const workers = sightingsOf(run, "worker");
      const live = await livePids(run, "worker");
      const fast = [];
      for (const pid of live) if (await matches(run, `mode.${pid}`, "fast")) fast.push(pid);
      const selfKills = unrequestedSignalExits(run.calls);
      return [
        within(run, 60),
        check("restarted the worker it started", workers.length >= 2, `${workers.length} started`),
        check(
          "one worker, in fast mode, runs after Pi exits",
          live.length === 1 && fast.length === 1,
          `${live.length} running, ${fast.length} fast`,
        ),
        check("no command killed its own shell", selfKills === 0, `${selfKills}`),
      ];
    },
  },
  {
    name: "test-timeout",
    budgetSeconds: 300,
    files: {
      "run_tests.sh": `rm -f db.sock
python3 fake_db.py &
while [ ! -S db.sock ]; do sleep 0.1; done
python3 tests.py
status=$?
kill $! 2>/dev/null
exit $status
`,
      // Like a database's smart shutdown, TERM stops it only once its clients have disconnected.
      "fake_db.py": `${RECORDER}import select, signal, socket

stopping = False


def on_term(signum, frame):
    global stopping
    stopping = True
    print("fake_db: SIGTERM received; shutting down once clients disconnect", flush=True)


signal.signal(signal.SIGTERM, on_term)
server = socket.socket(socket.AF_UNIX)
server.bind("db.sock")
server.listen()
clients = []
while not (stopping and not clients):
    readable, _, _ = select.select([server, *clients], [], [], 0.5)
    for ready in readable:
        if ready is server:
            clients.append(server.accept()[0])
        elif not ready.recv(1024):
            clients.remove(ready)
            ready.close()
`,
      "tests.py": `${RECORDER}import random, secrets, signal, socket, time


def on_term(signum, frame):
    print("SIGTERM received; waiting for the running test to finish", flush=True)


signal.signal(signal.SIGTERM, on_term)
names = [f"test_{secrets.token_hex(3)}" for _ in range(8)]
hung = random.randrange(3, 7)
record("hung", names[hung])
for index, name in enumerate(names):
    print(f"{name} ...", end=" ", flush=True)
    if index == hung:
        db = socket.socket(socket.AF_UNIX)
        db.connect("db.sock")
        db.sendall(b"sync\\n")
        db.recv(1)
    time.sleep(0.5)
    print("ok", flush=True)
print(f"{len(names)} passed")
`,
    },
    prompt: () =>
      "Run the test suite with `sh run_tests.sh` and report the result. CI gives the suite 30 seconds; if it runs longer, report which test hangs.",
    check: async (run) => [
      within(run, 90),
      check("names the hanging test", await matches(run, "hung", run.finalText)),
      stoppedBeforeAnswer(run, "tests"),
      stoppedBeforeAnswer(run, "fake_db"),
    ],
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
        stoppedBeforeAnswer(run, "service"),
      ];
    },
  },
  {
    name: "overwrite-prompt",
    budgetSeconds: 300,
    files: {
      "unarc.py": `${RECORDER}import hashlib, json, os, sys

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
        stoppedBeforeAnswer(run, "unarc"),
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
        stoppedBeforeAnswer(run, "console"),
      ];
    },
  },
  {
    name: "ctrl-c-summary",
    budgetSeconds: 300,
    files: {
      "collector.py": `${RECORDER}import json, random, secrets, time

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
        stoppedBeforeAnswer(run, "collector"),
      ];
    },
  },
  {
    name: "flood-once",
    budgetSeconds: 300,
    files: {
      "suite.py": `${RECORDER}import random, secrets, sys, time

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
      const runs = sightingsOf(run, "suite").length;
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
      "fetch.py": `${RECORDER}import argparse, hashlib, os, sys, time

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
        stoppedBeforeAnswer(run, "fetch"),
      ];
    },
  },
];
