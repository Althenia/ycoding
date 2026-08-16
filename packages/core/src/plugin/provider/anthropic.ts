import { define } from "@ycoding-ai/plugin/effect/plugin";
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage";
import { Effect, Semaphore, Stream } from "effect";
import { join } from "node:path";
import { Credential } from "../../credential";
import { EventV2 } from "../../event";
import { Global } from "../../global";
import { Integration } from "../../integration";
import { ProviderV2 } from "../../provider";
import { ProviderUsageV2 } from "../../provider-usage";
import { ClaudeUsage } from "../../provider-usage/claude";
import {
  createClaudeCodeCredentialStore,
  createClaudeCodeFetch,
  createSystemClaudeCodeCredentialSource,
  loadClaudeCodeAccountSource,
  saveClaudeCodeAccountSource,
  writeClaudeCodeDebugEvent,
  type ClaudeCodeAccount,
  type ClaudeCodeCredentialSource,
  type ClaudeCodeRequestEvent,
} from "../provider/anthropic-claude-code";

export const claudeCodeMethodID = Integration.MethodID.make("claude-code");
const legacySetupTokenMethodID =
  Integration.MethodID.make("claude-setup-token");
export const claudeCodeSourceSetting = "claudeCodeSource";
export const claudeCodeSentinel = "claude-code";

const featureBetas = [
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
] as const;

export function mergeBetaHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  additions: ReadonlyArray<string>,
) {
  const existing = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === "anthropic-beta",
  )?.[1];
  const values = new Set(
    [...(existing?.split(",") ?? []), ...additions]
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  return ProviderV2.mergeHeaders(
    headers,
    values.size === 0
      ? undefined
      : { "anthropic-beta": Array.from(values).join(",") },
  );
}

export function claudeCodeCredentialSource(
  credential: Credential.Value | undefined,
) {
  if (
    credential?.type !== "oauth" ||
    credential.methodID !== claudeCodeMethodID
  )
    return undefined;
  const source = credential.metadata?.source;
  return typeof source === "string" && source.length > 0
    ? source
    : credential.access;
}

export interface AnthropicPluginOptions {
  readonly credentialSource?: ClaudeCodeCredentialSource;
  readonly fetch?: typeof fetch;
  readonly accountStateFile?: string;
  readonly debugFile?: string;
}

