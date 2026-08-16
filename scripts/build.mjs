import { cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const outputDirectory = join(root, "dist");
const webAccessRoot = dirname(require.resolve("pi-web-access/package.json"));

await rm(outputDirectory, { recursive: true, force: true });
await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile: join(outputDirectory, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@homebridge/node-pty-prebuilt-multiarch",
    "typebox",
  ],
});

await cp(join(webAccessRoot, "skills"), join(outputDirectory, "skills"), { recursive: true });
