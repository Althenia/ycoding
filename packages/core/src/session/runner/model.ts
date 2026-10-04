export * as SessionRunnerModel from "./model";

import { makeLocationNode } from "../../effect/app-node";
import { LLMRequest, Model } from "@ycoding-ai/ai";
// ast-grep-ignore: no-star-import
import * as AnthropicMessages from "@ycoding-ai/ai/protocols/anthropic-messages";
// ast-grep-ignore: no-star-import
import * as OpenAICompatibleChat from "@ycoding-ai/ai/protocols/openai-compatible-chat"
// ast-grep-ignore: no-star-import
import * as OpenAICompatibleResponses from "@ycoding-ai/ai/protocols/openai-compatible-responses";
// ast-grep-ignore: no-star-import
import * as OpenAIResponses from "@ycoding-ai/ai/protocols/openai-responses";
import { Auth, Framing, HttpTransport, type AnyRoute } from "@ycoding-ai/ai/route";
import { Context, Effect, Layer, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import { produce } from "immer";
import { AISDK } from "../../aisdk";
import { Catalog } from "../../catalog";
import { Credential } from "../../credential";
import { Integration } from "../../integration";
import { IntegrationConnection } from "../../integration/connection";
import { CatalogModel } from "../../model";
import { Npm } from "../../npm";
import {
  claudeCodeCredentialSource,
  claudeCodeSentinel,
  claudeCodeSourceSetting,
} from "../../plugin/provider/anthropic";
import { OpenAICodex } from "../../plugin/provider/openai-codex";
import { Provider } from "../../provider";
import { SessionSchema } from "../schema";
import { createHash } from "node:crypto";

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`;
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: Provider.ID,
    modelID: CatalogModel.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`;
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: Provider.ID,
    modelID: CatalogModel.ID,
    variant: CatalogModel.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`;
  }
}

export class UnsupportedPackageError extends Schema.TaggedErrorClass<UnsupportedPackageError>()(
  "SessionRunnerModel.UnsupportedPackageError",
  {
    providerID: Provider.ID,
    modelID: CatalogModel.ID,
    package: Schema.String,
  },
) {
  override get message() {
    return `Unsupported package for ${this.providerID}/${this.modelID}: ${this.package}`;
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedPackageError
  | Integration.AuthorizationError;

export interface Resolved {
  /** Route-level model for provider requests; its id is the provider API model id, which may differ from the catalog id. */
  readonly model: Model;
  /** Selected catalog identity. Durable records and displays must use this, never the API model id. */
  readonly ref: CatalogModel.Ref;
  /** Catalog pricing in dollars per million tokens. */
  readonly cost: CatalogModel.Info["cost"];
  /** Digest of the exact non-secret provider connection and catalog identity. */
  readonly connectionIdentityDigest: string;
}

export interface Interface {
  readonly resolve: (
    session: SessionSchema.Info,
  ) => Effect.Effect<Resolved, Error>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@ycoding/SessionRunnerModel",
) {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) =>
  Layer.succeed(Service, Service.of({ resolve }));

/** Builds a Resolved whose catalog identity mirrors the route model. Test or embedding seam. */
export const resolved = (
  model: Model,
  variant?: CatalogModel.VariantID,
  cost: CatalogModel.Info["cost"] = [],
): Resolved => ({
  model,
  ref: CatalogModel.Ref.make({
    id: CatalogModel.ID.make(model.id),
    providerID: Provider.ID.make(model.provider),
    ...(variant === undefined ? {} : { variant }),
  }),
  cost,
  connectionIdentityDigest: digest({ provider: model.provider, model: model.id, route: model.route.id }),
});

const apiKey = (model: CatalogModel.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key);
  if (credential?.type === "oauth") return Auth.value(credential.access);
  const value = model.settings?.apiKey;
  if (typeof value === "string") return Auth.value(value);
  return undefined;
};

const withDefaults = (model: CatalogModel.Info, route: AnyRoute) =>
  route.with({
    provider: model.providerID,
    endpoint:
      typeof model.settings?.baseURL === "string"
        ? { baseURL: model.settings.baseURL }
        : undefined,
    headers: providerHeaders(model),
    providerOptions: providerOptions(model),
    http: model.body === undefined ? undefined : { body: model.body },
    limits: { context: model.limit.context, output: model.limit.output },
  });

const providerHeaders = (model: CatalogModel.Info) => {
  const packageName = Provider.packageName(model.package);
  const generated = new Map<string, string>();
  if (
    packageName === "@ai-sdk/openai" &&
    typeof model.settings?.organization === "string"
  )
    generated.set("OpenAI-Organization", model.settings.organization);
  if (
    packageName === "@ai-sdk/openai" &&
    typeof model.settings?.project === "string"
  )
    generated.set("OpenAI-Project", model.settings.project);
  return Provider.mergeHeaders(
    generated.size === 0 ? undefined : Object.fromEntries(generated),
    model.headers,
  );
};

const providerOptions = (
  model: CatalogModel.Info,
):
  | { readonly [key: string]: { readonly [key: string]: unknown } }
  | undefined => {
  if (!Provider.isAISDK(model.package) || model.settings === undefined)
    return undefined;
  const {
    apiKey: _,
    authToken: _authToken,
    baseURL: _baseURL,
    [claudeCodeSourceSetting]: _claudeCodeSource,
    ...settings
  } = model.settings;
  if (Object.keys(settings).length === 0) return undefined;
  const packageName = Provider.packageName(model.package);
  if (packageName === "@ai-sdk/openai") return { openai: settings };
  if (packageName === "@ai-sdk/anthropic") return { anthropic: settings };
  if (packageName === "@ai-sdk/openai-compatible") return { openai: settings };
  return undefined;
};

export const withVariant = (
  model: CatalogModel.Info,
  variantID: CatalogModel.VariantID | undefined,
): Effect.Effect<CatalogModel.Info, VariantUnavailableError> => {
  const variant = model.variants?.find((item) => item.id === variantID);
  if (!variant && variantID !== undefined)
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    );
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          draft.settings = Provider.mergeOverlay(
            draft.settings,
            variant.settings,
          );
          draft.headers = Provider.mergeHeaders(
            draft.headers,
            variant.headers,
          );
          draft.body = Provider.mergeOverlay(draft.body, variant.body);
        })
      : model,
  );
};

export interface Dependencies {
  readonly loadPackage?: (
    specifier: string,
  ) => Effect.Effect<Provider.ProviderPackage, Provider.LoadError>;
  readonly loadAISDK?: (
    model: CatalogModel.Info,
  ) => Effect.Effect<Model, AISDK.InitError>;
}

export const fromCatalogModel = (
  model: CatalogModel.Info,
  credential?: Credential.Value,
  dependencies: Dependencies = {},
  _connection?: IntegrationConnection.Info,
): Effect.Effect<Model, UnsupportedPackageError> => {
  const packageName = Provider.packageName(model.package);
  const configuredSource =
    model.settings?.apiKey === claudeCodeSentinel &&
    typeof model.settings?.[claudeCodeSourceSetting] === "string"
      ? model.settings[claudeCodeSourceSetting]
      : undefined;
  const source =
    packageName === "@ai-sdk/anthropic" && credential?.type !== "key"
      ? (claudeCodeCredentialSource(credential) ?? configuredSource)
      : undefined;
  const resolved = produce(model, (draft) => {
    if (draft.settings?.apiKey === "") delete draft.settings.apiKey;
    if (credential?.type === "key" && credential.metadata !== undefined)
      draft.body = Provider.mergeOverlay(draft.body, credential.metadata);
    if (source)
      draft.settings = Provider.mergeOverlay(draft.settings, {
        apiKey: claudeCodeSentinel,
        [claudeCodeSourceSetting]: source,
      });
  });
  const key = source ? undefined : apiKey(resolved, credential);
  const copilotAnthropic =
    packageName === "@ai-sdk/anthropic" &&
    resolved.providerID === Provider.ID.githubCopilot;
  if (
    packageName === "@ai-sdk/anthropic" &&
    credential?.type === "oauth" &&
    !source &&
    !copilotAnthropic
  )
    return Effect.fail(unsupported(resolved));

  if (
    OpenAICodex.isChatGPT(credential) &&
    !Provider.isAISDK(resolved.package) &&
    isNativeOpenAI(resolved.package)
  ) {
    return Effect.succeed(codexModel(resolved, credential, key));
  }

  if (
    Provider.isAISDK(resolved.package) &&
    packageName === "@ai-sdk/openai"
  ) {
    if (OpenAICodex.isChatGPT(credential))
      return Effect.succeed(codexModel(resolved, credential, key));
    return Effect.succeed(
      withDefaults(resolved, OpenAIResponses.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.modelID ?? resolved.id }),
    );
  }
  if (
    Provider.isAISDK(resolved.package) &&
    packageName === "@ai-sdk/anthropic" &&
    !source &&
    !copilotAnthropic
  ) {
    return Effect.succeed(
      withDefaults(resolved, AnthropicMessages.route)
        .with({
          auth: key === undefined ? Auth.none : Auth.header("x-api-key", key),
        })
        .model({ id: resolved.modelID ?? resolved.id }),
    );
  }
  if (
    Provider.isAISDK(resolved.package) &&
    packageName === "@ai-sdk/anthropic" &&
    source
  ) {
    if (!dependencies.loadAISDK) return Effect.fail(unsupported(resolved));
    const runtime = produce(resolved, (draft) => {
      if (draft.settings) delete draft.settings.authToken;
      draft.settings = Provider.mergeOverlay(draft.settings, {
        apiKey: claudeCodeSentinel,
        [claudeCodeSourceSetting]: source,
      });
    });
    return dependencies
      .loadAISDK(runtime)
      .pipe(Effect.mapError(() => unsupported(resolved)));
  }
  if (
    Provider.isAISDK(resolved.package) &&
    packageName === "@ai-sdk/openai-compatible" &&
    typeof resolved.settings?.baseURL === "string"
  ) {
    const api = resolved.api ?? resolved.settings?.api
    const route =
      api === "responses"
        ? OpenAICompatibleResponses.route
        : OpenAICompatibleChat.route
    return Effect.succeed(
      withDefaults(resolved, route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.modelID ?? resolved.id }),
    );
  }
  if (Provider.isAISDK(resolved.package)) {
    if (!dependencies.loadAISDK) return Effect.fail(unsupported(resolved));
    const runtime = produce(resolved, (draft) => {
      draft.settings = Provider.mergeOverlay(draft.settings, {
        ...(credential?.type === "key" ? { apiKey: credential.key } : {}),
        ...(credential?.type === "oauth" ? { apiKey: credential.access } : {}),
        ...credential?.metadata,
      });
    });
    return dependencies
      .loadAISDK(runtime)
      .pipe(Effect.mapError(() => unsupported(resolved)));
  }
  if (!resolved.package) return Effect.fail(unsupported(resolved));

  const specifier = resolved.package;
  return Effect.gen(function* () {
    const module = yield* (dependencies.loadPackage ?? Provider.loadPackage)(
      specifier,
    ).pipe(Effect.mapError(() => unsupported(resolved)));
    const configured = { ...resolved.settings, ...credential?.metadata };
    const settings = {
      ...(credential ? withoutNativeAuthSettings(configured) : configured),
      ...nativeCredentialSettings(specifier, credential),
      headers: resolved.headers,
      body: resolved.body,
      limits: {
        context: resolved.limit.context,
        output: resolved.limit.output,
      },
    };
    return yield* Effect.try({
      try: () =>
        Model.update(module.model(resolved.modelID ?? resolved.id, settings), {
          provider: resolved.providerID,
        }),
      catch: () => unsupported(resolved),
    });
  });
};

const codexTurnStates = new Map<string, string>();
const CODEX_TURN_STATE_LIMIT = 512;
const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";

const codexTurnStateKey = (messages: ReadonlyArray<unknown>, cacheKey: string | undefined, account: string | undefined) => {
  if (!cacheKey) return undefined;
  const userMessage = messages.filter((message) => isRecord(message) && message.role === "user" && typeof message.id === "string").at(-1);
  if (!isRecord(userMessage) || typeof userMessage.id !== "string") return undefined;
  return JSON.stringify([cacheKey, userMessage.id, account]);
};

const promptCacheKey = (providerOptions: unknown) => {
  const openai = isRecord(providerOptions) && isRecord(providerOptions.openai) ? providerOptions.openai : undefined;
  return typeof openai?.promptCacheKey === "string" ? openai.promptCacheKey : undefined;
};

const rememberCodexTurnState = (request: LLMRequest, headers: Headers.Headers, account: string | undefined) => {
  const key = codexTurnStateKey(request.messages, promptCacheKey(request.providerOptions), account);
  const token = headers[CODEX_TURN_STATE_HEADER];
  if (key === undefined || !token || token.length > 4096 || codexTurnStates.has(key)) return;
  if (codexTurnStates.size >= CODEX_TURN_STATE_LIMIT) {
    const oldest = codexTurnStates.keys().next().value;
    if (oldest !== undefined) codexTurnStates.delete(oldest);
  }
  codexTurnStates.set(key, token);
};

const isNativeOpenAI = (packageName: string | undefined) =>
  packageName === "@ycoding-ai/ai/providers/openai" ||
  packageName?.startsWith("@ycoding-ai/ai/providers/openai/") === true;

const isNativeAnthropic = (packageName: string | undefined) =>
  packageName === "@ycoding-ai/ai/providers/anthropic" ||
  packageName === "@ycoding-ai/ai/providers/anthropic-compatible";

const nativeCredentialSettings = (
  specifier: string,
  credential: Credential.Value | undefined,
) => {
  if (!credential) return {};
  if (credential.type === "key") return { apiKey: credential.key };
  if (isNativeAnthropic(specifier)) return {};
  if (
    specifier === "@ycoding-ai/ai/providers/google-vertex" ||
    specifier.startsWith("@ycoding-ai/ai/providers/google-vertex/")
  )
    return { accessToken: credential.access };
  return { apiKey: credential.access };
};

const withoutNativeAuthSettings = (settings: Record<string, unknown>) => {
  const {
    accessToken: _accessToken,
    apiKey: _apiKey,
    authToken: _authToken,
    ...rest
  } = settings;
  return rest;
};

const codexModel = (
  model: CatalogModel.Info,
  credential: Credential.Value | undefined,
  key: ReturnType<typeof Auth.value> | undefined,
) => {
  const account = OpenAICodex.accountID(credential);
  const webSocket = model.settings?.transport === "websocket";
  const transport = webSocket
    ? undefined
    : HttpTransport.httpJson({ framing: Framing.sse }).with({
        onResponseHeaders: ({ request, headers }) =>
          Effect.sync(() => rememberCodexTurnState(request, headers, account)),
      });
  return withDefaults(model, webSocket ? OpenAIResponses.webSocketRoute : OpenAIResponses.route)
    .with({
      id: webSocket ? OpenAICodex.webSocketRouteID : OpenAICodex.routeID,
      endpoint: { baseURL: OpenAICodex.baseURL },
      ...(transport === undefined ? {} : { transport }),
      ...(webSocket ? { headers: { "OpenAI-Beta": "responses_websockets=2026-02-06" } } : {}),
      auth: (key === undefined ? Auth.none : Auth.bearer(key)).andThen(
        account === undefined
          ? Auth.none
          : Auth.headers({ "chatgpt-account-id": account }),
      ).andThen(codexAffinityAuth(account, !webSocket)),
    })
    .model({ id: model.modelID ?? model.id });
};

const codexAffinityAuth = (account: string | undefined, includeTurnState: boolean) => Auth.custom((input) => {
  if (!("providerOptions" in input.request) || !("messages" in input.request) || !Array.isArray(input.request.messages))
    return Effect.succeed(input.headers);
  const cacheKey = promptCacheKey(input.request.providerOptions);
  if (cacheKey === undefined) return Effect.succeed(input.headers);
  const headers = Headers.setAll(input.headers, {
    "session-id": cacheKey,
    "thread-id": cacheKey,
    "x-client-request-id": cacheKey,
  });
  const turnStateKey = includeTurnState ? codexTurnStateKey(input.request.messages, cacheKey, account) : undefined;
  const token = turnStateKey === undefined ? undefined : codexTurnStates.get(turnStateKey);
  return Effect.succeed(token === undefined ? headers : Headers.set(headers, CODEX_TURN_STATE_HEADER, token));
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const unsupported = (model: CatalogModel.Info) =>
  new UnsupportedPackageError({
    providerID: model.providerID,
    modelID: model.id,
    package: model.package ?? "unknown",
  });

export const resolve = (
  session: SessionSchema.Info,
  model: CatalogModel.Info,
  credential?: Credential.Value,
  dependencies?: Dependencies,
  connection?: IntegrationConnection.Info,
) =>
  withVariant(model, session.model?.variant).pipe(
    Effect.flatMap((model) =>
      fromCatalogModel(model, credential, dependencies, connection).pipe(
        Effect.map((resolved) => {
          const daybreak = session.daybreak;
          if (
            daybreak === undefined ||
            model.providerID !== Provider.ID.openai ||
            !OpenAICodex.isChatGPT(credential) ||
            !model.daybreak?.includes(daybreak) ||
            !OpenAICodex.isRoute(resolved.route.id)
          ) return resolved;
          return Model.update(resolved, {
            route: resolved.route.with({ http: { body: { access_programs: { cyber: daybreak } } } }),
          });
        }),
      ),
    ),
  );

export const supported = (model: CatalogModel.Info) => Boolean(model.package);

/** Resolves models from the catalog belonging to the current Location runtime. */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service;
    const integrations = yield* Integration.Service;
    const credentials = yield* Credential.Service;
    const npm = yield* Npm.Service;
    const aisdk = yield* AISDK.Service;
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        const defaultModel = session.model
          ? undefined
          : yield* catalog.model.default();
        const selected = session.model
          ? (yield* catalog.model.available()).find(
              (model) =>
                model.providerID === session.model?.providerID &&
                model.id === session.model.id,
            )
          : defaultModel && supported(defaultModel)
            ? defaultModel
            : (yield* catalog.model.available()).find(supported);
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          });
        if (!selected)
          return yield* new ModelNotSelectedError({ sessionID: session.id });
        const provider = yield* catalog.provider.get(selected.providerID);
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        );
        const credential = connection
          ? yield* integrations.connection.resolve(connection)
          : undefined;
        const credentialInfo = connection?.type === "credential" ? yield* credentials.get(connection.id) : undefined;
        const model = yield* resolve(
          session,
          selected,
          credential,
          {
            loadPackage: (specifier) => Provider.loadPackage(specifier, npm),
            loadAISDK: (model) => aisdk.model(model),
          },
          connection,
        );
        const variant = session.model?.variant;
        return {
          model,
          ref: CatalogModel.Ref.make({
            id: selected.id,
            providerID: selected.providerID,
            ...(variant === undefined ? {} : { variant }),
          }),
          cost: selected.cost,
          connectionIdentityDigest: digest({
            provider: selected.providerID,
            model: selected.id,
            apiModel: selected.modelID ?? selected.id,
            variant,
            route: model.route.id,
            endpoint: normalizeEndpoint(model.route.endpoint.baseURL),
            organization:
              typeof selected.settings?.organization === "string" ? selected.settings.organization : undefined,
            project: typeof selected.settings?.project === "string" ? selected.settings.project : undefined,
            connection:
              connection?.type === "credential"
                ? { type: connection.type, id: connection.id, generation: credentialInfo?.generation ?? 0 }
                : connection,
            catalog: {
              package: selected.package,
              baseURL: typeof selected.settings?.baseURL === "string" ? normalizeEndpoint(selected.settings.baseURL) : undefined,
            },
          }),
        };
      }),
    });
  }),
);

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const normalizeEndpoint = (value: string | undefined) => {
  if (!value) return undefined;
  const url = new URL(value);
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
};

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Catalog.node, Integration.node, Credential.node, Npm.node, AISDK.node],
});
