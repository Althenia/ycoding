import { HttpRecorder } from "@ycoding-ai/http-recorder";
import { CacheHint, LLM, type Usage } from "@ycoding-ai/ai";
import { LLMClient, RequestExecutor } from "@ycoding-ai/ai/route";
import { AISDK } from "@ycoding-ai/core/aisdk";
import { Credential } from "@ycoding-ai/core/credential";
import { Global } from "@ycoding-ai/core/global";
import { Integration } from "@ycoding-ai/core/integration";
import { CatalogModel } from "@ycoding-ai/core/model";
import { PluginRegistry } from "@ycoding-ai/core/plugin";
import { PluginHost } from "@ycoding-ai/core/plugin/host";
import { claudeCodeMethodID, makeAnthropicPlugin } from "@ycoding-ai/core/plugin/provider/anthropic";
import {
  type ClaudeCodeCredentialSource,
} from "@ycoding-ai/core/plugin/provider/anthropic-claude-code";
import { createManagedClaudeCodeCredentialSource } from "@ycoding-ai/core/plugin/provider/anthropic-claude-code-login";
import { Provider } from "@ycoding-ai/core/provider";
import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import path from "node:path";
import { testEffect } from "../lib/effect";
import { PluginTestLayer } from "./fixture";

const cassette = "anthropic-oauth/claude-code-cache";
const directory = path.resolve(import.meta.dir, "../fixtures/recordings");
const recording = process.env.RECORD === "true";
const managedDirectory = path.join(Global.Path.data, "claude-code", "profiles");
const managedSource = createManagedClaudeCodeCredentialSource({ directory: managedDirectory });
const liveSource = process.env.YCODING_CLAUDE_RECORD_SOURCE;
const managedAccounts = recording && liveSource
  ? await managedSource.list().catch(() => [])
  : [];
const replaying =
  !recording && HttpRecorder.hasCassetteSync(cassette, { directory });
const enabled = replaying || (recording && managedAccounts.some((account) => account.source === liveSource));
const fixtureSource = {
  list: async () => [
    {
      label: "Claude",
      source: "11111111-1111-4111-8111-111111111111",
      credentials: {
        accessToken: "fixture",
        refreshToken: "fixture-refresh",
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    },
  ],
  read: async () => ({
    accessToken: "fixture",
    refreshToken: "fixture-refresh",
    expiresAt: Number.MAX_SAFE_INTEGER,
  }),
  write: async () => true,
} satisfies ClaudeCodeCredentialSource;
const credentialSource = recording ? managedSource : fixtureSource;
const selectedSource = recording ? liveSource : "11111111-1111-4111-8111-111111111111";

if (recording && enabled)
  HttpRecorder.removeCassetteSync(cassette, { directory });

const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer));
const it = testEffect(PluginTestLayer);
const recorded = enabled ? it.effect : it.effect.skip;

const inputBreakdown = (usage: Usage | undefined) =>
  (usage?.nonCachedInputTokens ?? 0) +
  (usage?.cacheReadInputTokens ?? 0) +
  (usage?.cacheWriteInputTokens ?? 0);

recorded("reads the provider prompt cache through Claude Code OAuth", () =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const aisdk = yield* AISDK.Service;
    const host = yield* PluginHost.make(yield* PluginRegistry.Service);
    if (!selectedSource) throw new Error("Select a signed-in managed Claude profile to record");
    const credentials = yield* Credential.Service;
    yield* credentials.create({
      integrationID: Integration.ID.make("anthropic"),
      value: Credential.OAuth.make({ type: "oauth", methodID: claudeCodeMethodID,
        access: selectedSource, refresh: "", expires: Number.MAX_SAFE_INTEGER,
        metadata: { authKind: "claude-code", source: selectedSource, managed: true } }),
    });
    let bearer = false;
    let apiKey = false;
    let beta = false;
    const recordedFetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const web =
          input instanceof Request
            ? new Request(input, init)
            : new Request(String(input), init);
        bearer ||=
          web.headers.get("authorization")?.startsWith("Bearer ") === true;
        apiKey ||= web.headers.has("x-api-key");
        beta ||=
          web.headers
            .get("anthropic-beta")
            ?.split(",")
            .some((item) => item.trim() === "oauth-2025-04-20") === true;
        return Effect.runPromise(
          Effect.gen(function* () {
            const request = HttpClientRequest.fromWeb(web);
            const response = yield* http.execute(request);
            return new Response(yield* response.arrayBuffer, {
              status: response.status,
              headers: response.headers,
            });
          }),
        );
      },
      { preconnect: fetch.preconnect },
    );

    yield* makeAnthropicPlugin({
      credentialSource,
      directory: managedDirectory,
      fetch: recordedFetch,
    }).effect(host);
    const runtime = CatalogModel.Info.make({
      ...CatalogModel.Info.empty(
        Provider.ID.anthropic,
        CatalogModel.ID.make("claude-haiku-4-5-20251001"),
      ),
      modelID: CatalogModel.ID.make("claude-haiku-4-5-20251001"),
      package: Provider.aisdk("@ai-sdk/anthropic"),
      settings: { apiKey: "claude-code", claudeCodeSource: selectedSource },
      limit: { context: 200_000, output: 8_192 },
    });
    const model = yield* aisdk.model(runtime);
    const request = LLM.request({
      id: "recorded_anthropic_oauth_cache",
      model,
      system: [
        {
          type: "text",
          text: "You are a concise factual assistant. ".repeat(1_000),
          cache: new CacheHint({ type: "ephemeral" }),
        },
      ],
      prompt: "Reply with exactly: hi",
      cache: "none",
      generation: { maxTokens: 16, temperature: 0 },
    });

    const first = yield* LLMClient.generate(request);
    const second = yield* LLMClient.generate(request);

    expect(bearer).toBe(true);
    expect(apiKey).toBe(false);
    expect(beta).toBe(true);
    expect(first.text.length).toBeGreaterThan(0);
    expect(second.text.length).toBeGreaterThan(0);
    const firstInput = first.usage?.inputTokens;
    const secondInput = second.usage?.inputTokens;
    if (firstInput === undefined || secondInput === undefined)
      throw new Error("Anthropic did not report input usage");
    expect(inputBreakdown(first.usage)).toBe(firstInput);
    expect(inputBreakdown(second.usage)).toBe(secondInput);
    expect(second.usage?.cacheReadInputTokens ?? 0).toBeGreaterThan(0);
  }).pipe(
    Effect.provide(client),
    Effect.provide(
      HttpRecorder.layerFetch(cassette, {
        directory,
        metadata: {
          provider: "anthropic",
          protocol: "ai-sdk-anthropic-claude-code",
          tags: ["oauth", "cache"],
        },
        redact: { allowRequestHeaders: ["anthropic-version"] },
      }),
    ),
  ),
);
