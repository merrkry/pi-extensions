import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Schema } from "effect";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCall } from "./cases.ts";

/** A process to start for one agent turn. */
export interface Invocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  readOnly?: string[];
  /** Where the agent writes its final message, when stdout does not carry it. */
  answerFile?: string;
}

interface TranscriptSummary {
  calls: ToolCall[];
  failure?: string;
}

export interface AgentOptions {
  provider: string;
  model: string;
  thinking: string;
  /** The provider's API key, the only credential agents get. */
  key: string;
  /** Pi: the extension entry point to load. */
  extension: string;
  /** Codex: the provider's Responses API base URL. */
  baseUrl: string;
  /** Codex: the bundled model whose prompt and tools the eval model gets. */
  codexTemplate: string;
}

/** One coding agent, run in a home directory of its own so attempts share no state. */
export interface Agent {
  version: Invocation;
  prepare: (home: string) => Effect.Effect<void, unknown, FileSystem.FileSystem>;
  start: (home: string, workdir: string, prompt: string) => Invocation;
  decodeTranscript: (raw: string) => Effect.Effect<TranscriptSummary, unknown>;
  /** Continues the finished session with `prompt`, without tools where the agent allows it. */
  debrief: (home: string, sessionFile: string, prompt: string) => Invocation;
}

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const JsonObject = Schema.fromJsonString(JsonRecord);
const readRecord = Schema.decodeUnknownEffect(JsonRecord);
const readContent = Schema.decodeUnknownEffect(Schema.Array(JsonRecord));
const textOf = (content: ReadonlyArray<Record<string, unknown>>) =>
  content.map((part) => (typeof part["text"] === "string" ? part["text"] : "")).join("");

const readPiCall = Schema.decodeUnknownEffect(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
  }),
);
const readPiResult = Schema.decodeUnknownEffect(
  Schema.Struct({
    toolCallId: Schema.String,
    durationMs: Schema.optional(Schema.Finite),
  }),
);
const readPiStatus = Schema.decodeUnknownEffect(
  Schema.Struct({
    stopReason: Schema.optional(Schema.String),
    errorMessage: Schema.optional(Schema.String),
  }),
);
const readCodexCall = Schema.decodeUnknownEffect(
  Schema.Struct({ call_id: Schema.String, name: Schema.String }),
);
const readCodexOutputId = Schema.decodeUnknownEffect(Schema.Struct({ call_id: Schema.String }));

/**
 * A JSONL transcript's records. A malformed line, e.g. one an agent stopped at its budget left
 * half written, fails only the attempt that read it.
 */
const parseLines = (content: string) =>
  Schema.decodeUnknownEffect(Schema.Array(JsonObject))(content.split("\n").filter(Boolean));

/** The provider's API key from Pi's auth.json, resolved as Pi resolves it, e.g. from a command. */
export async function providerKey(auth: string, provider: string, modelsCache: string) {
  const runtime = await ModelRuntime.create({
    authPath: auth,
    modelsPath: null,
    modelsStorePath: modelsCache,
    refreshOnCreate: false,
  });
  const key = (await runtime.getAuth(provider))?.auth.apiKey;
  if (!key) throw new Error(`${auth} has no API key for ${provider}`);
  return key;
}

export function pi(options: AgentOptions): Agent {
  const cli = fileURLToPath(
    new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
  );
  const isolation = [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-mcp",
    "--no-approve",
    "--extension",
    options.extension,
    "--provider",
    options.provider,
    "--model",
    options.model,
    "--thinking",
    options.thinking,
  ];
  const env = (home: string) => ({
    PI_CODING_AGENT_DIR: join(home, "agent"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  });
  return {
    version: { command: process.execPath, args: [cli, "--version"], env: {} },
    prepare: (home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(join(home, "agent"), { recursive: true, mode: 0o700 });
        yield* fs.makeDirectory(join(home, "sessions"), { mode: 0o700 });
        yield* fs.writeFileString(
          join(home, "agent", "auth.json"),
          JSON.stringify({ [options.provider]: { type: "api_key", key: options.key } }),
          { mode: 0o600 },
        );
      }),
    start: (home, _workdir, prompt) => ({
      command: process.execPath,
      args: [
        cli,
        ...isolation,
        "--session-dir",
        join(home, "sessions"),
        "--print",
        "--mode",
        "json",
        "--",
        prompt,
      ],
      env: env(home),
    }),
    decodeTranscript: (raw) =>
      Effect.gen(function* () {
        const calls = new Map<string, ToolCall>();
        let failure: string | undefined;
        for (const entry of yield* parseLines(raw)) {
          if (entry["type"] !== "message") continue;
          const message = yield* readRecord(entry["message"]);
          if (message["role"] === "assistant") {
            const status = yield* readPiStatus(message);
            failure = undefined;
            if (
              status.stopReason === "error" ||
              status.stopReason === "aborted" ||
              status.stopReason === "length"
            ) {
              const summary = `Pi assistant stopped with ${status.stopReason}`;
              failure = status.errorMessage ? `${summary}\n${status.errorMessage}` : summary;
            }
            const content = yield* readContent(message["content"]);
            for (const part of content) {
              if (part["type"] !== "toolCall") continue;
              const call = yield* readPiCall(part);
              calls.set(call.id, {
                name: call.name,
                text: "",
                seconds: 0,
              });
            }
          } else if (message["role"] === "toolResult") {
            const result = yield* readPiResult(message);
            const content = yield* readContent(message["content"]);
            const call = calls.get(result.toolCallId);
            if (!call) continue;
            call.text = textOf(content);
            call.seconds = (result.durationMs ?? 0) / 1000;
          }
        }
        return {
          calls: [...calls.values()],
          ...(failure ? { failure } : {}),
        };
      }),
    debrief: (home, sessionFile, prompt) => ({
      command: process.execPath,
      args: [cli, ...isolation, "--session", sessionFile, "--no-tools", "--print", "--", prompt],
      env: env(home),
    }),
  };
}

