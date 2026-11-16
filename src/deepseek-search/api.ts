import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

// Consumed response fields: https://api-docs.deepseek.com/api/search/
const searchResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String.check(Schema.isMinLength(1)),
      title: Schema.String,
      snippet: Schema.String,
      summary: Schema.optional(Schema.String),
      date: Schema.NullOr(Schema.String),
    }),
  ),
});

// Consumed response fields: https://api-docs.deepseek.com/api/fetch/
const fetchResponse = Schema.Struct({ content: Schema.String });

export class WebError extends Data.TaggedError("WebError")<{
  code:
    | "INVALID_ARGS"
    | "WEB_PROVIDER_CREDENTIAL_MISSING"
    | "WEB_ABORTED"
    | "WEB_PROVIDER_ERROR"
    | "TOOL_TIMEOUT";
  message: string;
  cause?: unknown;
}> {
  constructor(code: WebError["code"], message: string, options?: ErrorOptions) {
    super({ code, message: `${code}: ${message}`, cause: options?.cause });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorDetail(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const error = data["error"];
  let detail: unknown = data["message"];
  if (typeof error === "string") detail = error;
  else if (isRecord(error)) detail = error["message"];
  return typeof detail === "string" && detail.length > 0 ? detail : undefined;
}

export class DeepSeekApi extends Context.Service<
  DeepSeekApi,
  {
    search: (request: {
      query: string;
      count: number;
      question: string | undefined;
    }) => Effect.Effect<typeof searchResponse.Type, WebError>;
    fetch: (url: string) => Effect.Effect<typeof fetchResponse.Type, WebError>;
  }
>()("@merrkry/pi-extensions/DeepSeekApi") {
  static layer(ctx: ExtensionToolContext) {
    return Layer.effect(
      DeepSeekApi,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const request = <A>(
          endpoint: "search" | "fetch",
          body: object,
          schema: Schema.Decoder<A>,
        ) => {
          const url = `https://api.deepseek.com/v1/tools/${endpoint}`;
          return Effect.gen(function* () {
            const auth = yield* Effect.tryPromise({
              try: () => ctx.modelRegistry.getProviderAuth("deepseek"),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            });
            const apiKey = auth?.auth.apiKey;
            if (!apiKey) {
              return yield* new WebError(
                "WEB_PROVIDER_CREDENTIAL_MISSING",
                "Set DEEPSEEK_API_KEY or configure DeepSeek in Pi's auth.json.",
              );
            }
            const response = yield* client.execute(
              HttpClientRequest.post(url).pipe(
                HttpClientRequest.bearerToken(apiKey),
                HttpClientRequest.acceptJson,
                HttpClientRequest.bodyJsonUnsafe(body),
              ),
            );
            if (response.status < 200 || response.status >= 300) {
              const data = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
              const detail = errorDetail(data);
              const message = `DeepSeek API error (HTTP ${response.status})`;
              return yield* Effect.fail(new Error(detail ? `${message}: ${detail}` : message));
            }
            const data = yield* response.json;
            return yield* Schema.decodeUnknownEffect(schema)(data).pipe(
              Effect.mapError(
                (cause) => new Error("DeepSeek returned an invalid response body", { cause }),
              ),
            );
          }).pipe(
            Effect.mapError((error) => {
              if (error instanceof WebError) return error;
              return new WebError(
                "WEB_PROVIDER_ERROR",
                `${error.message}\n\nThe web request used endpoint ${url}. Web API authentication and endpoint are separate from the selected chat model.`,
                { cause: error },
              );
            }),
          );
        };
        return {
          search: ({ query, count, question }) =>
            request(
              "search",
              {
                query,
                count,
                need_content: false,
                ...(question === undefined ? {} : { ori_question: question }),
              },
              searchResponse,
            ),
          fetch: (url) => request("fetch", { url }, fetchResponse),
        };
      }),
    ).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "error" })),
    );
  }
}
