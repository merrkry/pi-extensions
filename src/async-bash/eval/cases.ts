/** One tool call and the result the model saw. */
export interface ToolCall {
  name: string;
  text: string;
  seconds: number;
}

/** A task distilled from a recorded or benchmark failure; README.md names the source. */
export interface Case {
  name: string;
  budgetSeconds: number;
  files: Record<string, string>;
  /** Python run to completion in the working directory before the agent starts. */
  prepare?: string;
  prompt: (port: number) => string;
  observe?: (port: number) => Promise<string>;
}

/** Agents name their shell tools differently. */
export const SHELL_TOOLS = new Set(["bash", "exec_command"]);
export const SESSION_TOOLS = new Set(["process", "write_stdin"]);

/**
 * Valid rows per shard; an epoch computes for 2 s per 100 of them before it prints anything, so
 * silence alone shows no hang. Each shard has a few malformed rows, and shard 4 enough that the
 * loader's warnings fill half again the host's default pipe, here stderr, which train.py reads
 * only after stdout ends: the two wait on each other until something drains the pipe or stops
 * them.
 */
const SHARD_ROWS = [200, 700, 100, 200, 300, 500, 200, 400, 300, 200, 100, 300];
const HUNG_SHARD = 4;

const TRAIN = `import signal, subprocess, sys, time


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

const LOADER = `import signal, sys

signal.signal(signal.SIGTERM, signal.SIG_IGN)

shard = sys.argv[1]
for number, line in enumerate(open(f"data/{shard}.csv"), 1):
    try:
        print(float(line))
    except ValueError:
        print(f"{shard}.csv line {number}: skipping malformed value {line.strip()!r}, expected a number", file=sys.stderr)
`;

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
      "Train the model with `python3 train.py` and report the final loss. Training takes a few minutes. Run it as it is without changing files.",
  },
  {
    name: "server",
    budgetSeconds: 300,
    files: {
      "app/server.py": `import http.server, json, sys

config = json.load(open("config.json"))


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = config["health"].encode() if self.path == "/health" else b"not found"
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()
        self.wfile.write(body)


port = int(sys.argv[1])
server = http.server.HTTPServer(("127.0.0.1", port), Handler)
print(f"listening on {port}", flush=True)
server.serve_forever()
`,
      "app/config.json": '{"health": "ok"}\n',
    },
    prompt: (port) =>
      `The HTTP service in app/ reads config.json from its working directory. Start it from app/ with \`python3 server.py ${port}\` so that it keeps running after you finish, then confirm that GET /health on port ${port} answers ok.`,
    observe: async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        await response.body?.cancel();
        return `GET /health returned HTTP ${response.status} after the turn`;
      } catch (error) {
        return `GET /health failed after the turn. ${String(error)}`;
      }
    },
  },
];
