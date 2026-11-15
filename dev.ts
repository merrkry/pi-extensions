import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import { ChildProcess } from "effect/process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const agentDirectory = resolve(
    process.env["PI_DEV_AGENT_DIR"] ?? fileURLToPath(new URL("./.dev/agent", import.meta.url)),
  );
  yield* fs.makeDirectory(agentDirectory, { recursive: true, mode: 0o700 });
  const cli = fileURLToPath(
    new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
  );
  const extension = fileURLToPath(new URL("./dist/index.js", import.meta.url));
  const args = [
    cli,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-mcp",
    "--no-approve",
    "--extension",
    extension,
    ...process.argv.slice(2),
  ];
  yield* Effect.sync(() => console.error(`Pi development agent: ${agentDirectory}`));
  const child = yield* ChildProcess.make(process.execPath, args, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { PI_CODING_AGENT_DIR: agentDirectory },
    extendEnv: true,
    detached: false,
  });
  process.exitCode = yield* child.exitCode;
});

NodeRuntime.runMain(main.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
