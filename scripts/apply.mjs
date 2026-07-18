import { spawn } from "node:child_process";
import { access, copyFile, cp, mkdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
await runBuild();

const piConfigDir = process.env.PI_CONFIG_DIR || join(homedir(), ".pi");
const agentDir = process.env.PI_CODING_AGENT_DIR || join(piConfigDir, "agent");
const targetDirectory = join(agentDir, "extensions", "pi-extensions");
const source = join(root, "dist", "index.js");
const target = join(targetDirectory, "index.js");
const temporary = join(targetDirectory, `.index.js.tmp-${process.pid}`);
const runtimeSource = dirname(require.resolve("node-pty/package.json"));
const runtimeTarget = join(targetDirectory, "node_modules", "node-pty");
const temporaryRuntime = join(targetDirectory, "node_modules", `.node-pty.tmp-${process.pid}`);

await mkdir(join(targetDirectory, "node_modules"), { recursive: true });
try {
  await copyNodePtyRuntime(runtimeSource, temporaryRuntime);
  await rm(runtimeTarget, { recursive: true, force: true });
  await rename(temporaryRuntime, runtimeTarget);
  await copyFile(source, temporary);
  await rename(temporary, target);
} finally {
  await rm(temporary, { force: true });
  await rm(temporaryRuntime, { recursive: true, force: true });
}

console.log(`Applied pi-extensions -> ${target}`);

async function copyNodePtyRuntime(sourceDirectory, destinationDirectory) {
  await mkdir(destinationDirectory, { recursive: true });
  const platformPrebuild = `${process.platform}-${process.arch}`;
  await Promise.all([
    copyFile(join(sourceDirectory, "package.json"), join(destinationDirectory, "package.json")),
    copyFile(join(sourceDirectory, "LICENSE"), join(destinationDirectory, "LICENSE")),
    cp(join(sourceDirectory, "lib"), join(destinationDirectory, "lib"), { recursive: true }),
    copyDirectoryIfPresent(
      join(sourceDirectory, "build", "Release"),
      join(destinationDirectory, "build", "Release"),
    ),
    copyDirectoryIfPresent(
      join(sourceDirectory, "prebuilds", platformPrebuild),
      join(destinationDirectory, "prebuilds", platformPrebuild),
    ),
  ]);
}

async function copyDirectoryIfPresent(sourceDirectory, destinationDirectory) {
  try {
    await access(sourceDirectory);
  } catch {
    return;
  }
  await mkdir(dirname(destinationDirectory), { recursive: true });
  await cp(sourceDirectory, destinationDirectory, { recursive: true });
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "scripts", "build.mjs")], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Build failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}
