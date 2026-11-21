import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, test, vi } from "vite-plus/test";
import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { asyncBash } from "./src/async-bash/index.ts";
import {
  MAX_REPORTED_SESSIONS,
  type ProcessResult,
  type TaskSummary,
} from "./src/async-bash/processes.ts";

const LONG_TEST_TIMEOUT_MS = 10_000;
const BASH_SIGKILL_EXIT_STATUS = 137;

const directory = await mkdtemp(join(tmpdir(), "pi-bash-check-"));
const settingsManager = SettingsManager.inMemory({
  shellCommandPrefix: "export BASH_CHECK_PREFIX=present",
});
const modelRuntime = await ModelRuntime.create({
  authPath: join(directory, "auth.json"),
  modelsPath: null,
  modelsStorePath: join(directory, "models-cache"),
  refreshOnCreate: false,
});
async function createSession(
  extension: Pick<
    ConstructorParameters<typeof DefaultResourceLoader>[0],
    "additionalExtensionPaths" | "extensionFactories"
  >,
) {
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    ...extension,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
  });
  await resourceLoader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(directory),
  });
  assert.deepEqual(extensionsResult.errors, []);
  return session;
}

// Calls wait at least a second in Pi; the tests' commands finish or are observed sooner.
const session = await createSession({ extensionFactories: [(pi) => asyncBash(pi, 0)] });

afterEach(async () => {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
});

afterAll(async () => {
  session.dispose();
  await rm(directory, { recursive: true, force: true });
});

async function execute(name: string, params: Record<string, unknown>, signal?: AbortSignal) {
  const definition = session.getToolDefinition(name);
  assert.ok(definition, `Missing tool ${name}`);
  return definition.execute(
    "bash-check",
    params,
    signal,
    undefined,
    session.extensionRunner.createToolContext("bash-check", signal),
  );
}

const text = (response: Awaited<ReturnType<typeof execute>>) => {
  const block = response.content.find((content) => content.type === "text");
  assert.ok(block?.type === "text");
  return block.text;
};

async function bash(command: string, yieldTime = 0) {
  const response = await execute("bash", { command, yield_time_ms: yieldTime });
  return response.structuredContent as Partial<ProcessResult> & Omit<ProcessResult, "session_id">;
}

/** Starts a command that is still running, so it keeps a session. */
async function start(command: string, yieldTime = 0): Promise<ProcessResult> {
  const started = await bash(command, yieldTime);
  assert.equal(started.state, "running", JSON.stringify(started));
  return started as ProcessResult;
}

async function processAction(params: Record<string, unknown>, signal?: AbortSignal) {
  const response = await execute("process", params, signal);
  return response.structuredContent as ProcessResult;
}

const poll = (task: ProcessResult, params: Record<string, unknown> = {}, signal?: AbortSignal) =>
  processAction({ action: "poll", session_id: task.session_id, ...params }, signal);

async function startWithOutput(command: string, output: string): Promise<ProcessResult> {
  let task = await start(command);
  await vi.waitFor(
    async () => {
      task = await poll(task, { yield_time_ms: 0, cursor_bytes: 0 });
      assert.equal(task.state, "running", JSON.stringify(task));
      assert.equal(task.output, output);
    },
    { timeout: 3000 },
  );
  return task;
}

