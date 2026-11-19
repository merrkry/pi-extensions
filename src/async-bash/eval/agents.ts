import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Schema } from "effect";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCall } from "./cases.ts";

/** A process to start for one agent turn. */
export interface Invocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Where the agent writes its final message, when stdout does not carry it. */
  answerFile?: string;
}

export interface Transcript {
  file: string;
  calls: ToolCall[];
  finalText: string;
  /** See `Run.answerStartedAt`. */
  answerStartedAt: number | undefined;
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
  prepare: (home: string) => Effect.Effect<void, unknown, FileSystem.FileSystem>;
  start: (home: string, workdir: string, prompt: string) => Invocation;
  transcript: (home: string) => Effect.Effect<Transcript, unknown, FileSystem.FileSystem>;
  /** Continues the finished session with `prompt`, without tools where the agent allows it. */
  debrief: (home: string, transcript: Transcript, prompt: string) => Invocation;
}

const textOf = (content: unknown) =>
  Array.isArray(content)
    ? content
        .filter(
          (part): part is { text: string } =>
            typeof part === "object" && part !== null && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("")
    : "";

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

/**
 * A JSONL transcript's records. A malformed line, e.g. one an agent stopped at its budget left
 * half written, fails only the attempt that read it.
 */
const parseLines = (content: string) =>
  Schema.decodeUnknownEffect(Schema.Array(JsonObject))(content.split("\n").filter(Boolean));

const onlyFile = (fs: FileSystem.FileSystem, directory: string) =>
  Effect.gen(function* () {
    const entries = yield* fs.readDirectory(directory, { recursive: true });
    const files = entries.filter((entry) => entry.endsWith(".jsonl"));
    if (files.length !== 1) {
      return yield* Effect.fail(
        new Error(`Expected one session in ${directory}, found ${files.length}`),
      );
    }
    return join(directory, files[0]!);
  });

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
    transcript: (home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = yield* onlyFile(fs, join(home, "sessions"));
        const calls = new Map<string, ToolCall>();
        let finalText = "";
        let answerStartedAt: number | undefined;
        let lastResultAt: number | undefined;
        for (const entry of yield* parseLines(yield* fs.readFileString(file))) {
          const message = entry["message"] as Record<string, unknown> | undefined;
          if (entry["type"] !== "message" || !message || !Array.isArray(message["content"])) {
            continue;
          }
          const content = message["content"] as Array<Record<string, unknown>>;
          if (message["role"] === "assistant") {
            for (const part of content) {
              if (part["type"] !== "toolCall") continue;
              calls.set(String(part["id"]), {
                name: String(part["name"]),
                args: (part["arguments"] ?? {}) as Record<string, unknown>,
                text: "",
                isError: false,
                seconds: 0,
              });
            }
            const text = textOf(content);
            if (text.trim()) {
              finalText = text;
              answerStartedAt = lastResultAt;
            }
          } else if (message["role"] === "toolResult") {
            lastResultAt = Date.parse(String(entry["timestamp"]));
            const call = calls.get(String(message["toolCallId"]));
            if (!call) continue;
            call.text = textOf(content);
            call.isError = message["isError"] === true;
            call.seconds = Number(message["durationMs"] ?? 0) / 1000;
          }
        }
        return { file, calls: [...calls.values()], finalText, answerStartedAt };
      }),
    debrief: (home, transcript, prompt) => ({
      command: process.execPath,
      args: [
        cli,
        ...isolation,
        "--session",
        transcript.file,
        "--no-tools",
        "--print",
        "--",
        prompt,
      ],
      env: env(home),
    }),
  };
}

export function codex(options: AgentOptions): Agent {
  const env = (home: string) => ({ CODEX_HOME: home, EVAL_API_KEY: options.key });
  const shared = [
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    `model_reasoning_effort="${options.thinking}"`,
  ];
  return {
    prepare: (home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The eval model gets the prompt and tools Codex ships for a model it knows.
        const bundled = execFileSync("codex", ["debug", "models", "--bundled"], {
          encoding: "utf8",
          env: { ...process.env, CODEX_HOME: home },
          stdio: ["ignore", "pipe", "ignore"],
        });
        const models = (JSON.parse(bundled) as { models: Array<Record<string, unknown>> }).models;
        const template = models.find((model) => model["slug"] === options.codexTemplate);
        if (!template) {
          return yield* Effect.fail(
            new Error(`Codex has no bundled model ${options.codexTemplate}`),
          );
        }
        const levels = template["supported_reasoning_levels"] as Array<{ effort: string }>;
        const catalog = {
          models: [
            {
              ...template,
              slug: options.model,
              display_name: options.model,
              default_reasoning_level: options.thinking,
              supported_reasoning_levels: levels.some((level) => level.effort === options.thinking)
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
      command: "codex",
      args: ["exec", "--json", ...shared, "-C", workdir, prompt],
      env: env(home),
    }),
    transcript: (home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = yield* onlyFile(fs, join(home, "sessions"));
        const calls = new Map<string, ToolCall>();
        let finalText = "";
        let answerStartedAt: number | undefined;
        let lastResultAt: number | undefined;
        for (const line of yield* parseLines(yield* fs.readFileString(file))) {
          if (line["type"] !== "response_item") continue;
          const item = line["payload"] as Record<string, unknown>;
          const type = item["type"];
          if (type === "function_call" || type === "custom_tool_call") {
            const raw = item["arguments"] ?? item["input"];
            let args: Record<string, unknown> = { input: raw };
            if (typeof raw === "string" && type === "function_call") {
              args = yield* Schema.decodeUnknownEffect(JsonObject)(raw);
            }
            calls.set(String(item["call_id"]), {
              name: String(item["name"]),
              args,
              text: "",
              isError: false,
              seconds: 0,
            });
          } else if (type === "function_call_output" || type === "custom_tool_call_output") {
            lastResultAt = Date.parse(String(line["timestamp"]));
            const call = calls.get(String(item["call_id"]));
            if (!call) continue;
            const output = item["output"];
            call.text =
              typeof output === "string" ? output : textOf(output) || JSON.stringify(output);
            const wall = /Wall time: ([\d.]+) seconds/u.exec(call.text);
            call.seconds = wall ? Number(wall[1]) : 0;
            call.isError = /Process exited with code [1-9]/u.test(call.text);
          } else if (type === "message" && item["role"] === "assistant") {
            const text = textOf(item["content"]);
            if (text.trim()) {
              finalText = text;
              answerStartedAt = lastResultAt;
            }
          }
        }
        return { file, calls: [...calls.values()], finalText, answerStartedAt };
      }),
    debrief: (home, transcript, prompt) => {
      const thread = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(
        transcript.file,
      )?.[1];
      const answerFile = join(home, "debrief.txt");
      return {
        command: "codex",
        args: ["exec", "resume", ...shared, "-o", answerFile, thread ?? "--last", prompt],
        env: env(home),
        answerFile,
      };
    },
  };
}
