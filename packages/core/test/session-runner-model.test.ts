import { describe, expect } from "bun:test";
import { LLM, Message, Model, SystemPart, ToolDefinition } from "@ycoding-ai/ai";
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy";
import type { OpenAIResponsesBody } from "@ycoding-ai/ai/protocols/openai-responses";
import { LLMClient } from "@ycoding-ai/ai/route";
import { DateTime, Effect } from "effect";
import { Money } from "@ycoding-ai/schema/money";
import { Headers } from "effect/unstable/http";
import { Credential } from "@ycoding-ai/core/credential";
import { Integration } from "@ycoding-ai/core/integration";
import { ModelV2 } from "@ycoding-ai/core/model";
import { ProviderV2 } from "@ycoding-ai/core/provider";
import { ProjectV2 } from "@ycoding-ai/core/project";
import { claudeCodeMethodID } from "@ycoding-ai/core/plugin/provider/anthropic";
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model";
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache";
import { SessionV2 } from "@ycoding-ai/core/session";
import { AbsolutePath } from "@ycoding-ai/core/schema";
import { it } from "./lib/effect";

interface ModelOptions {
  readonly id?: string;
  readonly providerID?: string;
  readonly modelID?: string;
  readonly settings?: ModelV2.Info["settings"];
  readonly headers?: ModelV2.Info["headers"];
  readonly body?: ModelV2.Info["body"];
  readonly variants?: ModelV2.Info["variants"];
}

const model = (packageName: string | undefined, options: ModelOptions = {}) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make(options.id ?? "test-model"),
    modelID: ModelV2.ID.make(options.modelID ?? "api-test-model"),
    providerID: ProviderV2.ID.make(options.providerID ?? "test-provider"),
    name: "Test model",
    package: packageName,
    settings: options.settings ?? {},
    headers: options.headers ?? { "x-test": "header" },
    body: options.body ?? { custom_extension: { enabled: true } },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: options.variants ?? [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 100, output: 20 },
  });

const cacheSystem = [SystemPart.make("Stable cache system")];
const cacheTools = [
  ToolDefinition.make({
    name: "lookup",
    description: "Look up a value",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  }),
];

const assembleCacheRequest = (
  catalog: ModelV2.Info,
  messages: ReadonlyArray<Message>,
  sessionID: string,
  scope?: SessionRunnerCache.PromptCacheNamespaceInput["scope"],
) =>
  Effect.gen(function* () {
    const resolved = yield* SessionRunnerModel.fromCatalogModel(catalog);
    const namespaceInput = {
      ...(scope === undefined ? {} : { scope }),
      projectID: "project",
      directory: "/repo",
      providerID: catalog.providerID,
      modelID: catalog.id,
      variant: "default",
      policyRevision: CACHE_POLICY_REVISION,
      permissions: [],
      system: cacheSystem,
      tools: cacheTools,
    } satisfies SessionRunnerCache.PromptCacheNamespaceInput;
    const cache = SessionRunnerCache.providerOptions({
      ...namespaceInput,
      apiModelID: resolved.id,
      sessionID,
      routeID: resolved.route.id,
      openaiMode: "auto",
    });
    return {
      cache,
      namespaceInput,
      request: LLM.request({
        model: resolved,
        system: cacheSystem,
        messages,
        tools: cacheTools,
        providerOptions: cache.providerOptions,
        cache: cache.cache,
      }),
      resolved,
    };
  });