async function processSessions() {
  const response = await execute("process", { action: "list" });
  return (response.structuredContent as { sessions: TaskSummary[] }).sessions;
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const javascript = (source: string) => `${quote(process.execPath)} -e ${quote(source)}`;

async function reminder() {
  const messages = await session.extensionRunner.emitContext([]);
  if (messages.length === 0) return undefined;
  assert.equal(messages.length, 1);
  assert.ok(messages[0]?.role === "custom" && typeof messages[0].content === "string");
  return messages[0].content;
}

describe(`bash tools under ${process.versions["bun"] ? "Bun" : "Node"}`, () => {
  test("returns complete fast output without keeping a session", async () => {
    const fast = await execute("bash", { command: "printf stdout; printf stderr >&2; exit 7" });
    assert.equal(fast.isError, true);
    const result = fast.structuredContent as ProcessResult & { wall_time_seconds: number };
    assert.match(result.output, /stdout/u);
    assert.match(result.output, /stderr/u);
    assert.equal(result.exit_code, 7);
    assert.equal(result.session_id, undefined);
    assert.match(text(fast), /Command exited with code 7/u);
    assert.ok(result.wall_time_seconds >= 0);
    const listed = await execute("process", { action: "list" });
    assert.deepEqual(listed.structuredContent, { sessions: [] });

    for (let index = 0; index < 20; index++) {
      const quick = await bash(`printf fast-${index}`, 1000);
      assert.equal(quick.output, `fast-${index}`);
      assert.equal(quick.exit_code, 0);
    }
  });

  test("the built extension waits out a quick command when asked to return at once", async () => {
    const built = await createSession({
      additionalExtensionPaths: [fileURLToPath(new URL("./dist/index.js", import.meta.url))],
    });
    try {
      const response = await built
        .getToolDefinition("bash")!
        .execute(
          "built-bash",
          { command: "sleep 0.3; printf quick", yield_time_ms: 0 },
          undefined,
          undefined,
          built.extensionRunner.createToolContext("built-bash", undefined),
        );
      assert.equal(text(response), "quick");
    } finally {
      await built.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      built.dispose();
    }
  });

  test(
    "yields after five seconds by default",
    async () => {
      const response = await execute("bash", { command: "sleep 5.2; printf default-yield" });
      const background = response.structuredContent as ProcessResult;
      assert.equal(background.state, "running");
      assert.match(
        text(response),
        new RegExp(`\\[Session ${background.session_id} running for 5 s`, "u"),
      );
      assert.equal(background.runtime_seconds, 5);
      assert.equal(background.idle_seconds, 5);
      const finished = await poll(background);
      assert.equal(finished.output, "default-yield");
      assert.equal(finished.idle_seconds, undefined);
    },
    LONG_TEST_TIMEOUT_MS,
  );

  test("uses Pi shell settings, session environment, and working directory", async () => {
    const command = 'printf \'%s:%s\' "$BASH_CHECK_PREFIX" "$PI_SESSION_ID"';
    const env = await bash(command, 1000);
    assert.equal(env.output, `present:${session.sessionId}`, JSON.stringify(env));
    assert.equal(env.command, command);
    const cwd = await bash(javascript("process.stdout.write(process.cwd())"), 1000);
    assert.equal(cwd.output, directory);
    const path = await bash('printf %s "$PATH"', 1000);
    assert.equal(path.output.split(delimiter)[0], join(getAgentDir(), "bin"));
  });

  test("continues after shown output by default and rereads from any cursor", async () => {
    const task = await startWithOutput("printf first; IFS= read -r line; printf second", "first");
    const finished = await processAction({
      action: "write",
      session_id: task.session_id,
      chars: "go\n",
    });
    assert.equal(finished.state, "exited");
    assert.equal(finished.output, "second");

    const after = await execute("process", { action: "poll", session_id: task.session_id });
    assert.equal((after.structuredContent as ProcessResult).output, "");
    assert.match(text(after), /^\(no output after byte 11\)/u);

    for (let read = 0; read < 2; read++) {
      assert.equal((await poll(task, { cursor_bytes: 0 })).output, "firstsecond");
    }
    assert.equal((await poll(task, { cursor_bytes: 5 })).output, "second");
  });

  test("writes stdin, waits for completion, and preserves results after stdin closes", async () => {
    const task = await start(
      "printf 'ready\n'; IFS= read -r line; printf 'received:%s\n' \"$line\"; cat",
      100,
    );
    assert.equal(task.output, "ready\n");
    const immediate = await processAction({
      action: "write",
      session_id: task.session_id,
      chars: "hello\n",
      yield_time_ms: 0,
    });
    assert.equal(immediate.state, "running");
    const finished = await processAction({
      action: "write",
      session_id: task.session_id,
      chars: "remaining\n",
      eof: true,
      cursor_bytes: task.cursor_bytes,
    });
    assert.equal(finished.exit_code, 0);
    assert.equal(finished.output, "received:hello\nremaining\n");
    const rejected = await execute("process", {
      action: "write",
      session_id: task.session_id,
      chars: "again",
      cursor_bytes: 0,
    });
    assert.equal(rejected.isError, true);
    const late = rejected.structuredContent as ProcessResult;
    assert.equal(late.input_refused, "stdin is closed");
    assert.match(text(rejected), /Input not written: stdin is closed/u);
    assert.equal(late.exit_code, 0);
    assert.equal(late.output, "ready\nreceived:hello\nremaining\n");
  });

  // Bun reports writes to a pipe with no reader as successful: oven-sh/bun#45882.
  test.skipIf(process.versions["bun"])(
    "reports input the pipe rejects after accepting it",
    async () => {
      const task = await start("exec 0<&-; printf ready; sleep 2", 300);
      assert.equal(task.output, "ready");
      const response = await execute("process", {
        action: "write",
        session_id: task.session_id,
        chars: "lost input",
        cursor_bytes: task.cursor_bytes,
      });
      const result = response.structuredContent as ProcessResult;
      assert.equal(response.isError, true);
      assert.match(result.input_error ?? "", /EPIPE/u);
      assert.match(text(response), /may have read part of it: write EPIPE/u);
      assert.equal(result.state, "running");
      assert.equal(result.stdin, "closed");
      await processAction({ action: "kill", session_id: task.session_id });
    },
  );

  test.skipIf(process.versions["bun"])(
    "delivers input loss in the final result, not in streaming updates",
    async () => {
      const task = await start("sleep 0.3; exec 0<&-; printf a; sleep 0.3; printf b; sleep 0.3");
      await processAction({
        action: "write",
        session_id: task.session_id,
        chars: "x".repeat(1024 * 1024),
        yield_time_ms: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 450));
      const updates: unknown[] = [];
      const finished = await session
        .getToolDefinition("process")!
        .execute(
          "streamed-poll",
          { action: "poll", session_id: task.session_id },
          undefined,
          (update) => updates.push(update),
          session.extensionRunner.createToolContext("streamed-poll", undefined),
        );
      assert.ok(updates.length > 0);
      const result = finished.structuredContent as ProcessResult;
      assert.equal(result.state, "exited");
      assert.match(result.input_error ?? "", /EPIPE/u);
    },
  );

  test.skipIf(process.versions["bun"])(
    "lists input lost after a write and keeps the session in the reminder until then",
    async () => {
      const task = await start("sleep 0.2; exec 0<&-; sleep 0.2");
      await processAction({
        action: "write",
        session_id: task.session_id,
        chars: "x".repeat(1024 * 1024),
        yield_time_ms: 0,
      });
      await vi.waitFor(async () => assert.match((await reminder()) ?? "", /finished since/u), {
        timeout: 3000,
      });
      const listed = await execute("process", { action: "list" });
      assert.match(text(listed), /may have read part of it: write EPIPE/u);
      assert.doesNotMatch((await reminder()) ?? "", new RegExp(task.session_id, "u"));
      assert.equal((await poll(task)).input_error, undefined);
    },
  );

  test.skipIf(process.versions["bun"])(
    "reports input lost after its write call returned, once",
    async () => {
      const task = await start("sleep 0.3; exec 0<&-; sleep 2");
      const write = await processAction({
        action: "write",
        session_id: task.session_id,
        chars: "x".repeat(1024 * 1024),
        yield_time_ms: 0,
      });
      assert.equal(write.input_error, undefined);
      await vi.waitFor(
        async () =>
          assert.match((await poll(task, { yield_time_ms: 0 })).input_error ?? "", /EPIPE/u),
        { timeout: 3000 },
      );
      assert.equal((await poll(task, { yield_time_ms: 0 })).input_error, undefined);
      await processAction({ action: "kill", session_id: task.session_id });
    },
  );

  test("refuses input that would leave more than a megabyte unread", async () => {
    const task = await start("sleep 5");
    const write = (chars: string) =>
      processAction({ action: "write", session_id: task.session_id, chars, yield_time_ms: 0 });
    assert.match((await write("x".repeat(2 * 1024 * 1024))).input_refused ?? "", /has not read/u);
    assert.equal((await write("x".repeat(1024 * 1024))).input_refused, undefined);
    assert.match((await write("more")).input_refused ?? "", /has not read/u);
    // A stop that leaves input unread is still the stop that was asked for.
    const killed = await execute("process", { action: "kill", session_id: task.session_id });
    assert.equal(killed.isError, undefined);
  });

  test("preserves commands and output when polling is cancelled", async () => {
    const cancellable = await start(
      // Output arrives during the poll, while the command keeps running.
      "IFS= read -r line; sleep 0.2; printf preserved; sleep 0.2; printf survived",
    );
    await processAction({
      action: "write",
      session_id: cancellable.session_id,
      chars: "go\n",
      yield_time_ms: 0,
    });
    const controller = new AbortController();
    const processTool = session.getToolDefinition("process")!;
    const pending = processTool.execute(
      "cancelled-poll",
      { action: "poll", session_id: cancellable.session_id, yield_time_ms: 60_000 },
      controller.signal,
      () => controller.abort(),
      session.extensionRunner.createToolContext("cancelled-poll", controller.signal),
    );
    await assert.rejects(pending);
    const survived = await poll(cancellable);
    assert.equal(survived.output, "preservedsurvived");
    assert.equal(survived.exit_code, 0);
  });

  test("withholds a character until all of its bytes are written", async () => {
    const unicode = await start(
      javascript(
        "const b=Buffer.from('😀'); process.stdout.write(b.subarray(0,2)); setTimeout(()=>process.stdout.write(b.subarray(2)),100)",
      ),
      50,
    );
    assert.equal(unicode.output, "");
    assert.equal((await poll(unicode)).output, "😀");
    for (const action of ["poll", "read"]) {
      const inside = await processAction({
        action,
        session_id: unicode.session_id,
        cursor_bytes: 3,
      });
      assert.equal(inside.output, "😀");
      assert.equal(inside.output_start_bytes, 0);
      await assert.rejects(
        processAction({ action, session_id: unicode.session_id, cursor_bytes: 5 }),
        /between 0 and 4/u,
      );
    }
  });

  test("keeps byte order marks wherever they appear in either channel", async () => {
    const result = await bash(
      "printf prefix; sleep 0.1; printf '\\357\\273\\277suffix' >&2; sleep 0.1; printf '\\357\\273\\277end'",
      1000,
    );
    assert.equal(result.output, "prefix\uFEFFsuffix\uFEFFend");
  });

  test("preserves Pi's raw command output across escape sequences split between polls", async () => {
    const first = "\u009b31mred\u009b0m \u001b]8;;https://ex";
    const last = "ample.com\u001b\\link\u001b]8;;\u001b\\";
    const raw = first + last;
    const native = await createBashToolDefinition(directory).execute(
      "native-bash",
      { command: javascript(`process.stdout.write(${JSON.stringify(raw)})`) },
      undefined,
      undefined,
      session.extensionRunner.createToolContext("native-bash", undefined),
    );
    assert.equal((native.structuredContent as { output: string }).output, raw);
    const started = await startWithOutput(
      javascript(
        `process.stdout.write(${JSON.stringify(first)}); process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(last)}); process.stdin.destroy()})`,
      ),
      first,
    );
    await processAction({ action: "write", session_id: started.session_id, chars: "go\n" });
    assert.equal((await poll(started, { cursor_bytes: started.cursor_bytes })).output, last);
    assert.equal((await poll(started, { cursor_bytes: 0 })).output, raw);
  });

  test("returns the tail of large output and pages the full log through read", async () => {
    const largeText = "😀".repeat(250_000);
    const response = await execute("bash", {
      command: javascript("process.stdout.write('😀'.repeat(250000))"),
      yield_time_ms: 5000,
    });
    const large = response.structuredContent as ProcessResult;
    assert.equal(large.exit_code, 0);
    assert.equal(large.total_bytes, Buffer.byteLength(largeText));
    assert.equal(large.cursor_bytes, large.total_bytes);
    assert.ok(large.output_start_bytes > 0);
    assert.ok(Buffer.byteLength(large.output) <= 50 * 1024);
    assert.ok(largeText.endsWith(large.output));
    assert.match(text(response), /Bytes 0-\d+ omitted; page them with process read/u);
    assert.equal(await readFile(large.full_output_path, "utf8"), largeText);

    let cursor = 0;
    let paged = "";
    while (cursor < large.total_bytes) {
      const page = await processAction({
        action: "read",
        session_id: large.session_id,
        cursor_bytes: cursor,
      });
      assert.equal(page.output_start_bytes, cursor);
      assert.ok(page.cursor_bytes > cursor);
      paged += page.output;
      cursor = page.cursor_bytes;
    }
    assert.equal(paged, largeText);
  });

  test("limits output pages by line count", async () => {
    const lines = await bash(javascript("for (let i = 0; i < 2500; i++) console.log(i)"), 5000);
    assert.equal(lines.output.split("\n").length - 1, 2000);
    assert.ok(lines.output.startsWith("500\n"));
    const page = await processAction({ action: "read", session_id: lines.session_id });
    assert.equal(page.output.split("\n").length - 1, 2000);
    assert.ok(page.output.endsWith("1999\n"));
  });

  test("removes the log of a command that fails to spawn", async () => {
    const task = await start("sleep 5");
    const logs = dirname(task.full_output_path);
    const before = await readdir(logs);
    await assert.rejects(bash("printf a\0b"));
    assert.deepEqual(await readdir(logs), before);
    await processAction({ action: "kill", session_id: task.session_id });
  });

  test("returns when the shell exits and leaves background work running", async () => {
    const marker = join(directory, "background-work");
    // The background work keeps the command's output open and writes to it before it finishes.
    const result = await bash(
      `(sleep 0.5; printf late && printf finished > ${quote(marker)}) & printf started`,
      5000,
    );
    assert.equal(result.state, "exited");
    assert.equal(result.output, "started");
    await assert.rejects(stat(marker), /ENOENT/u);
    await vi.waitFor(async () => assert.equal(await readFile(marker, "utf8"), "finished"), {
      timeout: 3000,
    });
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps earlier output when a command opens its output by path",
    async () => {
      const result = await bash("printf kept; echo reopened > /dev/stdout; printf end", 5000);
      assert.ok(result.output.startsWith("kept"), result.output);
      assert.ok(result.output.endsWith("end"), result.output);
    },
  );

  test("returns every byte of output that is not UTF-8, within the page limit", async () => {
    for (const bytes of ["\\303", "\\377"]) {
      const truncated = await bash(`printf 'ok${bytes}'`, 5000);
      assert.equal(truncated.output, "ok\uFFFD");
      assert.equal(truncated.total_bytes, 3);
    }

    // A stray continuation byte does not belong to the character before it.
    const stray = await startWithOutput("printf x; IFS= read -r line; printf '\\200'", "x");
    const rest = await processAction({ action: "write", session_id: stray.session_id, eof: true });
    assert.equal(rest.output, "\uFFFD");
    assert.equal(rest.output_start_bytes, 1);

    const size = 120 * 1024;
    const binary = await bash(
      javascript(`process.stdout.write(Buffer.alloc(${size}, 0x80))`),
      5000,
    );
    assert.equal(binary.total_bytes, size);
    assert.ok(Buffer.byteLength(binary.output) <= 50 * 1024);
    let cursor = 0;
    while (cursor < size) {
      const page = await processAction({
        action: "read",
        session_id: binary.session_id,
        cursor_bytes: cursor,
      });
      assert.ok(page.cursor_bytes > cursor);
      assert.ok(Buffer.byteLength(page.output) <= 50 * 1024);
      cursor = page.cursor_bytes;
    }
  });

  test("stops a command at its time limit and reports a requested stop as no failure", async () => {
    const limited = await execute("bash", {
      command: "printf limited; sleep 30",
      yield_time_ms: 5000,
      timeout_ms: 300,
    });
    assert.equal(limited.isError, true);
    assert.match(text(limited), /Command stopped by timeout_ms after 0 s/u);
    assert.equal((limited.structuredContent as ProcessResult).signal, "SIGTERM");

    // The limit holds after the call has returned.
    const background = await execute("bash", {
      command: "sleep 30",
      yield_time_ms: 0,
      timeout_ms: 300,
    });
    const expired = await execute("process", {
      action: "poll",
      session_id: (background.structuredContent as ProcessResult).session_id,
    });
    assert.equal(expired.isError, true);
    assert.match(text(expired), /stopped by timeout_ms, exited with code 143 \(SIGTERM\)/u);

    const task = await start("sleep 30");
    const killed = await execute("process", { action: "kill", session_id: task.session_id });
    assert.equal(killed.isError, undefined);
    assert.match(text(killed), /stopped by process kill, exited with code 143 \(SIGTERM\)/u);
  });

  test.skipIf(process.platform === "win32")(
    "allows descendants to finish TERM cleanup after their shell exits",
    async () => {
      const marker = join(directory, "graceful-descendant");
      const child = javascript(
        `const fs=require('node:fs'); process.on('SIGTERM',()=>setTimeout(()=>process.stdout.write('clean',()=>{fs.writeFileSync(${JSON.stringify(marker)},'clean');process.exit(0)}),500)); process.stdout.write('ready'); setInterval(()=>{},1000)`,
      );
      const running = await startWithOutput(`${child} & wait`, "ready");
      const killed = await processAction({
        action: "kill",
        session_id: running.session_id,
        cursor_bytes: running.cursor_bytes,
      });
      assert.equal(killed.output, "clean");
      assert.equal(await readFile(marker, "utf8"), "clean");
    },
    LONG_TEST_TIMEOUT_MS,
  );

  test.skipIf(process.platform === "win32")(
    "finishes kill escalation when its caller is cancelled",
    async () => {
      const marker = join(directory, "cancelled-kill-term");
      const running = await startWithOutput(
        `exec ${javascript(`const fs=require('node:fs'); process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(marker)},'term')); process.stdout.write('ready'); setInterval(()=>{},1000)`)}`,
        "ready",
      );
      const controller = new AbortController();
      const killing = execute(
        "process",
        { action: "kill", session_id: running.session_id },
        controller.signal,
      );
      const cancelled = assert.rejects(killing);
      try {
        await vi.waitFor(async () => assert.equal(await readFile(marker, "utf8"), "term"));
        controller.abort();
        await cancelled;
        await vi.waitFor(
          async () => assert.equal((await poll(running, { yield_time_ms: 0 })).state, "exited"),
          { timeout: 6000 },
        );
      } finally {
        controller.abort();
        try {
          process.kill(-running.pid!, "SIGKILL");
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
        }
        await cancelled;
      }
    },
    LONG_TEST_TIMEOUT_MS,
  );

  test(
    "allows five seconds for TERM before forcibly terminating the process tree",
    async () => {
      const stubborn = await start("trap '' TERM; sleep 30 & printf '%s' \"$!\"; wait", 100);
      try {
        const childPid = Number(stubborn.output);
        assert.ok(childPid > 0);
        const killStarted = performance.now();
        const killed = await processAction({ action: "kill", session_id: stubborn.session_id });
        assert.equal(killed.state, "exited");
        if (process.platform !== "win32") {
          assert.ok(performance.now() - killStarted >= 5_000);
          assert.equal(killed.signal, "SIGKILL");
          assert.equal(killed.exit_code, BASH_SIGKILL_EXIT_STATUS);
        }
        if (process.platform === "linux") {
          // Shell exit and pipe EOF can precede a descendant's final kernel exit state.
          await vi.waitFor(async () => {
            const status = await readFile(`/proc/${childPid}/stat`, "utf8").catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT" || error.code === "ESRCH") return "";
                throw error;
              },
            );
            const state = status.split(") ")[1]?.split(" ")[0];
            assert.ok(
              status === "" || state === "Z" || state === "X",
              `Child ${childPid} is still running: ${status.trim()}`,
            );
          });
        }
      } finally {
        if (process.platform !== "win32") {
          try {
            process.kill(-stubborn.pid!, "SIGKILL");
          } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
          }
        }
      }
    },
    LONG_TEST_TIMEOUT_MS,
  );

  test("rejects empty commands and parameters of other actions", async () => {
    await assert.rejects(execute("bash", { command: " " }), /command must not be empty/u);
    const task = await start("cat");
    await assert.rejects(
      processAction({ action: "read", session_id: task.session_id, yield_time_ms: 0 }),
      /yield_time_ms is not supported for action read/u,
    );
    await assert.rejects(
      processAction({ action: "poll", session_id: task.session_id, chars: "x" }),
      /chars is not supported for action poll/u,
    );
  });

  test("keeps a command running when its initial bash call is cancelled", async () => {
    const aborted = new AbortController();
    const initial = execute(
      "bash",
      { command: "IFS= read -r line; printf done", yield_time_ms: 60_000 },
      aborted.signal,
    );
    setTimeout(() => aborted.abort(), 50);
    await assert.rejects(initial);
    // The session's ID never reached the model, so the reminder names it.
    const id = (await reminder())?.match(/^Bash sessions running: ([^,;.]+)\.$/u)?.[1];
    assert.ok(id);
    const finished = await processAction({ action: "write", session_id: id, eof: true });
    assert.equal(finished.output, "done");
  });

  test(
    "reminds about running and unreported sessions without changing stored history",
    async () => {
      const stored = structuredClone(session.sessionManager.getEntries());
      assert.equal(await reminder(), undefined);
      await bash("printf done", 1000);
      assert.equal(await reminder(), undefined);

      const concurrent = await Promise.all(
        Array.from({ length: MAX_REPORTED_SESSIONS + 2 }, () =>
          start("IFS= read -r line; printf completed"),
        ),
      );
      const ids = concurrent.map((task) => task.session_id);
      // Concurrent starts register in completion order.
      const running = (await reminder())?.match(/^Bash sessions running: (.*)\.$/u)?.[1];
      assert.deepEqual(running?.split(", ").sort(), ids.toSorted());

      const [unreported, ...rest] = concurrent;
      await processAction({
        action: "write",
        session_id: unreported!.session_id,
        eof: true,
        yield_time_ms: 0,
      });
      await Promise.all(
        rest.map(async (task) => {
          const completed = await processAction({
            action: "write",
            session_id: task.session_id,
            eof: true,
          });
          assert.equal(completed.exit_code, 0);
          assert.equal(completed.output, "completed");
        }),
      );
      await vi.waitFor(async () =>
        assert.equal(
          await reminder(),
          `Bash sessions finished since last checked: ${unreported!.session_id}.`,
        ),
      );
      // A rejected observation does not count as reporting the finish.
      await assert.rejects(
        processAction({ action: "read", session_id: unreported!.session_id, cursor_bytes: 99 }),
        /between 0 and 9/u,
      );
      assert.equal(
        await reminder(),
        `Bash sessions finished since last checked: ${unreported!.session_id}.`,
      );
      assert.equal((await poll(unreported!, { cursor_bytes: 0 })).output, "completed");
      assert.equal(await reminder(), undefined);
      assert.deepEqual(session.sessionManager.getEntries(), stored);

      const finished = (await processSessions()).filter(
        (task) => task.state === "exited" || task.state === "failed",
      );
      // Concurrent starts each prune; they must not claim the same sessions.
      assert.ok(finished.length >= MAX_REPORTED_SESSIONS + 2);
      // A list read while the starts prune leaves out the sessions they remove.
      const [next] = await Promise.all([
        Promise.all([start("IFS= read -r line"), start("IFS= read -r line")]),
        processSessions(),
      ]);
      const kept = (await processSessions()).map((task) => task.session_id);
      const pruned = finished.filter((task) => !kept.includes(task.session_id));
      assert.equal(pruned.length, finished.length - MAX_REPORTED_SESSIONS);
      // Pruning removes the sessions seen longest ago.
      assert.ok(kept.includes(unreported!.session_id));
      await assert.rejects(stat(pruned[0]!.full_output_path), /ENOENT/u);
      await assert.rejects(poll(pruned[0] as ProcessResult), /was removed/u);
      for (const task of next) await processAction({ action: "kill", session_id: task.session_id });
    },
    LONG_TEST_TIMEOUT_MS,
  );

  test(
    "keeps a session started early but seen last when pruning",
    async () => {
      const early = await start("IFS= read -r line");
      const later = await Promise.all(
        Array.from({ length: MAX_REPORTED_SESSIONS }, () => start("IFS= read -r line")),
      );
      const finish = (task: ProcessResult) =>
        processAction({ action: "write", session_id: task.session_id, eof: true });
      await Promise.all(later.map(finish));
      assert.equal((await finish(early)).state, "exited");
      const pruning = await start("IFS= read -r line");
      assert.equal(
        (await processAction({ action: "read", session_id: early.session_id })).state,
        "exited",
      );
      await processAction({ action: "kill", session_id: pruning.session_id });
    },
    LONG_TEST_TIMEOUT_MS,
  );

  test.skipIf(process.platform === "win32")(
    "leaves no command running that starts while the session shuts down",
    async () => {
      // A command slow to stop keeps the shutdown going, and seen sessions give the start logs to
      // prune first.
      await startWithOutput(
        `exec ${javascript("process.on('SIGTERM',()=>setTimeout(()=>process.exit(),500)); process.stdout.write('ready'); setInterval(()=>{},1000)")}`,
        "ready",
      );
      await Promise.all(
        Array.from({ length: MAX_REPORTED_SESSIONS + 1 }, () => bash("printf '%060000d' 0", 5000)),
      );
      const late = bash("exec sleep 30").then(
        (result) => result,
        (error: Error) => error,
      );
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      const started = await late;
      if (started instanceof Error) {
        assert.match(started.message, /shutting down/u);
      } else {
        assert.throws(() => process.kill(started.pid!, 0), /ESRCH/u);
      }
    },
    LONG_TEST_TIMEOUT_MS,
  );

  test("cleans up session processes and logs after shutdown", async () => {
    const owned = await start("sleep 30");
    assert.ok(owned.pid);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.throws(() => process.kill(owned.pid!, 0), /ESRCH/u);
    await assert.rejects(stat(owned.full_output_path), /ENOENT/u);
    const replacement = await start("sleep 30");
    assert.notEqual(replacement.session_id, owned.session_id);
    await assert.rejects(poll(owned), /Unknown session/u);
  });
});
