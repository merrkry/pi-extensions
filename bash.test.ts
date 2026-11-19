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
const resourceLoader = new DefaultResourceLoader({
  cwd: directory,
  agentDir: directory,
  settingsManager,
  additionalExtensionPaths: [fileURLToPath(new URL("./dist/index.js", import.meta.url))],
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
      task = await poll(task, { yield_time_ms: 0 });
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

const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const sessionIds = (text: string | undefined): string[] => text?.match(SESSION_ID) ?? [];

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

  test(
    "yields after five seconds by default",
    async () => {
      const response = await execute("bash", { command: "sleep 5.2; printf default-yield" });
      const background = response.structuredContent as ProcessResult;
      assert.equal(background.state, "running");
      assert.match(
        text(response),
        new RegExp(`\\[Session ${background.session_id} running for 5 s;`, "u"),
      );
      assert.equal((await poll(background)).output, "default-yield");
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

  test("continues after shown output by default and repeats reads from a cursor", async () => {
    const task = await start("printf first; IFS= read -r line; printf second");
    const written = await processAction({
      action: "write",
      session_id: task.session_id,
      chars: "go\n",
    });
    assert.equal(written.state, "exited");
    assert.equal(written.output, "firstsecond");

    const after = await execute("process", { action: "poll", session_id: task.session_id });
    assert.equal((after.structuredContent as ProcessResult).output, "");
    assert.match(text(after), /^\(no output after byte 11\)/u);
    assert.equal((await poll(task, { cursor_bytes: 0 })).output, "firstsecond");
    assert.equal((await poll(task, { cursor_bytes: 5 })).output, "second");
    const read = await processAction({ action: "read", session_id: task.session_id });
    assert.equal(read.output, "firstsecond");
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
    });
    assert.equal(rejected.isError, true);
    const late = rejected.structuredContent as ProcessResult;
    assert.equal(late.input_refused, "stdin is closed");
    assert.match(text(rejected), /Input not written: stdin is closed/u);
    assert.equal(late.exit_code, 0);
    assert.equal(late.output, "");
    assert.equal(late.cursor_bytes, Buffer.byteLength("ready\nreceived:hello\nremaining\n"));
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
    await processAction({ action: "kill", session_id: task.session_id });
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

  test("decodes UTF-8 characters split between writes and reads whole characters", async () => {
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

  test.skipIf(process.platform !== "linux")(
    "finishes when only unreaped zombies remain in the process group",
    async () => {
      // The zombie's parent leaves the group and never reaps it.
      const started = performance.now();
      const result = await bash(
        "sh -c 'sleep 0.1 & exec setsid sleep 2' >/dev/null 2>&1 & printf started",
        1500,
      );
      assert.equal(result.state, "exited");
      assert.ok(performance.now() - started < 1500);
    },
  );

  test("waits for a process group whose members keep replacing themselves", async () => {
    // Each process starts its successor in the same group, then exits.
    const source =
      "const n=Number(process.env.HOPS); if (n>0) require('node:child_process').spawn(process.execPath,['-e',process.env.SRC],{stdio:'inherit',env:{...process.env,HOPS:String(n-1)}}).unref(); else process.stdout.write('DONE')";
    const started = await bash(
      `export SRC=${quote(source)}; HOPS=40 ${quote(process.execPath)} -e "$SRC"`,
      15_000,
    );
    // The chain may outlast the wait that follows the shell's exit.
    const result = started.session_id
      ? await poll(started as ProcessResult, { yield_time_ms: 15_000 })
      : started;
    assert.equal(result.state, "exited");
    assert.equal(result.output, "DONE");
  }, 20_000);

  test("removes the log of a command that fails to spawn", async () => {
    const task = await start("sleep 5");
    const logs = dirname(task.full_output_path);
    const before = await readdir(logs);
    await assert.rejects(bash("printf a\0b"));
    assert.deepEqual(await readdir(logs), before);
    await processAction({ action: "kill", session_id: task.session_id });
  });

  test("keeps sessions draining while background processes run", async () => {
    const piped = await bash("(sleep 0.4; printf child-result) & printf started", 200);
    assert.equal(piped.state, "draining");
    assert.equal(piped.exit_code, 0);
    assert.equal(piped.output, "started");
    const finished = await poll(piped as ProcessResult);
    assert.equal(finished.state, "exited");
    assert.equal(finished.output, "child-result");

    const brief = await bash("(sleep 0.4; printf child-result) & printf started", 5000);
    assert.equal(brief.state, "exited");
    assert.equal(brief.output, "startedchild-result");
  });

  test.skipIf(process.platform !== "linux")(
    "ends a long wait on a quiet command and shows a program that replaced the shell reading stdin",
    async () => {
      const started = performance.now();
      const silent = await execute("bash", { command: "exec cat", yield_time_ms: 80_000 });
      assert.ok(performance.now() - started < 40_000);
      assert.match(
        text(silent),
        /no output for 3\d s, no CPU or read\/write I\/O for 3\d s, which ended this wait early, processes: pid \d+ cat \(waiting for input on the session's stdin, which process write sends and eof closes\)/u,
      );
      // Output between waits starts a new quiet stretch, which ends the next long wait early too.
      const task = silent.structuredContent as ProcessResult;
      await processAction({ action: "write", session_id: task.session_id, chars: "x\n" });
      const restarted = performance.now();
      const quietAgain = await poll(task, { yield_time_ms: 80_000 });
      assert.ok(performance.now() - restarted < 40_000);
      assert.ok(quietAgain.quiet_seconds !== undefined);
      const closed = await processAction({
        action: "write",
        session_id: task.session_id,
        eof: true,
      });
      assert.equal(closed.state, "exited");
    },
    // Each wait ends early after 30 s without output or activity.
    80_000,
  );

  test.skipIf(process.platform !== "linux")(
    "lists the command's own shell while it reads the session's stdin",
    async () => {
      // A read with a time limit waits in select rather than read.
      for (const read of ["read -r line", "read -r -t 30 line"]) {
        const reading = await start(`${read}; printf 'got %s' "$line"`);
        await vi.waitFor(
          async () => {
            const result = await poll(reading, { yield_time_ms: 0 });
            assert.match(
              result.processes?.map((member) => `${member.command}: ${member.state}`).join() ?? "",
              /\(the command's shell\): waiting for input on the session's stdin/u,
            );
          },
          { timeout: 3000 },
        );
        const answered = await processAction({
          action: "write",
          session_id: reading.session_id,
          chars: "yes\n",
          yield_time_ms: 2000,
        });
        assert.equal(answered.output, "got yes");
      }

      // A thread other than the main one may be the reader.
      const threaded = await start(
        "exec python3 -c 'import threading; t = threading.Thread(target=input); t.start(); t.join()'",
      );
      await vi.waitFor(
        async () => {
          const result = await poll(threaded, { yield_time_ms: 0 });
          assert.match(
            result.processes?.[0]?.state ?? "",
            /^waiting for input on the session's stdin/u,
          );
        },
        { timeout: 3000 },
      );
      const fed = await processAction({
        action: "write",
        session_id: threaded.session_id,
        chars: "hello\n",
        yield_time_ms: 2000,
      });
      assert.equal(fed.state, "exited");

      // The listing limit does not hide the process that waits for input.
      const crowded = await start("sleep 30 & sleep 30 & sleep 30 & sleep 30 & cat; wait");
      await vi.waitFor(
        async () => {
          const result = await poll(crowded, { yield_time_ms: 0 });
          assert.match(
            result.processes?.[0]?.state ?? "",
            /^waiting for input on the session's stdin/u,
          );
        },
        { timeout: 3000 },
      );
      await processAction({ action: "kill", session_id: crowded.session_id });

      // Output from elsewhere in the command does not hide that it waits for input.
      const prompted = await start(
        "(while :; do echo beat; sleep 0.2; done) & read -r answer; kill $!; printf 'got %s' \"$answer\"",
      );
      await vi.waitFor(
        async () => {
          const response = await execute("process", {
            action: "poll",
            session_id: prompted.session_id,
            yield_time_ms: 0,
          });
          assert.match(text(response), /processes: .*waiting for input on the session's stdin/u);
        },
        { timeout: 3000 },
      );
      await processAction({ action: "kill", session_id: prompted.session_id });

      // Input the command redirected from elsewhere is not the session's to send.
      const fifo = join(directory, "redirected-input");
      const redirected = await start(
        `mkfifo '${fifo}'; exec 3<>'${fifo}'; read -r line <'${fifo}'`,
      );
      await vi.waitFor(
        async () => {
          const result = await poll(redirected, { yield_time_ms: 0 });
          assert.match(
            result.processes?.map((member) => member.state).join() ?? "",
            /^waiting for input on its stdin$/u,
          );
        },
        { timeout: 3000 },
      );
      await processAction({ action: "kill", session_id: redirected.session_id });

      // The shell blocked on its own redirect is listed next to the child it started.
      const opening = await start(`mkfifo '${fifo}-2'; sleep 30 & read -r line <'${fifo}-2'`);
      await vi.waitFor(
        async () => {
          const result = await poll(opening, { yield_time_ms: 0 });
          assert.match(
            result.processes?.map((member) => `${member.command}: ${member.state}`).join() ?? "",
            /\(the command's shell\): opening a FIFO that no process has opened from the other end/u,
          );
        },
        { timeout: 3000 },
      );
      await processAction({ action: "kill", session_id: opening.session_id });
    },
  );

  test(
    "returns shortly after the shell exits and waits for background processes when polled",
    async () => {
      const started = performance.now();
      const response = await execute("bash", {
        command: "sleep 4 >/dev/null 2>&1 & printf started",
        yield_time_ms: 20_000,
      });
      const server = response.structuredContent as ProcessResult;
      assert.equal(server.state, "draining");
      if (process.platform === "linux") {
        assert.deepEqual(
          server.processes?.map((member) => member.command),
          ["sleep 4"],
        );
        assert.match(text(response), /still running: pid \d+ sleep 4 \(sleeping on a timer\)/u);
        // Refused input still shows what remains.
        const refused = await execute("process", {
          action: "write",
          session_id: server.session_id,
          chars: "x",
        });
        assert.match(text(refused), /still running: pid \d+ sleep 4/u);
      }
      assert.ok(performance.now() - started < 3000);
      const finished = await poll(server as ProcessResult, { yield_time_ms: 20_000 });
      assert.equal(finished.state, "exited");
      assert.ok(performance.now() - started >= 4000);
    },
    LONG_TEST_TIMEOUT_MS,
  );

  test.skipIf(process.platform !== "linux")(
    "shows pending limits, ongoing stops, and busy threads while draining",
    async () => {
      const pending = await execute("bash", {
        command: "sleep 8 >/dev/null 2>&1 & printf started",
        timeout_ms: 6000,
        yield_time_ms: 3000,
      });
      assert.match(text(pending), /still running: .*sleep 8.*; timeout_ms stops them at 6 s/u);

      const stubborn = await execute("bash", {
        command: "(trap '' TERM; sleep 9) >/dev/null 2>&1 & printf started",
        timeout_ms: 300,
        yield_time_ms: 3000,
      });
      assert.match(
        text(stubborn),
        /still running: .*; stopping them after timeout_ms at 0.3 s \(TERM, then KILL\)/u,
      );

      const worker = javascript(
        "new (require('node:worker_threads').Worker)('for (;;) {}', { eval: true })",
      );
      const busy = await execute("bash", {
        command: `${worker} >/dev/null 2>&1 & printf started`,
        yield_time_ms: 3000,
      });
      assert.match(text(busy), /running in another thread; main thread /u);
      const session = (busy.structuredContent as ProcessResult).session_id;
      await processAction({ action: "kill", session_id: session });
    },
    LONG_TEST_TIMEOUT_MS,
  );

  test(
    "stops commands at their time limit and reports requested kills as successful",
    async () => {
      const limited = await execute("bash", {
        command: "printf started; sleep 30",
        yield_time_ms: 0,
        timeout_ms: 300,
      });
      assert.equal(limited.isError, undefined);
      const task = limited.structuredContent as ProcessResult;
      const response = await execute("process", {
        action: "poll",
        session_id: task.session_id,
        yield_time_ms: 5000,
      });
      const stopped = response.structuredContent as ProcessResult;
      assert.equal(stopped.state, "exited");
      assert.equal(stopped.stopped_by, "timeout");
      assert.equal(stopped.signal, "SIGTERM");
      assert.equal(response.isError, true);
      assert.match(
        text(response),
        /stopped by timeout_ms at 0.3 s, exited with code 143 \(SIGTERM\) after 0 s; no processes remain/u,
      );

      const quick = await execute("bash", { command: "sleep 30", timeout_ms: 300 });
      assert.equal(quick.isError, true);
      assert.match(text(quick), /Command stopped by timeout_ms at 0.3 s/u);
      // A command that exits cleanly on TERM still did not finish within its limit.
      const graceful = await execute("bash", {
        command: "trap 'exit 0' TERM; sleep 30 & wait",
        timeout_ms: 300,
      });
      assert.equal((graceful.structuredContent as ProcessResult).exit_code, 0);
      assert.equal(graceful.isError, true);

      const running = await start("sleep 30");
      const killed = await execute("process", { action: "kill", session_id: running.session_id });
      assert.equal(killed.isError, undefined);
      assert.equal((killed.structuredContent as ProcessResult).stopped_by, "kill");
      assert.match(text(killed), /stopped by process kill, exited with code 143 \(SIGTERM\)/u);
      // A failure the shell reported before the kill stays one.
      const failing = await bash("sleep 30 & exit 7", 3000);
      assert.equal(failing.state, "draining");
      const stoppedAfterFailure = await execute("process", {
        action: "kill",
        session_id: failing.session_id,
      });
      assert.equal(stoppedAfterFailure.isError, true);

      const stubborn = await start("trap '' TERM; sleep 30");
      const stopping = await execute("process", {
        action: "kill",
        session_id: stubborn.session_id,
        yield_time_ms: 100,
      });
      assert.equal((stopping.structuredContent as ProcessResult).state, "running");
      assert.match(text(stopping), /stopping after process kill \(TERM, then KILL\)/u);
      assert.equal((await poll(stubborn, { yield_time_ms: 10_000 })).signal, "SIGKILL");
    },
    LONG_TEST_TIMEOUT_MS,
  );

  test.skipIf(process.platform !== "linux")(
    "ends the time limit once the process group has exited",
    async () => {
      // The detached loop leaves the group but keeps writing to the output past the limit.
      const response = await execute("bash", {
        command:
          "setsid -f sh -c 'while :; do echo; sleep 0.02; done & sleep 0.9; kill $!'; printf done",
        timeout_ms: 500,
        yield_time_ms: 5000,
      });
      const result = response.structuredContent as ProcessResult;
      assert.equal(result.exit_code, 0);
      assert.equal(result.stopped_by, undefined);
      assert.equal(response.isError, undefined);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "keeps the command text out of process command lines",
    async () => {
      // The marker is unique, so only this command's own processes could contain it.
      const marker = `marker-${Date.now()}`;
      const pattern = `${marker.slice(0, -1)}[${marker.slice(-1)}]`;
      const result = await bash(
        `: ${marker}; cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n' | grep -c '${pattern}'`,
        5000,
      );
      assert.equal(result.output, "0\n");
    },
  );

  test("shows a few frames spread over lines redrawn with carriage returns", async () => {
    const frames = Array.from({ length: 9 }, (_, index) => `${index + 1}/9`);
    const response = await execute("bash", {
      command: `printf '${frames.join("\\r")}\\nnext\\r'`,
    });
    assert.equal(text(response), "1/9\r3/9\r5/9\r7/9\r9/9\nnext\r");
    assert.equal(
      (response.structuredContent as ProcessResult).output,
      `${frames.join("\r")}\nnext\r`,
    );

    // A longer frame stays when shorter ones follow, as a terminal still shows its tail.
    const failed = [...frames.slice(0, 5), "6/9 FAILED: detail", ...frames.slice(6)];
    const residue = await execute("bash", { command: `printf '${failed.join("\r")}'` });
    assert.equal(text(residue), "1/9\r3/9\r5/9\r6/9 FAILED: detail\r7/9\r9/9");
    // Escape sequences, such as colors, cover no columns.
    // The colored frame is as long as the failure in characters, but covers three columns.
    const styled = [...failed.slice(0, 7), "\x1b[38;5;196m8/9\x1b[0m", "9/9"];
    const colored = await execute("bash", { command: `printf '${styled.join("\r")}'` });
    assert.match(text(colored), /6\/9 FAILED: detail/u);
    // Wide characters take two columns: four of them outlast four narrow ones.
    const wide = Array.from({ length: 9 }, (_, index) => `0${index + 1}/9`);
    wide[5] = "进度异常";
    const cjk = await execute("bash", { command: `printf '${wide.join("\r")}'` });
    assert.match(text(cjk), /进度异常/u);
  });

  test.skipIf(process.platform !== "linux")(
    "ends capture shortly after processes leave the group but keep writing",
    async () => {
      const started = performance.now();
      const escaped = await bash(
        "setsid sh -c 'while :; do printf .; sleep 0.02; done' & printf started",
        4000,
      );
      assert.equal(escaped.state, "exited");
      assert.match(escaped.output, /^started/u);
      assert.ok(performance.now() - started < 3000);
    },
    LONG_TEST_TIMEOUT_MS,
  );

  test.skipIf(process.platform !== "linux")(
    "reports a session whose group has exited as only capturing output, which kill does not stop",
    async () => {
      const escaped = await bash(
        "setsid -f sh -c 'while :; do printf .; sleep 0.02; done' & printf started",
      );
      // Capture of the escaped writer ends a second after the group exits.
      await vi.waitFor(
        async () => {
          const listed = await execute("process", { action: "list" });
          assert.match(text(listed), /its process group has exited/u);
        },
        { timeout: 900, interval: 20 },
      );
      const killed = await processAction({ action: "kill", session_id: escaped.session_id });
      assert.equal(killed.state, "exited");
      assert.equal(killed.stopped_by, undefined);
    },
  );

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
    "captures TERM cleanup output when kill starts while output is draining",
    async () => {
      const child = javascript(
        "process.on('SIGTERM',()=>{clearInterval(beat);setTimeout(()=>process.stdout.write('clean',()=>process.exit(0)),300)}); const beat=setInterval(()=>process.stdout.write('.'),20)",
      );
      const running = await start(`${child} & sleep 0.3`);
      await vi.waitFor(
        async () => assert.equal((await poll(running, { yield_time_ms: 0 })).state, "draining"),
        { timeout: 3000 },
      );
      const killed = await processAction({
        action: "kill",
        session_id: running.session_id,
        cursor_bytes: 0,
      });
      assert.equal(killed.state, "exited");
      assert.match(killed.output, /\.clean$/u);
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

  test("rejects invalid waits and limits, empty commands, and parameters of other actions", async () => {
    for (const value of [-1, NaN, Infinity]) {
      await assert.rejects(
        execute("bash", { command: "sleep 30", yield_time_ms: value }),
        /yield_time_ms must/u,
      );
    }
    for (const value of [0, -1, NaN, 2_147_483_648]) {
      await assert.rejects(
        execute("bash", { command: "sleep 30", timeout_ms: value }),
        /timeout_ms must/u,
      );
    }
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

  test("keeps commands running when their initial bash call is cancelled", async () => {
    const running = async () =>
      sessionIds(
        ((await reminder()) ?? "").split("Bash sessions running:")[1]?.split("finished since")[0],
      );
    const before = await running();
    const aborted = new AbortController();
    const initial = execute(
      "bash",
      { command: "IFS= read -r line", yield_time_ms: 60_000 },
      aborted.signal,
    );
    setTimeout(() => aborted.abort(), 50);
    await assert.rejects(initial);
    // The session ID never reached the model, so the reminder names the session.
    const [id] = (await running()).filter((item) => !before.includes(item));
    assert.ok(id);
    const done = await processAction({
      action: "write",
      session_id: id,
      chars: "go\n",
      yield_time_ms: 5000,
    });
    assert.equal(done.state, "exited");
  });

  test(
    "reminds about running and unreported sessions without changing stored history",
    async () => {
      const stored = structuredClone(session.sessionManager.getEntries());
      assert.equal(await reminder(), undefined);
      await bash("printf done", 1000);
      assert.equal(await reminder(), undefined);

      const concurrent = await Promise.all(
        // The pause keeps the finish out of the result of the write that ends the input.
        Array.from({ length: MAX_REPORTED_SESSIONS + 2 }, () =>
          start("IFS= read -r line; sleep 0.5; printf completed"),
        ),
      );
      const ids = concurrent.map((task) => task.session_id);
      // Concurrent starts register in completion order.
      const running = await reminder();
      assert.match(running ?? "", /^Bash sessions running: /u);
      assert.match(
        running ?? "",
        /\(IFS= read -r line; sleep 0.5; printf completed, running for \d+ s\)/u,
      );
      assert.deepEqual(sessionIds(running).sort(), ids.toSorted());

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
        assert.match(
          (await reminder()) ?? "",
          new RegExp(
            `^Bash sessions finished since last checked: ${unreported!.session_id} \\(IFS= read -r line; sleep 0.5; printf completed, exited with code 0 after \\d+ s\\); poll them to see their final output\\.$`,
            "u",
          ),
        ),
      );
      // A rejected observation does not count as reporting the finish.
      await assert.rejects(
        processAction({ action: "read", session_id: unreported!.session_id, cursor_bytes: 99 }),
        /between 0 and 9/u,
      );
      assert.deepEqual(sessionIds(await reminder()), [unreported!.session_id]);
      assert.equal((await poll(unreported!, { cursor_bytes: 0 })).output, "completed");
      assert.equal(await reminder(), undefined);
      assert.deepEqual(session.sessionManager.getEntries(), stored);

      const finished = (await processSessions()).filter(
        (task) => task.state === "exited" || task.state === "failed",
      );
      // Concurrent starts each prune; they must not claim the same sessions.
      assert.ok(finished.length >= MAX_REPORTED_SESSIONS + 2);
      const next = await Promise.all([start("IFS= read -r line"), start("IFS= read -r line")]);
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