describe("SessionRunnerModel", () => {
  it.effect(
    "uses the API modelID instead of the catalog ID for native OpenAI routes",
    () =>
      Effect.gen(function* () {
        const catalog = model(ProviderV2.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
        });
        const resolved = yield* SessionRunnerModel.fromCatalogModel(catalog);

        expect(catalog.id).toBe(ModelV2.ID.make("test-model"));
        expect(resolved).toMatchObject({
          id: "api-test-model",
          provider: "test-provider",
        });
        expect(resolved.route).toMatchObject({
          id: "openai-responses",
          providerMetadataKey: "openai",
          endpoint: { baseURL: "https://openai.example/v1" },
          defaults: {
            headers: { "x-test": "header" },
            limits: { context: 100, output: 20 },
            http: { body: { custom_extension: { enabled: true } } },
          },
        });
      }),
  );

  it.effect("keeps catalog apiKey credentials out of provider JSON", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model(ProviderV2.aisdk("@ai-sdk/openai"), {
          settings: { apiKey: "secret", baseURL: "https://openai.example/v1" },
        }),
      );
      const prepared = yield* LLMClient.prepare(
        LLM.request({ model: resolved, prompt: "Hello" }),
      );

      expect(JSON.stringify(prepared.body)).not.toContain("apiKey");
      expect(JSON.stringify(prepared.body)).not.toContain("secret");
    }),
  );

  it.effect("treats an empty configured API key as omitted", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model(ProviderV2.aisdk("@ai-sdk/openai"), {
          settings: { apiKey: "", baseURL: "https://openai.example/v1" },
        }),
      );
      const headers = yield* resolved.route.auth.apply({
        request: LLM.request({ model: resolved, prompt: "Hello" }),
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      });

      expect(headers.authorization).toBeUndefined();
    }),
  );

  it.effect(
    "uses merged API settings for OpenAI-compatible auth and request defaults",
    () =>
      Effect.gen(function* () {
        const resolved = yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/openai-compatible"), {
            settings: {
              apiKey: "settings-secret",
              baseURL: "https://compatible.example/v1",
              compatibility: "strict",
            },
            headers: {},
            body: {},
          }),
        );
        const request = LLM.request({ model: resolved, prompt: "Hello" });
        const headers = yield* resolved.route.auth.apply({
          request,
          method: "POST",
          url: "https://compatible.example/v1/chat/completions",
          body: "{}",
          headers: Headers.empty,
        });

        expect(headers.authorization).toBe("Bearer settings-secret");
        expect(resolved.route.id).toBe("openai-compatible-chat");
        expect(resolved.route.endpoint.baseURL).toBe(
          "https://compatible.example/v1",
        );
        expect(resolved.route.defaults.http?.body).toEqual({});
      }),
  );

  it.effect(
    "overlays selected OpenAI Session variant settings and bodies",
    () =>
      Effect.gen(function* () {
        const catalog = model(ProviderV2.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
          variants: [
            {
              id: ModelV2.VariantID.make("high"),
              settings: { reasoningEffort: "high" },
              headers: { "x-variant": "high" },
              body: {
                store: false,
                service_tier: "priority",
                temperature: 0.2,
              },
            },
          ],
        });
        const session = SessionV2.Info.make({
          id: SessionV2.ID.make("ses_model_variant"),
          projectID: ProjectV2.ID.global,
          title: "test",
          model: {
            id: catalog.id,
            providerID: catalog.providerID,
            variant: ModelV2.VariantID.make("high"),
          },
          cost: Money.USD.zero,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          time: {
            created: DateTime.makeUnsafe(0),
            updated: DateTime.makeUnsafe(0),
          },
          location: { directory: AbsolutePath.make("/project") },
        });

        const resolved = yield* SessionRunnerModel.resolve(session, catalog);

        expect(resolved.route.defaults.headers).toMatchObject({
          "x-test": "header",
          "x-variant": "high",
        });
        expect(resolved.route.defaults.http?.body).toEqual({
          custom_extension: { enabled: true },
          store: false,
          service_tier: "priority",
          temperature: 0.2,
        });
        expect(resolved.route.defaults.providerOptions).toEqual({
          openai: { store: false, reasoningEffort: "high" },
        });
      }),
  );

  it.effect("overlays selected OpenAI-compatible Session variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model(ProviderV2.aisdk("@ai-sdk/openai-compatible"), {
        settings: { baseURL: "https://compatible.example/v1" },
        variants: [
          {
            id: ModelV2.VariantID.make("high"),
            settings: {},
            headers: {},
            body: { store: false, reasoning_effort: "high" },
          },
        ],
      });
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_compatible_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: ModelV2.VariantID.make("high"),
        },
        cost: Money.USD.zero,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        time: {
          created: DateTime.makeUnsafe(0),
          updated: DateTime.makeUnsafe(0),
        },
        location: { directory: AbsolutePath.make("/project") },
      });

      const resolved = yield* SessionRunnerModel.resolve(session, catalog);

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        store: false,
        reasoning_effort: "high",
      });
    }),
  );

  it.effect(
    "rejects an explicit unavailable Session variant during model resolution",
    () =>
      Effect.gen(function* () {
        const catalog = model(ProviderV2.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
        });
        const session = SessionV2.Info.make({
          id: SessionV2.ID.make("ses_model_variant_unavailable"),
          projectID: ProjectV2.ID.global,
          title: "test",
          model: {
            id: catalog.id,
            providerID: catalog.providerID,
            variant: ModelV2.VariantID.make("unknown"),
          },
          cost: Money.USD.zero,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          time: {
            created: DateTime.makeUnsafe(0),
            updated: DateTime.makeUnsafe(0),
          },
          location: { directory: AbsolutePath.make("/project") },
        });

        const failure = yield* SessionRunnerModel.resolve(
          session,
          catalog,
        ).pipe(Effect.flip);

        expect(failure).toMatchObject({
          _tag: "SessionRunnerModel.VariantUnavailableError",
          providerID: "test-provider",
          modelID: "test-model",
          variant: "unknown",
        });
        expect(failure.message).toBe(
          "Variant unavailable for test-provider/test-model: unknown",
        );
      }),
  );

  it.effect("overlays selected Anthropic Session variant settings", () =>
    Effect.gen(function* () {
      const catalog = model(ProviderV2.aisdk("@ai-sdk/anthropic"), {
        settings: { baseURL: "https://anthropic.example/v1" },
        variants: [
          {
            id: ModelV2.VariantID.make("high"),
            settings: { thinking: { type: "enabled", budgetTokens: 12000 } },
            headers: {},
            body: {},
          },
        ],
      });
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_anthropic_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: ModelV2.VariantID.make("high"),
        },
        cost: Money.USD.zero,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        time: {
          created: DateTime.makeUnsafe(0),
          updated: DateTime.makeUnsafe(0),
        },
        location: { directory: AbsolutePath.make("/project") },
      });

      const resolved = yield* SessionRunnerModel.resolve(session, catalog);

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
      });
      expect(resolved.route.defaults.providerOptions).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } },
      });
    }),
  );

  it.effect("maps catalog Anthropic AI SDK models into native routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model(ProviderV2.aisdk("@ai-sdk/anthropic"), {
          settings: { baseURL: "https://anthropic.example/v1" },
        }),
      );

      expect(resolved.route).toMatchObject({
        id: "anthropic-messages",
        providerMetadataKey: "anthropic",
        endpoint: { baseURL: "https://anthropic.example/v1" },
      });
    }),
  );

  it.effect(
    "loads Anthropic through AISDK when a Claude Code source is configured",
    () =>
      Effect.gen(function* () {
        const fallback = yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/openai"), {
            settings: { baseURL: "https://openai.example/v1" },
          }),
        );
        let runtime: ModelV2.Info | undefined;

        yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/anthropic"), {
            settings: {
              apiKey: "claude-code",
              claudeCodeSource: "file",
              baseURL: "https://api.anthropic.com/v1",
            },
          }),
          undefined,
          {
            loadAISDK: (input) => {
              runtime = input;
              return Effect.succeed(fallback);
            },
          },
        );

        expect(runtime?.settings).toMatchObject({
          apiKey: "claude-code",
          claudeCodeSource: "file",
        });
        expect(runtime?.settings).not.toHaveProperty("authToken");
      }),
  );

  it.effect("routes Anthropic API keys through native Messages auth", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model(ProviderV2.aisdk("@ai-sdk/anthropic"), {
          settings: { baseURL: "https://api.anthropic.com/v1" },
          headers: {},
          body: {},
        }),
        Credential.Key.make({ type: "key", key: "api-test" }),
      );
      const headers = yield* resolved.route.auth.apply({
        request: LLM.request({ model: resolved, prompt: "Hello" }),
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        body: "{}",
        headers: Headers.empty,
      });

      expect(resolved.route.id).toBe("anthropic-messages");
      expect(headers["x-api-key"]).toBe("api-test");
      expect(headers.authorization).toBeUndefined();
    }),
  );

  it.effect("does not route legacy Anthropic authToken settings as bearer auth", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model(ProviderV2.aisdk("@ai-sdk/anthropic"), {
          settings: {
            authToken: "legacy-bearer-token",
            baseURL: "https://api.anthropic.com/v1",
          },
        }),
      );

      expect(resolved.route.defaults.headers?.Authorization).toBeUndefined();
      expect(resolved.route.defaults.providerOptions).toBeUndefined();
    }),
  );

  it.effect(
    "maps a Claude Code source credential to the AI SDK marker without a bearer token",
    () =>
      Effect.gen(function* () {
        const fallback = yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/openai"), {
            settings: { baseURL: "https://openai.example/v1" },
          }),
        );
        let runtime: ModelV2.Info | undefined;

        yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/anthropic"), {
            settings: { baseURL: "https://api.anthropic.com/v1" },
            headers: { "Anthropic-Beta": "custom-feature" },
          }),
          Credential.OAuth.make({
            type: "oauth",
            methodID: claudeCodeMethodID,
            access: "keychain-source",
            refresh: "",
            expires: Number.MAX_SAFE_INTEGER,
            metadata: { authKind: "claude-code", source: "keychain-source" },
          }),
          {
            loadAISDK: (input) => {
              runtime = input;
              return Effect.succeed(fallback);
            },
          },
        );

        expect(runtime?.settings).toMatchObject({
          apiKey: "claude-code",
          claudeCodeSource: "keychain-source",
        });
        expect(runtime?.settings).not.toHaveProperty("authToken");
        expect(runtime?.headers?.["Anthropic-Beta"]).toBe("custom-feature");
      }),
  );

  it.effect(
    "keeps ANTHROPIC_API_KEY environment credentials on the native route",
    () =>
      Effect.gen(function* () {
        const resolved = yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/anthropic"), {
            settings: { baseURL: "https://api.anthropic.com/v1" },
            headers: {},
            body: {},
          }),
          Credential.Key.make({ type: "key", key: "env-api-test" }),
          undefined,
          { type: "env", name: "ANTHROPIC_API_KEY" },
        );

        expect(resolved.route.id).toBe("anthropic-messages");
      }),
  );

  it.effect("uses resolved credentials for bearer auth", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model(ProviderV2.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
          headers: {},
          body: {},
        }),
        Credential.Key.make({ type: "key", key: "secret" }),
      );
      const request = LLM.request({ model: resolved, prompt: "Hello" });
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      });

      expect(headers.authorization).toBe("Bearer secret");
    }),
  );

  it.effect("prefers stored credentials over configured auth", () =>
    Effect.gen(function* () {
      const credential = Credential.Key.make({
        type: "key",
        key: "stored-secret",
        metadata: { tenant: "work" },
      });
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model(ProviderV2.aisdk("@ai-sdk/openai"), {
          settings: {
            apiKey: "configured-secret",
            baseURL: "https://openai.example/v1",
          },
          headers: {},
          body: {},
        }),
        credential,
      );
      const headers = yield* resolved.route.auth.apply({
        request: LLM.request({ model: resolved, prompt: "Hello" }),
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      });

      expect(headers.authorization).toBe("Bearer stored-secret");
      expect(resolved.route.defaults.http?.body).toEqual({ tenant: "work" });
    }),
  );

  it.effect(
    "does not project OAuth account metadata into the request body",
    () =>
      Effect.gen(function* () {
        const resolved = yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/openai"), {
            settings: { baseURL: "https://openai.example/v1" },
            headers: {},
            body: {},
          }),
          Credential.OAuth.make({
            type: "oauth",
            methodID: Integration.MethodID.make("device"),
            access: "secret",
            refresh: "refresh",
            expires: Date.now() + 60_000,
            metadata: { server: "https://console.example", orgID: "org_123" },
          }),
        );

        expect(resolved.route.defaults.http?.body).toEqual({});
      }),
  );

  it.effect("routes ChatGPT OAuth credentials to the codex backend", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model(ProviderV2.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
          headers: {},
          body: {},
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "chatgpt-token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { accountID: "acct_123" },
        }),
      );
      const cache = SessionRunnerCache.providerOptions({
        projectID: "project",
        directory: "/repo",
        providerID: "test-provider",
        modelID: "test-model",
        apiModelID: resolved.id,
        variant: "default",
        policyRevision: CACHE_POLICY_REVISION,
        permissions: [],
        system: [],
        tools: [],
        sessionID: "ses_codex_affinity",
        routeID: resolved.route.id,
      });
      const request = LLM.request({
        model: resolved,
        prompt: "Hello",
        providerOptions: cache.providerOptions,
      });
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://chatgpt.com/backend-api/codex/responses",
        body: "{}",
        headers: Headers.empty,
      });

      expect(resolved.route).toMatchObject({
        id: "openai-codex-responses",
        endpoint: { baseURL: "https://chatgpt.com/backend-api/codex" },
        transport: { id: "websocket-json" },
        defaults: {
          headers: { "OpenAI-Beta": "responses_websockets=2026-02-06" },
          providerOptions: { openai: { store: false } },
        },
      });
      expect(headers.authorization).toBe("Bearer chatgpt-token");
      expect(headers["chatgpt-account-id"]).toBe("acct_123");
      expect(headers["session-id"]).toBe(cache.promptCacheKey);
      expect(headers["thread-id"]).toBe(cache.promptCacheKey);
      expect(headers["x-client-request-id"]).toBe(headers["thread-id"]);

      const otherCache = SessionRunnerCache.providerOptions({
        projectID: "project",
        directory: "/repo",
        providerID: "test-provider",
        modelID: "test-model",
        apiModelID: resolved.id,
        variant: "default",
        policyRevision: CACHE_POLICY_REVISION,
        permissions: [],
        system: [],
        tools: [],
        sessionID: "ses_codex_affinity_other",
        routeID: resolved.route.id,
      });
      const otherHeaders = yield* resolved.route.auth.apply({
        request: LLM.request({ model: resolved, prompt: "Hello", providerOptions: otherCache.providerOptions }),
        method: "POST",
        url: "https://chatgpt.com/backend-api/codex/responses",
        body: "{}",
        headers: Headers.empty,
      });
      expect(otherCache.promptCacheKey).toBe(cache.promptCacheKey);
      expect(otherHeaders["session-id"]).toBe(cache.promptCacheKey);
      expect(otherHeaders["thread-id"]).toBe(cache.promptCacheKey);
      expect(otherHeaders["x-client-request-id"]).toBe(cache.promptCacheKey);
    }),
  );

  it.effect("keeps GPT-5.6 Codex caching key-only", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model(ProviderV2.aisdk("@ai-sdk/openai"), { modelID: "gpt-5.6-luna" }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "chatgpt-token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        }),
      );
      const cache = SessionRunnerCache.providerOptions({
        projectID: "project",
        directory: "/repo",
        providerID: "openai",
        modelID: "gpt-5.6-luna",
        apiModelID: resolved.id,
        variant: "default",
        policyRevision: CACHE_POLICY_REVISION,
        permissions: [],
        system: [],
        tools: [],
        sessionID: "ses_codex_cache",
        routeID: resolved.route.id,
        openaiMode: "auto",
      });
      const prepared = yield* LLMClient.prepare<OpenAIResponsesBody>(
        LLM.request({
          model: resolved,
          system: "Stable system",
          messages: [Message.user("Hello"), Message.assistant("Cached assistant")],
          providerOptions: cache.providerOptions,
          cache: cache.cache,
        }),
      );

      expect(prepared.body).toMatchObject({ prompt_cache_key: cache.promptCacheKey });
      expect(prepared.body).not.toHaveProperty("prompt_cache_options");
      expect(prepared.body).not.toHaveProperty("prompt_cache_retention");
      expect(prepared.body.input[0]).toEqual({
        role: "system",
        content: "Stable system",
      });
      expect(prepared.body.input[1]).toEqual({
        role: "user",
        content: [{ type: "input_text", text: "Hello" }],
      });
      expect(prepared.body.input[2]).toEqual({
        role: "assistant",
        content: [{ type: "output_text", text: "Cached assistant" }],
      });
      expect(JSON.stringify(prepared.body)).not.toContain("prompt_cache_breakpoint");
    }),
  );

  it.effect("restores exact OpenAI cache identity and wire prefix after provider and model round trips", () =>
    Effect.gen(function* () {
      const catalogA = model(ProviderV2.aisdk("@ai-sdk/openai"), {
        id: "catalog-openai-a",
        providerID: "openai",
        modelID: "gpt-5.6",
      });
      const catalogB = model(ProviderV2.aisdk("@ai-sdk/openai"), {
        id: "catalog-openai-b",
        providerID: "openai",
        modelID: "gpt-5.6-mini",
      });
      const otherProvider = model(ProviderV2.aisdk("@ai-sdk/anthropic"), {
        id: "catalog-anthropic",
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
      });
      const messages = [Message.user("Stable request tail")];

      const firstA = yield* assembleCacheRequest(catalogA, messages, "ses_round_trip");
      const firstPrepared = yield* LLMClient.prepare<OpenAIResponsesBody>(firstA.request);
      const other = yield* assembleCacheRequest(otherProvider, messages, "ses_round_trip");
      yield* LLMClient.prepare(other.request);
      const secondA = yield* assembleCacheRequest(catalogA, messages, "ses_round_trip");
      const secondPrepared = yield* LLMClient.prepare<OpenAIResponsesBody>(secondA.request);

      expect(secondA.cache.promptCacheKey).toBe(firstA.cache.promptCacheKey);
      expect(secondA.cache.systemDigest).toBe(firstA.cache.systemDigest);
      expect(secondA.cache.toolDigest).toBe(firstA.cache.toolDigest);
      expect(JSON.stringify(secondPrepared.body)).toBe(JSON.stringify(firstPrepared.body));

      const firstB = yield* assembleCacheRequest(catalogB, messages, "ses_round_trip");
      yield* LLMClient.prepare<OpenAIResponsesBody>(firstB.request);
      const thirdA = yield* assembleCacheRequest(catalogA, messages, "ses_round_trip");
      const thirdPrepared = yield* LLMClient.prepare<OpenAIResponsesBody>(thirdA.request);

      expect(firstB.cache.promptCacheKey).not.toBe(firstA.cache.promptCacheKey);
      expect(thirdA.cache.promptCacheKey).toBe(firstA.cache.promptCacheKey);
      expect(thirdA.cache.systemDigest).toBe(firstA.cache.systemDigest);
      expect(thirdA.cache.toolDigest).toBe(firstA.cache.toolDigest);
      expect(JSON.stringify(thirdPrepared.body)).toBe(JSON.stringify(firstPrepared.body));
      expect(firstA.cache.promptCacheKey).toBe(
        SessionRunnerCache.promptCacheNamespace({
          ...firstA.namespaceInput,
          routeID: firstA.resolved.route.id,
        }),
      );
      expect(firstA.cache.promptCacheKey).not.toBe(
        SessionRunnerCache.promptCacheNamespace({
          ...firstA.namespaceInput,
          routeID: firstA.resolved.route.id,
          modelID: firstA.resolved.id,
        }),
      );
      expect(firstA.cache.cache).toEqual({
        tools: false,
        system: true,
        messages: { tail: 50 },
      });
    }),
  );

  it.effect("keeps parent cache identity stable across checkpoint history and isolates compaction", () =>
    Effect.gen(function* () {
      const catalog = model(ProviderV2.aisdk("@ai-sdk/openai"), {
        id: "catalog-openai-parent",
        providerID: "openai",
        modelID: "gpt-5.6",
      });
      const before = yield* assembleCacheRequest(
        catalog,
        [Message.user("History before compaction")],
        "ses_parent",
      );
      const checkpoint = Message.user("Exact checkpoint bytes");
      const after = yield* assembleCacheRequest(catalog, [checkpoint, Message.user("New tail")], "ses_parent");
      const repeated = yield* assembleCacheRequest(catalog, [checkpoint, Message.user("New tail")], "ses_parent");
      const hiddenCompaction = yield* assembleCacheRequest(
        catalog,
        [checkpoint],
        "ses_hidden_compaction",
        "compaction",
      );
      const beforePrepared = yield* LLMClient.prepare<OpenAIResponsesBody>(before.request);
      const afterPrepared = yield* LLMClient.prepare<OpenAIResponsesBody>(after.request);
      const repeatedPrepared = yield* LLMClient.prepare<OpenAIResponsesBody>(repeated.request);

      expect(after.cache.promptCacheKey).toBe(before.cache.promptCacheKey);
      expect(after.cache.systemDigest).toBe(before.cache.systemDigest);
      expect(after.cache.toolDigest).toBe(before.cache.toolDigest);
      expect(hiddenCompaction.cache.promptCacheKey).not.toBe(before.cache.promptCacheKey);
      expect(repeated.cache.promptCacheKey).toBe(after.cache.promptCacheKey);
      expect(repeated.cache.systemDigest).toBe(after.cache.systemDigest);
      expect(repeated.cache.toolDigest).toBe(after.cache.toolDigest);
      expect(
        JSON.stringify({ system: afterPrepared.body.input[0], tools: afterPrepared.body.tools }),
      ).toBe(JSON.stringify({ system: beforePrepared.body.input[0], tools: beforePrepared.body.tools }));
      expect(
        JSON.stringify({ prefix: repeatedPrepared.body.input.slice(0, 2), tools: repeatedPrepared.body.tools }),
      ).toBe(JSON.stringify({ prefix: afterPrepared.body.input.slice(0, 2), tools: afterPrepared.body.tools }));
    }),
  );

  it.effect(
    "routes native OpenAI provider packages with ChatGPT credentials to the codex backend",
    () =>
      Effect.gen(function* () {
        const resolved = yield* SessionRunnerModel.fromCatalogModel(
          model("@ycoding-ai/ai/providers/openai", {
            settings: { baseURL: "https://openai.example/v1" },
          }),
          Credential.OAuth.make({
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-browser"),
            access: "chatgpt-token",
            refresh: "refresh",
            expires: Date.now() + 60_000,
            metadata: { accountID: "acct_123" },
          }),
        );
        const headers = yield* resolved.route.auth.apply({
          request: LLM.request({ model: resolved, prompt: "Hello" }),
          method: "POST",
          url: "https://chatgpt.com/backend-api/codex/responses",
          body: "{}",
          headers: Headers.empty,
        });

        expect(resolved.route.endpoint.baseURL).toBe(
          "https://chatgpt.com/backend-api/codex",
        );
        expect(headers.authorization).toBe("Bearer chatgpt-token");
        expect(headers["chatgpt-account-id"]).toBe("acct_123");
      }),
  );

  it.effect(
    "does not route native OpenAI-compatible packages to the codex backend",
    () =>
      Effect.gen(function* () {
        const resolved = yield* SessionRunnerModel.fromCatalogModel(
          model("@ycoding-ai/ai/providers/openai-compatible", {
            settings: { baseURL: "https://compatible.example/v1" },
          }),
          Credential.OAuth.make({
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-browser"),
            access: "chatgpt-token",
            refresh: "refresh",
            expires: Date.now() + 60_000,
            metadata: { accountID: "acct_123" },
          }),
        );

        expect(resolved.route.id).toBe("openai-compatible-chat");
        expect(resolved.route.endpoint.baseURL).toBe(
          "https://compatible.example/v1",
        );
      }),
  );

  it.effect(
    "maps legacy OpenAI organization and project settings to headers",
    () =>
      Effect.gen(function* () {
        const resolved = yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/openai"), {
            settings: { organization: "org_123", project: "proj_123" },
          }),
        );

        expect(resolved.route.defaults.headers).toMatchObject({
          "OpenAI-Organization": "org_123",
          "OpenAI-Project": "proj_123",
        });
      }),
  );

  it.effect(
    "routes ChatGPT OAuth credentials without an account id to the codex backend",
    () =>
      Effect.gen(function* () {
        const resolved = yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/openai"), {
            settings: { baseURL: "https://openai.example/v1" },
            headers: {},
            body: {},
          }),
          Credential.OAuth.make({
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-headless"),
            access: "chatgpt-token",
            refresh: "refresh",
            expires: Date.now() + 60_000,
          }),
        );
        const request = LLM.request({ model: resolved, prompt: "Hello" });
        const headers = yield* resolved.route.auth.apply({
          request,
          method: "POST",
          url: "https://chatgpt.com/backend-api/codex/responses",
          body: "{}",
          headers: Headers.empty,
        });

        expect(resolved.route.endpoint.baseURL).toBe(
          "https://chatgpt.com/backend-api/codex",
        );
        expect(headers.authorization).toBe("Bearer chatgpt-token");
        expect(headers["chatgpt-account-id"]).toBeUndefined();
      }),
  );

  it.effect(
    "keeps non-ChatGPT OAuth credentials on the configured endpoint",
    () =>
      Effect.gen(function* () {
        const resolved = yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/openai"), {
            settings: { baseURL: "https://openai.example/v1" },
            headers: {},
            body: {},
          }),
          Credential.OAuth.make({
            type: "oauth",
            methodID: Integration.MethodID.make("device"),
            access: "oauth-token",
            refresh: "refresh",
            expires: Date.now() + 60_000,
            metadata: { accountID: "acct_123" },
          }),
        );
        const request = LLM.request({ model: resolved, prompt: "Hello" });
        const headers = yield* resolved.route.auth.apply({
          request,
          method: "POST",
          url: "https://openai.example/v1/responses",
          body: "{}",
          headers: Headers.empty,
        });

        expect(resolved.route.endpoint.baseURL).toBe(
          "https://openai.example/v1",
        );
        expect(headers.authorization).toBe("Bearer oauth-token");
        expect(headers["chatgpt-account-id"]).toBeUndefined();
      }),
  );

  it.effect(
    "loads dynamic native provider packages through the injected package loader",
    () =>
      Effect.gen(function* () {
        const native = yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/openai"), {
            settings: { baseURL: "https://openai.example/v1" },
          }),
        );
        const resolved = yield* SessionRunnerModel.fromCatalogModel(
          model("@ycoding-ai/ai/providers/custom", {
            settings: { region: "test" },
            headers: { "x-package": "header" },
            body: { custom: true },
          }),
          undefined,
          {
            loadPackage: (specifier) => {
              expect(specifier).toBe("@ycoding-ai/ai/providers/custom");
              return Effect.succeed({
                model: (modelID, settings) => {
                  expect(modelID).toBe("api-test-model");
                  expect(settings).toEqual({
                    region: "test",
                    headers: { "x-package": "header" },
                    body: { custom: true },
                    limits: { context: 100, output: 20 },
                  });
                  return Model.make({
                    id: modelID,
                    provider: "package-provider",
                    route: native.route,
                  });
                },
              });
            },
          },
        );

        expect(resolved).toMatchObject({
          id: "api-test-model",
          provider: "test-provider",
        });
      }),
  );

  it.effect("maps OAuth credentials to native provider auth settings", () =>
    Effect.gen(function* () {
      const native = yield* SessionRunnerModel.fromCatalogModel(
        model(ProviderV2.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
        }),
      );
      const credential = Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("device"),
        access: "oauth-token",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      });
      const packages = [
        ["@ycoding-ai/ai/providers/google-vertex", "accessToken"],
        ["@ycoding-ai/ai/providers/google-vertex/gemini", "accessToken"],
        ["@ycoding-ai/ai/providers/google-vertex/chat", "accessToken"],
        ["@ycoding-ai/ai/providers/google-vertex/responses", "accessToken"],
        ["@ycoding-ai/ai/providers/google-vertex/messages", "accessToken"],
      ] as const;

      yield* Effect.forEach(packages, ([specifier, key]) =>
        SessionRunnerModel.fromCatalogModel(
          model(specifier, { settings: { apiKey: "configured-key" } }),
          credential,
          {
            loadPackage: () =>
              Effect.succeed({
                model: (modelID, settings) => {
                  expect(settings).toMatchObject({ [key]: "oauth-token" });
                  expect(settings).not.toHaveProperty("apiKey");
                  return Model.make({
                    id: modelID,
                    provider: "package-provider",
                    route: native.route,
                  });
                },
              }),
          },
        ),
      );
    }),
  );

  it.effect(
    "does not map generic OAuth credentials onto native Anthropic bearer settings",
    () =>
      Effect.gen(function* () {
        const fallback = yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/openai"), {
            settings: { baseURL: "https://openai.example/v1" },
          }),
        );
        let captured:
          | Parameters<ProviderV2.ProviderPackage["model"]>[1]
          | undefined;

        yield* SessionRunnerModel.fromCatalogModel(
          model("@ycoding-ai/ai/providers/anthropic", {
            settings: { apiKey: "configured-key" },
            headers: { "anthropic-beta": "custom-feature" },
          }),
          Credential.OAuth.make({
            type: "oauth",
            methodID: Integration.MethodID.make("other-oauth"),
            access: "oauth-token",
            refresh: "refresh",
            expires: Number.MAX_SAFE_INTEGER,
          }),
          {
            loadPackage: () =>
              Effect.succeed({
                model: (modelID, settings) => {
                  captured = settings;
                  return Model.make({
                    id: modelID,
                    provider: "package-provider",
                    route: fallback.route,
                  });
                },
              }),
          },
        );

        expect(captured).not.toHaveProperty("apiKey");
        expect(captured).not.toHaveProperty("authToken");
        expect(captured?.headers?.["anthropic-beta"]).toBe("custom-feature");
      }),
  );

  it.effect("maps API key credentials onto native Anthropic packages", () =>
    Effect.gen(function* () {
      const fallback = yield* SessionRunnerModel.fromCatalogModel(
        model(ProviderV2.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
        }),
      );
      let captured:
        | Parameters<ProviderV2.ProviderPackage["model"]>[1]
        | undefined;

      yield* SessionRunnerModel.fromCatalogModel(
        model("@ycoding-ai/ai/providers/anthropic", { headers: {} }),
        Credential.Key.make({ type: "key", key: "token" }),
        {
          loadPackage: () =>
            Effect.succeed({
              model: (modelID, settings) => {
                captured = settings;
                return Model.make({
                  id: modelID,
                  provider: "package-provider",
                  route: fallback.route,
                });
              },
            }),
        },
        { type: "env", name: "ANTHROPIC_API_KEY" },
      );

      expect(captured).toMatchObject({ apiKey: "token" });
      expect(captured).not.toHaveProperty("authToken");
    }),
  );

  it.effect(
    "loads arbitrary AISDK packages through the injected AISDK loader",
    () =>
      Effect.gen(function* () {
        const native = yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/openai"), {
            settings: { baseURL: "https://openai.example/v1" },
          }),
        );
        const resolved = yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/google"), {
            modelID: "gemini-api-model",
            settings: { project: "test" },
            headers: { "x-aisdk": "header" },
            body: { custom: true },
          }),
          Credential.Key.make({ type: "key", key: "fallback-secret" }),
          {
            loadAISDK: (runtime) =>
              Effect.sync(() => {
                expect(runtime).toMatchObject({
                  id: "test-model",
                  modelID: "gemini-api-model",
                  providerID: "test-provider",
                  package: ProviderV2.aisdk("@ai-sdk/google"),
                  settings: { project: "test", apiKey: "fallback-secret" },
                  headers: { "x-aisdk": "header" },
                  body: { custom: true },
                });
                return Model.make({
                  id: runtime.modelID ?? runtime.id,
                  provider: runtime.providerID,
                  route: native.route,
                });
              }),
          },
        );

        expect(resolved).toMatchObject({
          id: "gemini-api-model",
          provider: "test-provider",
        });
    }),
  );

  it.effect(
    "loads GitHub Copilot Anthropic Messages models through the AISDK loader",
    () =>
      Effect.gen(function* () {
        const fallback = yield* SessionRunnerModel.fromCatalogModel(
          model(ProviderV2.aisdk("@ai-sdk/openai"), {
            settings: { baseURL: "https://openai.example/v1" },
          }),
        );
        let runtime: ModelV2.Info | undefined;
        const catalog = ModelV2.Info.make({
          ...model(ProviderV2.aisdk("@ai-sdk/anthropic"), {
            modelID: "claude-sonnet-5",
            settings: { baseURL: "https://copilot.example/v1" },
          }),
          providerID: ProviderV2.ID.githubCopilot,
        });

        const resolved = yield* SessionRunnerModel.fromCatalogModel(
          catalog,
          Credential.OAuth.make({
            type: "oauth",
            methodID: Integration.MethodID.make("device"),
            access: "copilot-oauth-token",
            refresh: "copilot-oauth-token",
            expires: Number.MAX_SAFE_INTEGER,
          }),
          {
            loadAISDK: (input) =>
              Effect.sync(() => {
                runtime = input;
                return fallback;
              }),
          },
        );

        expect(runtime).toMatchObject({
          providerID: "github-copilot",
          modelID: "claude-sonnet-5",
          package: "aisdk:@ai-sdk/anthropic",
          settings: {
            baseURL: "https://copilot.example/v1",
            apiKey: "copilot-oauth-token",
          },
        });
        expect(resolved).toBe(fallback);
      }),
  );

  it.effect("rejects AISDK packages without an available loader", () =>
    Effect.gen(function* () {
      const failure = yield* SessionRunnerModel.fromCatalogModel(
        model(ProviderV2.aisdk("@ai-sdk/google"), {
          settings: { baseURL: "https://google.example/v1" },
        }),
      ).pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.UnsupportedPackageError",
        providerID: "test-provider",
        modelID: "test-model",
        package: "aisdk:@ai-sdk/google",
      });
      expect(failure.message).toBe(
        "Unsupported package for test-provider/test-model: aisdk:@ai-sdk/google",
      );
    }),
  );

  it.effect("drops an empty API key before loading an AISDK package", () =>
    Effect.gen(function* () {
      const native = yield* SessionRunnerModel.fromCatalogModel(
        model(ProviderV2.aisdk("@ai-sdk/openai"), {
          settings: { baseURL: "https://openai.example/v1" },
        }),
      );
      yield* SessionRunnerModel.fromCatalogModel(
        model(ProviderV2.aisdk("@ai-sdk/google"), {
          settings: { apiKey: "", baseURL: "https://google.example/v1" },
        }),
        undefined,
        {
          loadAISDK: (runtime) =>
            Effect.sync(() => {
              expect(runtime.settings).not.toHaveProperty("apiKey");
              return native;
            }),
        },
      );
    }),
  );

  it.effect("reports whether a catalog model declares a provider package", () =>
    Effect.sync(() => {
      expect(
        SessionRunnerModel.supported(model(ProviderV2.aisdk("@ai-sdk/openai"))),
      ).toBe(true);
      expect(
        SessionRunnerModel.supported(model("@ycoding-ai/ai/providers/custom")),
      ).toBe(true);
      expect(SessionRunnerModel.supported(model(undefined))).toBe(false);
    }),
  );
});
