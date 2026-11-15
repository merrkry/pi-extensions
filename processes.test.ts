import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, FileSystem, Scope } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { expect, test, vi } from "vite-plus/test";
import { Output } from "./src/async-bash/output.ts";
import { makeProcesses } from "./src/async-bash/processes.ts";

test("keeps the combined log valid UTF-8 across interleaved channels and decoder flushes", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const scope = yield* Scope.Scope;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-log-encoding-" });
        const path = join(directory, "output.log");
        const output = yield* Output.make(fs, path, scope);
        const prefix = "x".repeat(64 * 1024);
        const emoji = Buffer.from("😀");
        yield* output.append(Buffer.from(prefix), "stdout");
        yield* output.append(emoji.subarray(0, 2), "stdout");
        yield* output.append(Buffer.from("stderr"), "stderr");
        yield* output.append(emoji.subarray(2), "stdout");
        expect(yield* fs.readFileString(path)).toBe(prefix + "stderr😀");
        yield* output.append(Buffer.from([0xc3]), "stderr");
        yield* output.finish();
        expect(yield* fs.readFileString(path)).toBe(prefix + "stderr😀�");
        expect((yield* output.page(0, "end")).output.endsWith("stderr😀�")).toBe(true);
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

test("reports draining until slow output processing has logged everything", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-slow-output-"));
  const manager = await Effect.runPromise(makeProcesses);
  // oxlint-disable-next-line typescript/unbound-method -- the spy calls it with its own `this`.
  const append = Output.prototype.append;
  vi.spyOn(Output.prototype, "append").mockImplementation(function (this: Output, data, channel) {
    return append.call(this, data, channel).pipe(Effect.andThen(Effect.sleep(250)));
  });
  try {
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    const task = await Effect.runPromise(
      manager.start({
        command: `${quote(process.execPath)} -e ${quote("process.stdout.write('x'.repeat(256 * 1024) + 'TAIL')")}`,
        cwd: directory,
        env: process.env,
      }),
    );
    await vi.waitFor(async () => {
      const draining = await Effect.runPromise(manager.poll(task.id, 0, 0));
      expect(draining.state).toBe("draining");
      expect(draining.exit_code).toBe(0);
    });
    const result = await Effect.runPromise(manager.poll(task.id, 10_000, 0));
    expect(result.state).toBe("exited");
    expect(result.output.endsWith("TAIL")).toBe(true);
    expect(result.total_bytes).toBe(256 * 1024 + 4);
  } finally {
    await Effect.runPromise(manager.shutdown);
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
