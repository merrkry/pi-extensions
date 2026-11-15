import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import deepseekSearch from "./deepseek-search/index.ts";
import asyncBash from "./async-bash/index.ts";

const extensions: readonly ExtensionFactory[] = [deepseekSearch, asyncBash];

export default async function (pi: ExtensionAPI): Promise<void> {
  await Effect.runPromise(
    Effect.forEach(extensions, (extension) => Effect.tryPromise(async () => extension(pi)), {
      concurrency: 1,
      discard: true,
    }),
  );
}
