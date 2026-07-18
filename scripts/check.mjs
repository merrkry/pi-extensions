import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

run("format", ["exec", "oxfmt", "--check", "."]);
run("lint", ["exec", "oxlint", ".", "--deny-warnings"]);
run("typecheck", ["exec", "tsc", "-p", "tsconfig.json"]);
run("test", ["exec", "vitest", "run"]);
run("build", ["run", "build"]);

function run(name, arguments_) {
  console.log(`\n> ${name}`);
  const result = spawnSync("pnpm", arguments_, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
