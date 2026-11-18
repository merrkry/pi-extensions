import { readFile } from "node:fs/promises";
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
  /** The working directory's files as the agent received them, by path relative to it. */
  inputs: ReadonlyMap<string, string>;
  /** Holds `started/`, where fixtures mark their start. */
  stateDirectory: string;
  port: number;
  /** Whether the agent exited successfully on its own within the case's budget. */
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

/** Fixtures mark that they started, for runs too short for the runner to see. */
const START_MARKER = `import os, sys, time

open(os.path.join(os.environ["EVAL_STATE"], "started", f"{os.path.basename(sys.argv[0])[:-3]}.{os.getpid()}"), "w").close()


`;

const sightingsOf = (run: Run, name: string) =>
  run.fixtures.filter((fixture) => fixture.name === name);

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

async function inputsUnchanged(run: Run): Promise<Check> {
  const changed = [];
  for (const [name, content] of run.inputs) {
    if ((await contentOf(run, name)) !== content) changed.push(name);
  }
  return check("changed none of its files", changed.length === 0, changed.join(", "));
}

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
  /\b(?:hang|hangs|hung|stuck|deadlock\w*|never (?:finish|complete|exit)\w*|(?:did not|didn't|does not|doesn't|not) (?:finish|complete|terminate|exit|progress)\w*|no final loss)\b/iu;

/** Final answers use markdown, whose emphasis would split the phrases checks look for. */
const plain = (text: string) => text.replaceAll(/[*_`]/gu, "");

/**
 * Valid rows per shard; an epoch computes for 2 s per 100 of them before it prints anything, so
 * silence alone shows no hang. Each shard has a few malformed rows, and shard 4 enough that the
 * loader's warnings fill half again the host's default pipe, here stderr, which train.py reads
 * only after stdout ends: the two wait on each other until something drains the pipe or stops
 * them.
 */
const SHARD_ROWS = [200, 700, 100, 200, 300, 500, 200, 400, 300, 200, 100, 300];
const HUNG_SHARD = 4;

const TRAIN = `${START_MARKER}import signal, subprocess


def on_term(signum, frame):
    print("SIGTERM received; finishing the current epoch first", flush=True)


def load(shard):
    loader = subprocess.Popen([sys.executable, "loader.py", shard], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    values = [float(value) for value in loader.stdout.read().split()]
    if loader.wait() != 0:
        raise RuntimeError(loader.stderr.read())
    return values


signal.signal(signal.SIGTERM, on_term)
shards = open("data/shards.txt").read().split()
print(f"training on {len(shards)} shards", flush=True)
for epoch, shard in enumerate(shards, 1):
    values = load(shard)
    deadline = time.time() + 2 * len(values) / 100
    while time.time() < deadline:
        sum(index * index for index in range(10_000))
    loss = sum(values) / len(values)
    print(f"epoch {epoch}/{len(shards)} {shard} loss={loss:.3f}", flush=True)
print(f"final loss: {loss:.3f}", flush=True)
`;

const LOADER = `import sys

shard = sys.argv[1]
for number, line in enumerate(open(f"data/{shard}.csv"), 1):
    try:
        print(float(line))
    except ValueError:
        print(f"{shard}.csv line {number}: skipping malformed value {line.strip()!r}, expected a number", file=sys.stderr)
`;

/** The loss train.py prints last: the mean of the last shard's valid values. */
function finalLoss(run: Run): string {
  const last = run.inputs.get("data/shards.txt")?.split(/\s+/u).findLast(Boolean);
  const values = (run.inputs.get(`data/${last}.csv`) ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(Number)
    .filter(Number.isFinite);
  return (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3);
}

export const cases: Case[] = [
  {
    name: "hung-run",
    budgetSeconds: 300,
    files: {
      "train.py": TRAIN,
      "loader.py": LOADER,
    },
    prepare: `import fcntl, os, random
os.makedirs("data")
F_GETPIPE_SZ = 1032
pipe = os.pipe()
malformed = fcntl.fcntl(pipe[1], F_GETPIPE_SZ) * 3 // 2 // 60
names = []
for shard, count in enumerate(${JSON.stringify(SHARD_ROWS)}, 1):
    name = f"shard-{shard:02d}"
    names.append(name)
    values = [f"{random.random() / shard:.4f}" for _ in range(count)]
    values += ["NA"] * (malformed if shard == ${HUNG_SHARD} else 2)
    random.shuffle(values)
    open(f"data/{name}.csv", "w").write("\\n".join(values) + "\\n")
open("data/shards.txt", "w").write("\\n".join(names) + "\\n")
`,
    prompt: () =>
      "Train the model with `python3 train.py` and report the final loss. Training takes a few minutes. Run it as it is; do not change any files.",
    check: async (run) => {
      const loss = finalLoss(run);
      const completed = run.calls.some((call) => call.text.includes(`final loss: ${loss}`));
      return [
        within(run, 150),
        // Loaders of other shards end within milliseconds, so either answer before this is a guess.
        check(
          "ran into the stall",
          sightingsOf(run, "loader").some((loader) => loader.lastSeen - loader.firstSeen >= 3000),
        ),
        completed
          ? check("reports the final loss it saw", run.finalText.includes(loss), loss)
          : check("reports that the run cannot finish", STOPPED_EARLY.test(plain(run.finalText))),
        await inputsUnchanged(run),
        stoppedBeforeAnswer(run, "train"),
      ];
    },
  },
  {
    name: "server",
    budgetSeconds: 300,
    files: {
      "app/server.py": `${START_MARKER}import http.server, json, sys

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
      // The deadline also covers the body, so a server that never finishes answering fails here.
      const health = await fetch(`http://127.0.0.1:${run.port}/health`, {
        signal: AbortSignal.timeout(5000),
      })
        .then(async (response) => `${response.status} ${await response.text()}`)
        .catch((error: unknown) => String(error));
      const slowest = Math.max(0, ...run.calls.map((call) => call.seconds));
      return [
        within(run, 30),
        check("server answers after Pi exits", health === "200 ok", health),
        check(
          "saw /health answer ok",
          run.calls.some(
            (call) => JSON.stringify(call.args).includes("/health") && /\bok\b/u.test(call.text),
          ),
        ),
        check("no call waited 4 s or more", slowest < 4, `${Math.round(slowest)} s`),
        check("used at most 6 tool calls", run.calls.length <= 6, `${run.calls.length}`),
      ];
    },
  },
];
