import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packagesDir = fileURLToPath(new URL("../packages/", import.meta.url));
const requestedPackages = new Set(process.argv.slice(2).filter((arg) => arg !== "--"));
const entries = await readdir(packagesDir, { withFileTypes: true });
const packageNames = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => requestedPackages.size === 0 || requestedPackages.has(name))
  .toSorted();

if (requestedPackages.size > 0 && packageNames.length !== requestedPackages.size) {
  const missing = [...requestedPackages].filter((name) => !packageNames.includes(name));
  throw new Error(`Unknown package(s): ${missing.join(", ")}`);
}

await Promise.all(
  packageNames.map((name) =>
    build({
      entryPoints: [join(packagesDir, name, "src/index.ts")],
      outfile: join(packagesDir, name, "dist/index.js"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: [
        "@earendil-works/pi-agent-core",
        "@earendil-works/pi-ai",
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-tui",
        "typebox",
      ],
    }),
  ),
);
