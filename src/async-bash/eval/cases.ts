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
  /** Holds `started/`, where fixtures mark their start. */
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

const TRAIN = `${START_MARKER}import signal, subprocess


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
];
