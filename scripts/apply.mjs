import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const packagesDir = join(rootDir, "packages");
const requestedPackages = new Set(process.argv.slice(2).filter((arg) => arg !== "--"));
const availablePackages = (await readdir(packagesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted();
const packageNames = availablePackages.filter(
  (name) => requestedPackages.size === 0 || requestedPackages.has(name),
);

if (requestedPackages.size > 0 && packageNames.length !== requestedPackages.size) {
  const missing = [...requestedPackages].filter((name) => !availablePackages.includes(name));
  throw new Error(`Unknown package(s): ${missing.join(", ")}`);
}

await runBuild(packageNames);

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const extensionsDir = join(agentDir, "extensions");
await mkdir(extensionsDir, { recursive: true });

await Promise.all(packageNames.map(applyPackage));

async function applyPackage(name) {
  const source = join(packagesDir, name, "dist", "index.js");
  const targetDir = join(extensionsDir, name);
  const target = join(targetDir, "index.ts");
  const temporary = join(targetDir, `.index.ts.tmp-${process.pid}`);

  await mkdir(targetDir, { recursive: true });
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }

  // Remove files from the previous flat deployment layout to avoid loading twice.
  await Promise.all([
    rm(join(extensionsDir, `${name}.ts`), { force: true }),
    rm(join(extensionsDir, `${name}.js`), { force: true }),
  ]);

  console.log(`Applied ${name} -> ${target}`);
}

function runBuild(names) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(rootDir, "scripts", "build.mjs"), ...names], {
      cwd: rootDir,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Build failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}
