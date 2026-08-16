import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { LLM } from "@ycoding-ai/ai";
import { LLMClient } from "@ycoding-ai/ai/route";
import { AISDK } from "@ycoding-ai/core/aisdk";
import { Catalog } from "@ycoding-ai/core/catalog";
import { ModelV2 } from "@ycoding-ai/core/model";
import { PluginV2 } from "@ycoding-ai/core/plugin";
import { PluginHost } from "@ycoding-ai/core/plugin/host";
import { AnthropicPlugin } from "@ycoding-ai/core/plugin/provider/anthropic";
import { ProviderV2 } from "@ycoding-ai/core/provider";
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { testEffect } from "../lib/effect";
import { PluginTestLayer } from "./fixture";

const it = testEffect(PluginTestLayer);

const addPlugin = Effect.fn(function* () {
  const host = yield* PluginHost.make(yield* PluginV2.Service);
  yield* AnthropicPlugin.effect(host);
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value");
  return value;
}

describe("AnthropicPlugin", () => {
  it.effect(
    "merges Anthropic feature betas without overwriting configured values",
    () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service;
        yield* catalog.transform((draft) => {
          draft.provider.update(ProviderV2.ID.anthropic, (provider) => {
            provider.package = ProviderV2.aisdk("@ai-sdk/anthropic");
            provider.headers = {
              Existing: "1",
              "Anthropic-Beta":
                "custom-feature, interleaved-thinking-2025-05-14",
            };
          });
        });
        yield* addPlugin();

        const headers = required(
          yield* catalog.provider.get(ProviderV2.ID.anthropic),
        ).headers;
        expect(headers?.["anthropic-beta"]).toBe(
          "custom-feature,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
        );
        expect(headers?.Existing).toBe("1");
        expect(
          Object.keys(headers ?? {}).filter(
            (name) => name.toLowerCase() === "anthropic-beta",
          ),
        ).toHaveLength(1);
      }),
  );

  it.effect("ignores non-Anthropic providers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service;
      yield* catalog.transform((draft) =>
        draft.provider.update(ProviderV2.ID.openai, () => {}),
      );
      yield* addPlugin();
      expect(
        required(yield* catalog.provider.get(ProviderV2.ID.openai)).headers?.[
          "anthropic-beta"
        ],
      ).toBeUndefined();
    }),
  );

  it.effect("uses the model provider ID as the Anthropic SDK name", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service;
      yield* addPlugin();
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(
            ProviderV2.ID.make("custom-anthropic"),
            ModelV2.ID.make("claude-sonnet-4-5"),
          ),
          modelID: ModelV2.ID.make("claude-sonnet-4-5"),
          package: ProviderV2.aisdk("@ai-sdk/anthropic"),
        }),
        package: "@ai-sdk/anthropic",
        options: { name: "custom-anthropic", apiKey: "test" },
      });

      expect(result.sdk.languageModel("claude-sonnet-4-5").provider).toBe(
        "custom-anthropic",
      );
    }),
  );

  it.effect("uses x-api-key for Anthropic API-key credentials", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service;
      let headers: Headers | undefined;
      const request = Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          headers = new Headers(init?.headers);
          return Response.json({
            id: "msg_api_key",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
        { preconnect: fetch.preconnect },
      );
      yield* addPlugin();
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(
            ProviderV2.ID.anthropic,
            ModelV2.ID.make("claude-sonnet-4-6"),
          ),
          modelID: ModelV2.ID.make("claude-sonnet-4-6"),
          package: ProviderV2.aisdk("@ai-sdk/anthropic"),
        }),
        package: "@ai-sdk/anthropic",
        options: { name: "anthropic", apiKey: "api-test", fetch: request },
      });
      yield* Effect.tryPromise(() =>
        result.sdk.languageModel("claude-sonnet-4-6").doGenerate({
          prompt: [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
          ],
        }),
      );

      expect(headers?.get("x-api-key")).toBe("api-test");
      expect(headers?.get("authorization")).toBeNull();
    }),
  );

  it.effect(
    "serializes Opus 5 union tool schemas through the Anthropic adapter",
    () =>
      Effect.gen(function* () {
        const aisdk = yield* AISDK.Service;
        let body: Record<string, unknown> | undefined;
        const request = Object.assign(
          async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            body = JSON.parse(await new Response(init?.body).text());
            return Response.json({
              id: "msg_opus_5_tool",
              type: "message",
              role: "assistant",
              model: "claude-opus-5",
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          },
          { preconnect: fetch.preconnect },
        );
        yield* aisdk.hook.sdk((event) => {
          if (event.package !== "@ai-sdk/anthropic") return;
          event.options.apiKey = "api-test";
          event.options.fetch = request;
        });
        yield* addPlugin();
        const runtime = ModelV2.Info.make({
          ...ModelV2.Info.empty(
            ProviderV2.ID.anthropic,
            ModelV2.ID.make("claude-opus-5"),
          ),
          modelID: ModelV2.ID.make("claude-opus-5"),
          package: ProviderV2.aisdk("@ai-sdk/anthropic"),
        });
        const model = yield* aisdk.model(runtime);
        const anyOf = [
          {
            type: "object",
            properties: { action: { type: "string", enum: ["list"] } },
            required: ["action"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              action: { type: "string", enum: ["send"] },
              text: { type: "string" },
            },
            required: ["action", "text"],
            additionalProperties: false,
          },
        ];
        const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
          LLM.request({
            model,
            prompt: "Use the tool.",
            tools: [
              {
                name: "subagent_control",
                description: "Control subagents.",
                inputSchema: { anyOf },
              },
            ],
          }),
        );
        yield* Effect.tryPromise(() =>
          aisdk.language(runtime).pipe(Effect.runPromise),
        ).pipe(
          Effect.flatMap((language) =>
            Effect.tryPromise(() => language.doGenerate(prepared.body)),
          ),
        );

        expect(body).toMatchObject({
          model: "claude-opus-5",
          tools: [
            {
              name: "subagent_control",
              input_schema: {
                type: "object",
                $ref: "#/$defs/__ycoding_root",
                $defs: { __ycoding_root: { type: "object", anyOf } },
              },
            },
          ],
        });
      }),
  );

  it.effect(
    "serializes cache control through the installed Anthropic adapter",
    () =>
      Effect.gen(function* () {
        const aisdk = yield* AISDK.Service;
        let body: Record<string, unknown> | undefined;
        const request = Object.assign(
          async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            body = JSON.parse(await new Response(init?.body).text());
            return Response.json({
              id: "msg_cache",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 1,
                cache_read_input_tokens: 0,
              },
            });
          },
          { preconnect: fetch.preconnect },
        );
        yield* addPlugin();
        const result = yield* aisdk.runSDK({
          model: ModelV2.Info.make({
            ...ModelV2.Info.empty(
              ProviderV2.ID.anthropic,
              ModelV2.ID.make("claude-sonnet-4-6"),
            ),
            modelID: ModelV2.ID.make("claude-sonnet-4-6"),
            package: ProviderV2.aisdk("@ai-sdk/anthropic"),
          }),
          package: "@ai-sdk/anthropic",
          options: { name: "anthropic", apiKey: "test", fetch: request },
        });
        yield* Effect.tryPromise(() =>
          result.sdk.languageModel("claude-sonnet-4-6").doGenerate({
            prompt: [
              {
                role: "system",
                content: "stable",
                providerOptions: {
                  anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
                },
              },
            ],
          }),
        );

        expect(body).toMatchObject({
          system: [
            {
              type: "text",
              text: "stable",
              cache_control: { type: "ephemeral", ttl: "5m" },
            },
          ],
        });
      }),
  );
});
