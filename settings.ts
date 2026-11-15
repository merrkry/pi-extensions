import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

const jsonObject = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject));

const main = Effect.gen(function* () {
  const [settingsFile, overrideFile] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.String, Schema.String]),
  )(process.argv.slice(2)).pipe(
    Effect.mapError(() => new Error("Usage: node settings.js <settings.json> <overrides.json>")),
  );
  const fs = yield* FileSystem.FileSystem;
  const overrides = yield* fs.readFileString(overrideFile).pipe(Effect.flatMap(jsonObject));
  if (Object.keys(overrides).length === 0) return;

  const directory = dirname(settingsFile);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      lockfile.lock(settingsFile, {
        realpath: false,
        retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
      }),
    ),
    (release) => Effect.promise(() => release()),
  );

  // Effect's filesystem stat follows symlinks; settings must be a regular file.
  const info = yield* Effect.tryPromise({
    try: () => lstat(settingsFile),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.catchIf(
      (error) => "code" in error && error.code === "ENOENT",
      () => Effect.succeed(undefined),
    ),
  );
  if (info && !info.isFile()) {
    return yield* Effect.fail(
      new Error(`Pi settings must be a regular writable file: ${settingsFile}`),
    );
  }
  const original = info ? yield* fs.readFileString(settingsFile) : "{}";
  const settings = yield* jsonObject(original);
  const child = yield* ChildProcess.make(
    "jq",
    ["--exit-status", "--slurpfile", "overrides", overrideFile, ". * $overrides[0]"],
    {
      stdin: Stream.make(new TextEncoder().encode(JSON.stringify(settings))),
      stderr: "inherit",
    },
  );
  const output = yield* Stream.mkString(Stream.decodeText(child.stdout));
  const code = yield* child.exitCode;
  if (code !== 0) return yield* Effect.fail(new Error(`jq failed with exit code ${code}`));

  const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".pi-settings-" });
  const path = join(temporary, "settings.json");
  const mode = info ? info.mode & 0o777 : 0o600;
  yield* fs.writeFileString(path, output, { mode });
  yield* fs.rename(path, settingsFile);
});

NodeRuntime.runMain(main.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