export function codex(options: AgentOptions): Agent {
  const command = realpathSync(
    execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim(),
  );
  const modulesAt = command.indexOf("/node_modules/");
  const readOnly = [command];
  if (modulesAt !== -1) readOnly.push(command.slice(0, modulesAt + "/node_modules".length));
  const env = (home: string) => ({ CODEX_HOME: home, EVAL_API_KEY: options.key });
  const shared = [
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    `model_reasoning_effort="${options.thinking}"`,
  ];
  return {
    version: { command, args: ["--version"], env: {}, readOnly },
    prepare: (home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The eval model gets the prompt and tools Codex ships for a model it knows.
        const catalog = yield* Effect.try({
          try: () => {
            const bundled = execFileSync(command, ["debug", "models", "--bundled"], {
              encoding: "utf8",
              env: { ...process.env, CODEX_HOME: home },
              stdio: ["ignore", "pipe", "ignore"],
            });
            const models = (JSON.parse(bundled) as { models: Array<Record<string, unknown>> })
              .models;
            const template = models.find((model) => model["slug"] === options.codexTemplate);
            if (!template) throw new Error(`Codex has no bundled model ${options.codexTemplate}`);
            const levels = template["supported_reasoning_levels"] as Array<{ effort: string }>;
            return {
              models: [
                {
                  ...template,
                  slug: options.model,
                  display_name: options.model,
                  default_reasoning_level: options.thinking,
                  supported_reasoning_levels: levels.some(
                    (level) => level.effort === options.thinking,
                  )
                    ? levels
                    : [...levels, { effort: options.thinking, description: options.thinking }],
                  visibility: "list",
                  upgrade: null,
                  availability_nux: null,
                  service_tiers: [],
                  additional_speed_tiers: [],
                  input_modalities: ["text"],
                },
              ],
            };
          },
          catch: (error) =>
            new Error(`Could not prepare the Codex model catalog. ${String(error)}`),
        });
        yield* fs.writeFileString(join(home, "catalog.json"), JSON.stringify(catalog));
        yield* fs.writeFileString(
          join(home, "config.toml"),
          [
            `model = "${options.model}"`,
            `model_provider = "eval"`,
            `model_catalog_json = "${join(home, "catalog.json")}"`,
            "",
            "[model_providers.eval]",
            `name = "${options.provider}"`,
            `base_url = "${options.baseUrl}"`,
            `env_key = "EVAL_API_KEY"`,
            `wire_api = "responses"`,
            "",
          ].join("\n"),
        );
      }),
    start: (home, workdir, prompt) => ({
      command,
      readOnly,
      args: ["exec", "--json", ...shared, "-C", workdir, prompt],
      env: env(home),
    }),
    decodeTranscript: (raw) =>
      Effect.gen(function* () {
        const calls = new Map<string, ToolCall>();
        for (const line of yield* parseLines(raw)) {
          if (line["type"] !== "response_item") continue;
          const item = yield* readRecord(line["payload"]);
          const type = item["type"];
          if (type === "function_call" || type === "custom_tool_call") {
            const call = yield* readCodexCall(item);
            calls.set(call.call_id, {
              name: call.name,
              text: "",
              seconds: 0,
            });
          } else if (type === "function_call_output" || type === "custom_tool_call_output") {
            const result = yield* readCodexOutputId(item);
            const call = calls.get(result.call_id);
            if (!call) continue;
            const output = item["output"];
            if (typeof output === "string") call.text = output;
            else if (Array.isArray(output)) call.text = textOf(yield* readContent(output));
            else call.text = JSON.stringify(output) ?? "";
            const wall = /Wall time: ([\d.]+) seconds/u.exec(call.text);
            call.seconds = wall ? Number(wall[1]) : 0;
          }
        }
        return { calls: [...calls.values()] };
      }),
    debrief: (home, sessionFile, prompt) => {
      const thread = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(
        sessionFile,
      )?.[1];
      const answerFile = join(home, "debrief.txt");
      return {
        command,
        readOnly,
        args: ["exec", "resume", ...shared, "-o", answerFile, thread ?? "--last", prompt],
        env: env(home),
        answerFile,
      };
    },
  };
}
