import { define } from "@ycoding-ai/plugin/effect/plugin"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Effect, Semaphore, Stream } from "effect"
import { join } from "node:path"
import { Credential } from "../../credential"
import { AISDK } from "../../aisdk"
import { SessionRunnerModel } from "../../session/runner/model"
import { EventRuntime } from "../../event"
import { Global } from "../../global"
import { Integration } from "../../integration"
import { Provider } from "../../provider"
import { ProviderUsageRuntime } from "../../provider-usage"
import { ClaudeUsage } from "../../provider-usage/claude"
import { SessionMessage } from "../../session/message"
import { SessionSchema } from "../../session/schema"
import type { PluginRuntime } from "../runtime"
import {
  claudeCodeBillingSample,
  createClaudeCodeCredentialStore,
  createClaudeCodeFetch,
  writeClaudeCodeDebugEvent,
  type ClaudeCodeAccount,
  type ClaudeCodeCredentialSource,
  type ClaudeCodeRequestEvent,
} from "../provider/anthropic-claude-code"
import { authorizeClaudeCodeProfile, createManagedClaudeCodeCredentialSource } from "./anthropic-claude-code-login"

export const claudeCodeMethodID = Integration.MethodID.make("claude-code")
const legacySetupTokenMethodID = Integration.MethodID.make("claude-setup-token")
export const claudeCodeSourceSetting = "claudeCodeSource"
export const claudeCodeSentinel = "claude-code"

const featureBetas = ["interleaved-thinking-2025-05-14", "fine-grained-tool-streaming-2025-05-14"] as const

export function mergeBetaHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  additions: ReadonlyArray<string>,
) {
  const existing = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "anthropic-beta")?.[1]
  const values = new Set(
    [...(existing?.split(",") ?? []), ...additions].map((value) => value.trim()).filter((value) => value.length > 0),
  )
  return Provider.mergeHeaders(
    headers,
    values.size === 0 ? undefined : { "anthropic-beta": Array.from(values).join(",") },
  )
}

export function claudeCodeCredentialSource(credential: Credential.Value | undefined) {
  if (
    credential?.type !== "oauth" ||
    credential.methodID !== claudeCodeMethodID ||
    credential.metadata?.authKind !== "claude-code" ||
    credential.metadata?.managed !== true ||
    credential.metadata?.requiresLogin === true
  )
    return undefined
  const source = credential.metadata?.source
  return typeof source === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(source) &&
    source === credential.access &&
    credential.expires === Number.MAX_SAFE_INTEGER
    ? source
    : undefined
}

export interface AnthropicPluginOptions {
  readonly credentialSource?: ClaudeCodeCredentialSource
  readonly directory?: string
  readonly authorize?: typeof authorizeClaudeCodeProfile
  readonly fetch?: typeof fetch
  readonly debugFile?: string
}

