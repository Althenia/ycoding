import { describe, expect } from "bun:test";
import { LLMClient, LLMEvent, LLMResponse, Model } from "@ycoding-ai/ai";
import { OpenAIChat } from "@ycoding-ai/ai/protocols";
import { AISDK } from "@ycoding-ai/core/aisdk";
import { Catalog } from "@ycoding-ai/core/catalog";
import { Credential } from "@ycoding-ai/core/credential";
import { Generate } from "@ycoding-ai/core/generate";
import { Integration } from "@ycoding-ai/core/integration";
import { IntegrationConnection } from "@ycoding-ai/core/integration/connection";
import { ModelV2 } from "@ycoding-ai/core/model";
import { Npm } from "@ycoding-ai/core/npm";
import { claudeCodeMethodID } from "@ycoding-ai/core/plugin/provider/anthropic";
import { ProviderV2 } from "@ycoding-ai/core/provider";
import { Effect, Layer } from "effect";
import { it } from "./lib/effect";

const anthropic = ModelV2.Info.make({
  id: ModelV2.ID.make("claude-sonnet-4-5"),
  modelID: ModelV2.ID.make("claude-sonnet-4-5-20250929"),
  providerID: ProviderV2.ID.make("anthropic"),
  name: "Claude Sonnet 4.5",
  package: ProviderV2.aisdk("@ai-sdk/anthropic"),
  settings: { baseURL: "https://api.anthropic.com/v1" },
  headers: {},
  body: {},
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 200_000, output: 64_000 },
});

const loaded = Model.make({
  id: "loaded-anthropic",
  provider: "anthropic",
  route: OpenAIChat.route,
});

const response = (text: string) => {
  const value = LLMResponse.fromEvents([
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "generate" }),
    LLMEvent.textDelta({ id: "generate", text }),
    LLMEvent.textEnd({ id: "generate" }),
    LLMEvent.stepFinish({
      index: 0,
      reason: "stop",
      usage: { inputTokens: 10, outputTokens: 1 },
    }),
    LLMEvent.finish({ reason: "stop" }),
  ]);
  if (!value) throw new Error("Incomplete generate response");
  return value;
};

const claudeCodeCredential = Credential.OAuth.make({
  type: "oauth",
  methodID: claudeCodeMethodID,
  access: "file",
  refresh: "",
  expires: Number.MAX_SAFE_INTEGER,
  metadata: { authKind: "claude-code", source: "file" },
});

/** Builds Generate over mocked catalog, integration, model loading, and LLM dependencies. */
const generate = (input: {
  readonly connection: IntegrationConnection.Info;
  readonly credential: Credential.Value;
  readonly onLoad: (model: ModelV2.Info) => void;
  readonly onGenerate: (model: Model) => void;
}) =>
  Generate.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Catalog.Service, {
          provider: {
            get: () => Effect.succeed(undefined),
            all: () => Effect.die("unused"),
            available: () => Effect.die("unused"),
          },
          model: {
            get: () => Effect.die("unused"),
            all: () => Effect.die("unused"),
            available: () => Effect.die("unused"),
            default: () => Effect.succeed(anthropic),
            small: () => Effect.die("unused"),
          },
        }),
        Layer.mock(Integration.Service, {
          connection: {
            active: () => Effect.succeed(input.connection),
            resolve: () => Effect.succeed(input.credential),
            key: () => Effect.die("unused"),
            update: () => Effect.die("unused"),
            remove: () => Effect.die("unused"),
          },
          oauth: {
            connect: () => Effect.die("unused"),
            status: () => Effect.die("unused"),
            complete: () => Effect.die("unused"),
            cancel: () => Effect.die("unused"),
          },
          command: {
            connect: () => Effect.die("unused"),
            status: () => Effect.die("unused"),
            cancel: () => Effect.die("unused"),
          },
        }),
        Layer.mock(AISDK.Service, {
          hook: {
            sdk: () => Effect.die("unused"),
            language: () => Effect.die("unused"),
          },
          model: (model) =>
            Effect.sync(() => {
              input.onLoad(model);
              return loaded;
            }),
        }),
        Layer.mock(Npm.Service, {
          add: () => Effect.die("unused"),
          install: () => Effect.die("unused"),
          which: () => Effect.die("unused"),
        }),
        Layer.mock(LLMClient.Service, {
          generate: (request) =>
            Effect.sync(() => {
              input.onGenerate(request.model);
              return response("Generated");
            }),
        }),
      ),
    ),
  );

describe("Generate", () => {
  it.effect(
    "generates through the AI SDK adapter for a Claude Code credential source",
    () =>
      Effect.gen(function* () {
        let runtime: ModelV2.Info | undefined;
        let requested: Model | undefined;

        const text = yield* Generate.Service.use((service) =>
          service.text({ prompt: "Hello" }),
        ).pipe(
          Effect.provide(
            generate({
              connection: {
                type: "credential",
                id: Credential.ID.make("anthropic-claude-code"),
                label: "Claude",
              },
              credential: claudeCodeCredential,
              onLoad: (model) => (runtime = model),
              onGenerate: (model) => (requested = model),
            }),
          ),
        );

        expect(text).toBe("Generated");
        expect(requested).toBe(loaded);
        expect(runtime?.settings).toMatchObject({
          apiKey: "claude-code",
          claudeCodeSource: "file",
        });
        expect(runtime?.settings).not.toHaveProperty("authToken");
      }),
  );
});
