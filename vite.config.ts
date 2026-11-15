import { isBuiltin } from "node:module";
import { defineConfig } from "vite-plus";

const runtimePackages = [
  /^@(?:earendil-works|mariozechner)\/pi-(?:ai|agent-core|coding-agent|tui)(?:\/|$)/,
  /^(?:@sinclair\/)?typebox(?:\/|$)/,
];

const entries = { index: "src/index.ts", settings: "settings.ts" };

const testCache = {
  // Automatic tracking misses Bun's file reads, so list the test inputs explicitly.
  input: [
    "*.ts",
    "src/**",
    "package.json",
    "tsconfig.json",
    "pnpm-lock.yaml",
    // Toolchain versions come from mise.
    "mise.toml",
  ],
  output: [],
  // NixOS bash re-reads the system environment, resetting PATH, without this marker.
  env: ["__NIXOS_SET_ENVIRONMENT_DONE"],
};

export default defineConfig({
  fmt: {
    // Written by Nix.
    ignorePatterns: ["flake.lock"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
  },
  run: {
    tasks: {
      "test:node": { command: "vp test", dependsOn: ["build"], cache: testCache },
      "test:bun": { command: "bun --bun run vp test", dependsOn: ["build"], cache: testCache },
    },
  },
  pack: Object.entries(entries).map(([name, entry]) => ({
    entry: { [name]: entry },
    target: "esnext",
    fixedExtension: false,
    dts: false,
    logLevel: "warn",
    deps: {
      neverBundle: runtimePackages,
      alwaysBundle: (id) => !isBuiltin(id) && !runtimePackages.some((pattern) => pattern.test(id)),
    },
    outputOptions: {
      codeSplitting: false,
      comments: { legal: true },
    },
  })),
});
