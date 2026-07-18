import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sanitizeTerminalOutput } from "../shared/sanitize-terminal.js";

let lastLoadWarning: string | undefined;

const ENV_KEY_CONTROL_CHAR_PATTERN = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f]`, "u");
const MAX_WARNING_MESSAGES = 5;

type WarningCollector = {
  messages: string[];
  omitted: number;
};

function isEnvRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasControlChar(value: string): boolean {
  return ENV_KEY_CONTROL_CHAR_PATTERN.test(value);
}

function isUsableEnvKey(key: string): boolean {
  return key.length > 0 && !key.includes("=") && !hasControlChar(key);
}

function isUsableEnvValue(value: string): boolean {
  return !value.includes("\0");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function resolveAgentDir(): string {
  const configDir = process.env.PI_CONFIG_DIR;
  return process.env.PI_CODING_AGENT_DIR || (configDir ? join(configDir, "agent") : getAgentDir());
}

function readJsonFile(path: string): unknown {
  const source = readFileSync(path, "utf8");
  return JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
}

function addWarning(warnings: WarningCollector, message: string): void {
  if (warnings.messages.length < MAX_WARNING_MESSAGES) {
    warnings.messages.push(message);
  } else {
    warnings.omitted++;
  }
}

function assignEnvValue(key: string, value: string, warnings: WarningCollector): void {
  try {
    process.env[key] = value;
  } catch (error) {
    addWarning(warnings, `ignored ${key}: ${describeError(error)}`);
  }
}

function formatWarnings(warnings: WarningCollector): string | undefined {
  if (warnings.messages.length === 0) return undefined;

  return `[early-env] ${warnings.messages.join("; ")}${warnings.omitted > 0 ? `; ${warnings.omitted} more ignored` : ""}`;
}

function loadGlobalEnvJson(): void {
  let envPath: string | undefined;

  try {
    envPath = join(resolveAgentDir(), "env.json");
    const parsed = readJsonFile(envPath);
    if (!isEnvRecord(parsed)) {
      lastLoadWarning = `[early-env] ${envPath} must contain a JSON object`;
      return;
    }

    const warnings: WarningCollector = { messages: [], omitted: 0 };
    for (const [key, value] of Object.entries(parsed)) {
      if (!isUsableEnvKey(key)) {
        addWarning(warnings, `ignored invalid key ${JSON.stringify(key)}`);
        continue;
      }

      if (typeof value !== "string") {
        addWarning(warnings, `ignored ${key}: value must be a string`);
        continue;
      }

      if (!isUsableEnvValue(value)) {
        addWarning(warnings, `ignored ${key}: value contains a NUL byte`);
        continue;
      }

      assignEnvValue(key, value, warnings);
    }

    lastLoadWarning = formatWarnings(warnings);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      lastLoadWarning = undefined;
      return;
    }

    lastLoadWarning = `[early-env] failed to read ${envPath ?? "env.json"}: ${describeError(error)}`;
  }
}

// Earliest point this extension can affect process.env: module evaluation.
loadGlobalEnvJson();

export default function earlyEnv(pi: ExtensionAPI) {
  // Run again when the factory is called, after pi has finished constructing the extension API.
  loadGlobalEnvJson();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI && lastLoadWarning) {
      ctx.ui.notify(sanitizeTerminalOutput(lastLoadWarning), "warning");
    }
  });
}