export function makeAnthropicPlugin(options: AnthropicPluginOptions = {}) {
  return define({
    id: "ycoding.provider.anthropic",
    effect: Effect.fn(function* (ctx) {
      const directory = options.directory ?? join(Global.Path.data, "claude-code", "profiles")
      const source = options.credentialSource ?? createManagedClaudeCodeCredentialSource({ directory })
      const debug = process.env.CLAUDE_AUTH_DEBUG
      const debugFile =
        options.debugFile ?? (debug && debug !== "1" ? debug : join(Global.Path.data, "claude-auth-debug.log"))
      const onEvent = debug ? (event: ClaudeCodeRequestEvent) => writeClaudeCodeDebugEvent(debugFile, event) : undefined
      const store = createClaudeCodeCredentialStore({
        source,
        fetch: options.fetch,
        onEvent,
      })
      const credentials = yield* Credential.Service
      const aisdk = yield* AISDK.Service
      const providerUsage = yield* ProviderUsageRuntime.Service
      const events = yield* EventRuntime.Service
      const { PluginRuntime } = yield* Effect.promise(() => import("../runtime"))
      const runtime = yield* PluginRuntime.Service
      yield* Effect.forEach(
        yield* credentials.list(Integration.ID.make("anthropic")),
        (credential) =>
          credential.value.type === "oauth" && credential.value.methodID === legacySetupTokenMethodID
            ? credentials.remove(credential.id)
            : Effect.void,
        { discard: true },
      )
      yield* Effect.forEach(
        yield* credentials.list(Integration.ID.make("anthropic")),
        (profile) =>
          profile.value.type === "oauth" &&
          profile.value.methodID === claudeCodeMethodID &&
          profile.value.metadata?.managed !== true &&
          profile.value.metadata?.requiresLogin !== true
            ? credentials.update(profile.id, {
                value: Credential.OAuth.make({
                  type: "oauth",
                  methodID: claudeCodeMethodID,
                  access: "",
                  refresh: "",
                  expires: 0,
                  metadata: { authKind: "claude-code", requiresLogin: true },
                }),
              })
            : Effect.void,
        { discard: true },
      )
      const loading = Semaphore.makeUnsafe(1)
      let accounts: ClaudeCodeAccount[] = []
      let activeSource: string | undefined

      const discover = Effect.fn("AnthropicPlugin.discoverClaudeCodeAccounts")(function* () {
        accounts = yield* Effect.tryPromise(() => store.accounts()).pipe(
          Effect.catch((cause) => {
            onEvent?.({
              event: "account-discovery-failed",
              data: { cause: String(cause) },
            })
            return Effect.succeed([])
          }),
        )
      })

      const loadConnection = Effect.fn("AnthropicPlugin.loadConnection")(function* () {
        const connection = yield* ctx.integration.connection.active("anthropic")
        const credential = connection
          ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
          : undefined
        activeSource = undefined
        const selected = claudeCodeCredentialSource(credential)
        if (selected && accounts.some((account) => account.source === selected)) activeSource = selected
      })

      const method = () =>
        ({
          integrationID: Integration.ID.make("anthropic"),
          method: {
            id: claudeCodeMethodID,
            type: "oauth" as const,
            label: "Claude Code account",
            remote: true,
            prompts: undefined,
          },
          authorize: (_inputs: Integration.Inputs) =>
            (options.authorize ?? authorizeClaudeCodeProfile)({ directory, credentialSource: source }).pipe(
              Effect.map((attempt) => ({
                mode: "auto" as const,
                url: attempt.url,
                instructions: attempt.instructions,
                submitCode: attempt.submitCode,
                callback: attempt.callback.pipe(
                  Effect.map(() =>
                    Credential.OAuth.make({
                      type: "oauth",
                      methodID: claudeCodeMethodID,
                      access: attempt.source,
                      refresh: "",
                      expires: Number.MAX_SAFE_INTEGER,
                      metadata: { authKind: "claude-code", source: attempt.source, managed: true },
                    }),
                  ),
                ),
              })),
            ),
          refresh: (credential) =>
            Effect.fail(
              new Error(
                claudeCodeCredentialSource(credential)
                  ? "Managed Claude profile requires reconnect. Sign in again."
                  : "Claude profile requires reconnect. Sign in to this profile again.",
              ),
            ),
          label: (credential: Credential.OAuth) => {
            const source = claudeCodeCredentialSource(credential)
            return accounts.find((account) => account.source === source)?.label
          },
        }) satisfies Integration.OAuthImplementation

      yield* discover()
      yield* ctx.integration.transform((draft) => {
        draft.method.update(method())
        draft.method.update({
          integrationID: Integration.ID.make("anthropic"),
          method: { type: "env", names: ["ANTHROPIC_API_KEY"] },
        })
      })
      yield* loadConnection()

      yield* ctx.catalog.transform((evt) => {
        for (const item of evt.provider.list()) {
          if (!Provider.isAISDK(item.provider.package)) continue
          if (Provider.packageName(item.provider.package) !== "@ai-sdk/anthropic") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.headers = mergeBetaHeaders(provider.headers, featureBetas)
            if (!activeSource) {
              if (provider.settings?.apiKey === claudeCodeSentinel) {
                delete provider.settings.apiKey
                delete provider.settings[claudeCodeSourceSetting]
              }
              return
            }
            provider.settings = Provider.mergeOverlay(provider.settings, {
              apiKey: claudeCodeSentinel,
              [claudeCodeSourceSetting]: activeSource,
            })
          })
        }
      })

      const reload = () =>
        loading.withPermit(
          discover().pipe(
            Effect.andThen(loadConnection()),
            Effect.andThen(ctx.integration.reload()),
            Effect.andThen(ctx.catalog.reload()),
          ),
        )
      yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
        Stream.filter((event) => event.data.integrationID === Integration.ID.make("anthropic")),
        Stream.runForEach(reload),
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* aisdk.hook.sdk(
        Effect.fn(function* (evt) {
          if (evt.package !== "@ai-sdk/anthropic") return
          const source =
            evt.options.apiKey === claudeCodeSentinel && typeof evt.options[claudeCodeSourceSetting] === "string"
              ? evt.options[claudeCodeSourceSetting]
              : undefined
          if (source) {
            const expected = evt.snapshot?.credential
            const resolveCredentials = async () => {
              if (expected) {
                const current = await Effect.runPromise(credentials.get(expected.id))
                if (!current || current.accountGeneration !== expected.accountGeneration)
                  throw new Error("Claude profile changed; select the profile again")
              }
              return store.resolve(source)
            }
            const upstream = options.fetch ?? (typeof evt.options.fetch === "function" ? evt.options.fetch : fetch)
            evt.options.apiKey = ""
            delete evt.options.authToken
            delete evt.options[claudeCodeSourceSetting]
            evt.options.fetch = createClaudeCodeFetch({
              fetch: upstream,
              credentials: resolveCredentials,
              reload: async () => {
                await resolveCredentials()
                return store.refresh(source)
              },
              billingSample: (sessionID) =>
                Effect.runPromise(
                  durableBillingSample(runtime, SessionSchema.ID.make(sessionID)).pipe(
                    Effect.catch(() => Effect.succeed(undefined)),
                  ),
                ),
              onEvent,
              onResponse: async (response, dispatched) => {
                const snapshot = ClaudeUsage.normalizeHeaders({
                  providerID: Provider.ID.make("anthropic"),
                  label: "Claude",
                  subscriptionType: dispatched.subscriptionType,
                  observedAt: Date.now(),
                  headers: response.headers,
                })
                if (snapshot.windows.length === 0) return
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
                    expected ? SessionRunnerModel.accountIdentityDigest(expected) : source,
                  ),
                )
              },
            })
          }
          const mod = yield* Effect.promise(() => import("@ai-sdk/anthropic"))
          evt.sdk = mod.createAnthropic(evt.options)
        }),
      )
    }),
  })
}

export const AnthropicPlugin = makeAnthropicPlugin()

const BILLING_MESSAGE_PAGE_SIZE = 32

const durableBillingSample = Effect.fn("AnthropicPlugin.durableBillingSample")(function* (
  runtime: PluginRuntime.Interface,
  sessionID: SessionSchema.ID,
) {
  let cursor: { readonly id: SessionMessage.ID; readonly direction: "next" } | undefined
  while (true) {
    const messages = yield* runtime.session.messages({
      sessionID,
      limit: BILLING_MESSAGE_PAGE_SIZE,
      order: "asc",
      ...(cursor ? { cursor } : {}),
    })
    const first = messages.find((message) => message.type === "user")
    if (first) return claudeCodeBillingSample(first.text)
    const last = messages.at(-1)
    if (!last || messages.length < BILLING_MESSAGE_PAGE_SIZE) return undefined
    cursor = { id: last.id, direction: "next" }
  }
})
