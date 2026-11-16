import { Effect, FileSystem } from "effect";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  finalAt: number | undefined;
}

export interface AgentOptions {
  provider: string;
  model: string;
  thinking: string;
  /** Pi's auth.json, holding the provider's API key. */
  auth: string;
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

const parseLines = (content: string) =>
  content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

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

function apiKey(options: AgentOptions): string {
  const entry = (
    JSON.parse(readFileSync(options.auth, "utf8")) as Record<string, { key?: string }>
  )[options.provider];
  if (!entry?.key) throw new Error(`${options.auth} has no API key for ${options.provider}`);
  return entry.key;
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
        yield* fs.copyFile(options.auth, join(home, "agent", "auth.json"));
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
        let finalAt: number | undefined;
        for (const entry of parseLines(yield* fs.readFileString(file))) {
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
              finalAt = Date.parse(String(entry["timestamp"]));
            }
          } else if (message["role"] === "toolResult") {
            const call = calls.get(String(message["toolCallId"]));
            if (!call) continue;
            call.text = textOf(content);
            call.isError = message["isError"] === true;
            call.seconds = Number(message["durationMs"] ?? 0) / 1000;
          }
        }
        return { file, calls: [...calls.values()], finalText, finalAt };
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
  const key = apiKey(options);
  const env = (home: string) => ({ CODEX_HOME: home, EVAL_API_KEY: key });
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
        let finalAt: number | undefined;
        for (const line of parseLines(yield* fs.readFileString(file))) {
          if (line["type"] !== "response_item") continue;
          const item = line["payload"] as Record<string, unknown>;
          const type = item["type"];
          if (type === "function_call" || type === "custom_tool_call") {
            const raw = item["arguments"] ?? item["input"];
            let args: Record<string, unknown> = { input: raw };
            if (typeof raw === "string" && type === "function_call") {
              args = JSON.parse(raw) as Record<string, unknown>;
            }
            calls.set(String(item["call_id"]), {
              name: String(item["name"]),
              args,
              text: "",
              isError: false,
              seconds: 0,
            });
          } else if (type === "function_call_output" || type === "custom_tool_call_output") {
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
              finalAt = Date.parse(String(line["timestamp"]));
            }
          }
        }
        return { file, calls: [...calls.values()], finalText, finalAt };
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