export function makeAnthropicPlugin(options: AnthropicPluginOptions = {}) {
  return define({
    id: "ycoding.provider.anthropic",
    effect: Effect.fn(function* (ctx) {
      const source =
        options.credentialSource ??
        createSystemClaudeCodeCredentialSource({ home: Global.Path.home });
      const accountStateFile =
        options.accountStateFile ??
        join(Global.Path.data, "claude-account-source.txt");
      const debug = process.env.CLAUDE_AUTH_DEBUG;
      const debugFile =
        options.debugFile ??
        (debug && debug !== "1"
          ? debug
          : join(Global.Path.data, "claude-auth-debug.log"));
      const onEvent = debug
        ? (event: ClaudeCodeRequestEvent) =>
            writeClaudeCodeDebugEvent(debugFile, event)
        : undefined;
      const store = createClaudeCodeCredentialStore({
        source,
        fetch: options.fetch,
        onEvent,
      });
      const credentials = yield* Credential.Service;
      const providerUsage = yield* ProviderUsageV2.Service;
      const events = yield* EventV2.Service;
      yield* Effect.forEach(
        yield* credentials.list(Integration.ID.make("anthropic")),
        (credential) =>
          credential.value.type === "oauth" &&
          credential.value.methodID === legacySetupTokenMethodID
            ? credentials.remove(credential.id)
            : Effect.void,
        { discard: true },
      );
      const loading = Semaphore.makeUnsafe(1);
      let accounts: ClaudeCodeAccount[] = [];
      let activeSource: string | undefined;

      const discover = Effect.fn("AnthropicPlugin.discoverClaudeCodeAccounts")(
        function* () {
          accounts = yield* Effect.tryPromise(() => store.accounts()).pipe(
            Effect.catch((cause) => {
              onEvent?.({
                event: "account-discovery-failed",
                data: { cause: String(cause) },
              });
              return Effect.succeed([]);
            }),
          );
          const persisted = loadClaudeCodeAccountSource(accountStateFile);
          activeSource =
            accounts.find((account) => account.source === persisted)?.source ??
            accounts[0]?.source;
        },
      );

      const loadConnection = Effect.fn("AnthropicPlugin.loadConnection")(
        function* () {
          const connection =
            yield* ctx.integration.connection.active("anthropic");
          const credential = connection
            ? yield* ctx.integration.connection
                .resolve(connection)
                .pipe(Effect.catch(() => Effect.succeed(undefined)))
            : undefined;
          if (credential?.type === "key") {
            activeSource = undefined;
            return;
          }
          const selected = claudeCodeCredentialSource(credential);
          if (
            selected &&
            accounts.some((account) => account.source === selected)
          )
            activeSource = selected;
        },
      );

      const method = () =>
        ({
          integrationID: Integration.ID.make("anthropic"),
          method: {
            id: claudeCodeMethodID,
            type: "oauth" as const,
            label: "Claude Code account",
            prompts:
              accounts.length <= 1
                ? undefined
                : [
                    {
                      type: "select" as const,
                      key: "account",
                      message: "Select a Claude Code account",
                      options: accounts.map((account) => ({
                        label: account.label,
                        value: account.source,
                        hint:
                          account.source === activeSource
                            ? `${account.source} (active)`
                            : account.source,
                      })),
                    },
                  ],
          },
          authorize: (inputs: Integration.Inputs) =>
            Effect.tryPromise(() => store.accounts()).pipe(
              Effect.flatMap((latest) => {
                accounts = latest;
                const source =
                  inputs.account ??
                  activeSource ??
                  loadClaudeCodeAccountSource(accountStateFile);
                const selected =
                  accounts.find((account) => account.source === source) ??
                  accounts[0];
                if (!selected)
                  return Effect.fail(
                    new Error(
                      "Claude Code credentials were not found. Run `claude auth login`.",
                    ),
                  );
                return Effect.succeed({
                  mode: "auto" as const,
                  url: "",
                  instructions: `Using ${selected.label} from ${selected.source}.`,
                  callback: Effect.sync(() => {
                    activeSource = selected.source;
                    saveClaudeCodeAccountSource(
                      accountStateFile,
                      selected.source,
                    );
                    return Credential.OAuth.make({
                      type: "oauth",
                      methodID: claudeCodeMethodID,
                      access: selected.source,
                      refresh: "",
                      expires: Number.MAX_SAFE_INTEGER,
                      metadata: {
                        authKind: "claude-code",
                        source: selected.source,
                      },
                    });
                  }),
                });
              }),
            ),
          label: (credential: Credential.OAuth) => {
            const source = claudeCodeCredentialSource(credential);
            return accounts.find((account) => account.source === source)?.label;
          },
        }) satisfies Integration.OAuthImplementation;

      yield* discover();
      yield* ctx.integration.transform((draft) => {
        draft.method.update(method());
        draft.method.update({
          integrationID: Integration.ID.make("anthropic"),
          method: { type: "env", names: ["ANTHROPIC_API_KEY"] },
        });
      });
      yield* loadConnection();

      yield* ctx.catalog.transform((evt) => {
        for (const item of evt.provider.list()) {
          if (!ProviderV2.isAISDK(item.provider.package)) continue;
          if (
            ProviderV2.packageName(item.provider.package) !==
            "@ai-sdk/anthropic"
          )
            continue;
          evt.provider.update(item.provider.id, (provider) => {
            provider.headers = mergeBetaHeaders(provider.headers, featureBetas);
            if (!activeSource) return;
            provider.settings = ProviderV2.mergeOverlay(provider.settings, {
              apiKey: claudeCodeSentinel,
              [claudeCodeSourceSetting]: activeSource,
            });
          });
          if (!activeSource) continue;
          for (const model of item.models.values())
            evt.model.update(
              item.provider.id,
              model.id,
              (draft) => (draft.cost = []),
            );
        }
      });

      const reload = () =>
        loading.withPermit(
          discover().pipe(
            Effect.andThen(loadConnection()),
            Effect.andThen(ctx.integration.reload()),
            Effect.andThen(ctx.catalog.reload()),
          ),
        );
      yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
        Stream.filter(
          (event) =>
            event.data.integrationID === Integration.ID.make("anthropic"),
        ),
        Stream.runForEach(reload),
        Effect.forkScoped({ startImmediately: true }),
      );

      yield* ctx.aisdk.hook(
        "sdk",
        Effect.fn(function* (evt) {
          if (evt.package !== "@ai-sdk/anthropic") return;
          const source =
            evt.options.apiKey === claudeCodeSentinel &&
            typeof evt.options[claudeCodeSourceSetting] === "string"
              ? evt.options[claudeCodeSourceSetting]
              : undefined;
          if (source) {
            const upstream =
              options.fetch ??
              (typeof evt.options.fetch === "function"
                ? evt.options.fetch
                : fetch);
            evt.options.apiKey = "";
            delete evt.options.authToken;
            delete evt.options[claudeCodeSourceSetting];
            evt.options.fetch = createClaudeCodeFetch({
              fetch: upstream,
              credentials: () => store.resolve(source),
              reload: () => store.refresh(source),
              onEvent,
              onResponse: async (response) => {
                const credentials = await store.resolve(source);
                const snapshot = ClaudeUsage.normalizeHeaders({
                  providerID: ProviderV2.ID.make("anthropic"),
                  label: "Claude",
                  subscriptionType: credentials?.subscriptionType,
                  observedAt: Date.now(),
                  headers: response.headers,
                });
                if (snapshot.windows.length === 0) return;
                await Effect.runPromise(
                  providerUsage.observe(
                    new ProviderUsage.Observation({
                      providerID: snapshot.providerID,
                      label: snapshot.label,
                      source: snapshot.source,
                      stability: snapshot.stability,
                      observedAt: snapshot.updatedAt,
                      windows: snapshot.windows,
                    }),
                  ),
                );
              },
            });
          }
          const mod = yield* Effect.promise(() => import("@ai-sdk/anthropic"));
          evt.sdk = mod.createAnthropic(evt.options);
        }),
      );
    }),
  });
}

export const AnthropicPlugin = makeAnthropicPlugin();
