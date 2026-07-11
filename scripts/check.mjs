import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const targetArguments = process.argv.slice(2);
const packagesDirectory = realpathSync(resolve(root, "packages"));
const targets = [...new Set(targetArguments.map(resolveTarget))];
const paths = targets.length === 0 ? ["."] : targets;

run("format", ["exec", "oxfmt", "--check", ...paths]);
run("lint", ["exec", "oxlint", ...paths, "--deny-warnings"]);

if (targets.length === 0) {
  run("typecheck", ["exec", "tsc", "-p", "tsconfig.json"]);
} else {
  for (const target of targets) {
    run(`typecheck (${target})`, ["exec", "tsc", "-p", `${target}/tsconfig.json`]);
  }
}

run("test", ["exec", "vitest", "run", ...paths, "--passWithNoTests"]);

function resolveTarget(argument) {
  const directTarget = resolve(process.cwd(), argument);
  const absoluteTarget = existsSync(directTarget)
    ? directTarget
    : resolve(packagesDirectory, argument);

  if (!existsSync(absoluteTarget)) {
    fail(`Package directory does not exist: ${argument}`);
  }

  const realTarget = realpathSync(absoluteTarget);
  const packagePath = relative(packagesDirectory, realTarget);

  if (
    packagePath === "" ||
    packagePath.startsWith(`..${sep}`) ||
    packagePath === ".." ||
    packagePath.includes(sep) ||
    !existsSync(resolve(realTarget, "package.json"))
  ) {
    fail(`Target must be a package directory under packages/: ${argument}`);
  }

  return relative(root, realTarget);
}

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

function fail(message) {
  console.error(message);
  process.exit(1);
}
