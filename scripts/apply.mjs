import { spawn } from "node:child_process";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
await runBuild();

const piConfigDir = process.env.PI_CONFIG_DIR || join(homedir(), ".pi");
const agentDir = process.env.PI_CODING_AGENT_DIR || join(piConfigDir, "agent");
const targetDirectory = join(agentDir, "extensions", "pi-extensions");
const source = join(root, "dist", "index.js");
const target = join(targetDirectory, "index.js");
const temporary = join(targetDirectory, `.index.js.tmp-${process.pid}`);

await mkdir(targetDirectory, { recursive: true });
try {
  await copyFile(source, temporary);
  await rename(temporary, target);
} finally {
  await rm(temporary, { force: true });
}

console.log(`Applied pi-extensions -> ${target}`);

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
