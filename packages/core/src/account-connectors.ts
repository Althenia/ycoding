export * as AccountConnectors from "./account-connectors"

import type { FetchLike } from "@modelcontextprotocol/client"
import { Context, Effect, Layer } from "effect"
import { join } from "node:path"
import { AccountConnectorTools } from "./account-connectors/tools"
import { AccountConnectorLibrary } from "./account-connectors/library"
import { AttachmentStore } from "./attachment-store"
import { ClaudeAccountConnectors } from "./account-connectors/claude"
import { Config } from "./config"
import { ConfigAccountConnectors } from "./config/account-connectors"
import { makeLocationNode } from "./effect/app-node"
import { Integration } from "./integration"
import { Global } from "./global"
import { Location } from "./location"
import { MCPClient } from "./mcp/client"
import { Permission } from "./permission"
import { SessionGuardrail } from "./session/guardrail"
import type { SessionEvent } from "./session/event"
import { OpenAICodex } from "./plugin/provider/openai-codex"
import { createClaudeCodeCredentialStore } from "./plugin/provider/anthropic-claude-code-account"
import { createManagedClaudeCodeCredentialSource } from "./plugin/provider/anthropic-claude-code-login"
import type { Tools } from "./tool/tools"

export const endpoint = "https://chatgpt.com/backend-api/ps/mcp"
const integrationID = Integration.ID.make("openai")

export interface Interface {
  readonly tools: (input: {
    readonly profile?: string
    readonly binding?: Pick<SessionEvent.ProfileBinding, "credentialID" | "accountGeneration">
    readonly claude?: {
      readonly profile?: string
      readonly binding?: Pick<SessionEvent.ProfileBinding, "credentialID" | "accountGeneration">
    }
  }) => Effect.Effect<Parameters<Tools.Interface["registerBatch"]>[0], Error>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/AccountConnectors") {}

export function make(options: {
  readonly integration: Pick<Integration.Interface, "get" | "connection">
  readonly permission: Pick<Permission.Interface, "assert">
  readonly guardrail: Pick<SessionGuardrail.Interface, "assert">
  readonly settings: () => Effect.Effect<ConfigAccountConnectors.ChatGPT | undefined>
  readonly directory: string
  readonly fetch?: FetchLike
  readonly attachments?: AttachmentStore.Interface
}): Interface & { readonly library: Interface["tools"] } {
  const select = Effect.fn("AccountConnectors.select")(function* (input: Parameters<Interface["tools"]>[0]) {
    const settings = yield* options.settings()
    if (settings?.enabled !== true) return undefined
    const selected = settings.profile ?? input.profile
    const binding = settings.profile === undefined ? input.binding : undefined
    const integration = yield* options.integration.get(integrationID)
    const connection = integration?.connections.find(
      (value) =>
        value.type === "credential" &&
        (binding
          ? value.id === binding.credentialID
          : selected === undefined
            ? value.active
            : value.label === selected),
    )
    if (!connection || connection.type !== "credential")
      return yield* Effect.fail(
        new Error(
          "ChatGPT connectors require a connected ChatGPT profile. Select the profile in account_connectors.chatgpt.profile.",
        ),
      )
    const snapshot = yield* options.integration.connection.snapshot(connection)
    if (binding && snapshot.credential?.accountGeneration !== binding.accountGeneration)
      return yield* Effect.fail(
        new Error("The selected ChatGPT connector profile was replaced. Select the profile again."),
      )
    if (!snapshot.credential || snapshot.value?.type !== "oauth" || !OpenAICodex.isChatGPT(snapshot.value))
      return yield* Effect.fail(
        new Error("ChatGPT connectors require ChatGPT OAuth; API keys and other accounts are not supported."),
      )
    const accountID = OpenAICodex.accountID(snapshot.value)
    if (!accountID)
      return yield* Effect.fail(
        new Error("The selected ChatGPT profile has no account identity. Reconnect that profile."),
      )
    return { settings, connection, credential: snapshot.credential, value: snapshot.value, accountID }
  })

  return {
    library: Effect.fn("AccountConnectors.library")(function* (input) {
      const selected = yield* select(input)
      if (!selected) return []
      const attachments = options.attachments
      if (!attachments)
        return yield* Effect.fail(new Error("ChatGPT Library managed attachment storage is unavailable"))
      const current = Effect.fn("AccountConnectors.library.current")(function* () {
        const value = yield* select(input)
        if (!value) return yield* Effect.fail(new Error("ChatGPT Library is disabled by configuration"))
        if (
          value.connection.id !== selected.connection.id ||
          value.credential.accountGeneration !== selected.credential.accountGeneration ||
          value.accountID !== selected.accountID
        )
          return yield* Effect.fail(new Error("The ChatGPT Library profile changed; refresh the tool catalog"))
        return value
      })
      const request = Effect.fn("AccountConnectors.library.request")(function* (route: string, init?: RequestInit) {
        const method = init?.method ?? "GET"
        if (
          !(
            method === "POST" &&
            ["/files", "/files/library", "/files/library/mounted/materialize", "/files/process_upload_stream"].includes(
              route,
            )
          ) &&
          !(method === "POST" && /^\/estuary\/upload_content_bytes(?:\?[^#]*)?$/.test(route)) &&
          !(
            method === "GET" &&
            (/^\/files\/library\/files\/[^/?#]+\/download_url$/.test(route) ||
              /^\/(?:estuary\/content|files\/library\/content_download)(?:\?[^#]*)?$/.test(route))
          )
        )
          return yield* Effect.fail(new Error("Unsupported ChatGPT Library transport request"))
        const before = yield* current()
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            (options.fetch ?? fetch)(`https://chatgpt.com/backend-api${route}`, {
              ...init,
              method,
              signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
              redirect: "error",
              headers: {
                ...OpenAICodex.headers(),
                authorization: `Bearer ${before.value.access}`,
                "ChatGPT-Account-Id": before.accountID,
                ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }),
              },
            }),
          catch: () => new Error("ChatGPT Library request failed; do not retry an uncertain write"),
        })
        yield* current().pipe(
          Effect.onError(() =>
            Effect.promise(async () => {
              await response.body?.cancel()
            }),
          ),
        )
        if (!response.ok) {
          yield* Effect.promise(async () => {
            await response.body?.cancel()
          })
          return yield* Effect.fail(new Error(`ChatGPT Library request rejected (HTTP ${response.status})`))
        }
        return response
      })
      return [
        AccountConnectorLibrary.make({
          attachments,
          current,
          request,
          permission: options.permission,
          guardrail: options.guardrail,
          fetch: (url, init) => (options.fetch ?? fetch)(url, init),
        }),
      ]
    }),
    tools: Effect.fn("AccountConnectors.tools")(function* (input) {
      const selected = yield* select(input)
      if (!selected) return []
      const current = Effect.fn("AccountConnectors.current")(function* (connectorID?: string) {
        const value = yield* select(input)
        if (!value || (connectorID !== undefined && value.settings.connectors?.[connectorID] === "deny"))
          return yield* Effect.fail(
            new Error(
              "This ChatGPT connector is disabled by configuration; do not retry this connector; use a permitted native/local tool.",
            ),
          )
        if (
          value.connection.id !== selected.connection.id ||
          value.credential.accountGeneration !== selected.credential.accountGeneration ||
          value.accountID !== selected.accountID
        )
          return yield* Effect.fail(
            new Error("The ChatGPT connector profile changed. Refresh the tool catalog before continuing."),
          )
        return value
      })

      const connect = (connectorID?: string) =>
        MCPClient.connect(
          "chatgpt-account-connectors",
          {
            type: "remote",
            url: endpoint,
            oauth: false,
            timeout: { startup: 10_000, catalog: 30_000, execution: 120_000 },
          },
          options.directory,
          {
            fetch: async (url, init) => {
              if (url.toString() !== endpoint || init?.method?.toUpperCase() !== "POST")
                throw new Error("Unsupported ChatGPT connector transport request")
              const before = await Effect.runPromise(current(connectorID))
              const send = (value: typeof before.value) => {
                const headers = new Headers(init?.headers)
                headers.set("authorization", `Bearer ${value.access}`)
                headers.set("ChatGPT-Account-Id", before.accountID)
                for (const [name, value] of Object.entries(OpenAICodex.headers())) headers.set(name, value)
                return (options.fetch ?? fetch)(url, { ...init, headers, redirect: "error" })
              }
              const first = await send(before.value)
              const response =
                first.status !== 401
                  ? first
                  : await (async () => {
                      await first.body?.cancel()
                      const checked = await Effect.runPromise(current(connectorID))
                      const refreshed = await Effect.runPromise(
                        options.integration.connection.snapshot(checked.connection, {
                          rejectedAccessToken: before.value.access,
                        }),
                      )
                      await Effect.runPromise(current(connectorID))
                      if (
                        refreshed.value?.type !== "oauth" ||
                        !OpenAICodex.isChatGPT(refreshed.value) ||
                        OpenAICodex.accountID(refreshed.value) !== selected.accountID
                      )
                        throw new Error("The ChatGPT connector profile could not refresh. Reconnect that profile.")
                      return send(refreshed.value)
                    })()
              await Effect.runPromise(current(connectorID))
              if (!response.ok) {
                await response.body?.cancel()
                throw new Error(
                  `ChatGPT connector request rejected (HTTP ${response.status}). Verify account access and connector consent in ChatGPT; no client-identity fallback is available.`,
                )
              }
              return response
            },
          },
          undefined,
          "legacy",
        )

      const catalog = yield* Effect.scoped(connect().pipe(Effect.flatMap((client) => client.rawTools())))
      if (catalog.length > 8192) return yield* Effect.fail(new Error("ChatGPT connector catalog exceeds 8192 tools"))
      const entries: Array<{ id: string; label: string; tool: MCPClient.ToolDefinition }> = []
      for (const tool of catalog) {
        const appMetadata = tool.metadata?._codex_apps
        if (
          typeof appMetadata === "object" &&
          appMetadata !== null &&
          "synthetic_link" in appMetadata &&
          appMetadata.synthetic_link === true
        )
          continue
        const connectorID =
          typeof tool.metadata?.connector_id === "string" ? tool.metadata.connector_id.trim() : undefined
        if (!connectorID)
          return yield* Effect.fail(new Error("ChatGPT connector tool has an invalid connector identity"))
        if (selected.settings.connectors?.[connectorID] === "deny") continue
        entries.push({
          id: connectorID,
          label: typeof tool.metadata?.connector_name === "string" ? tool.metadata.connector_name : connectorID,
          tool,
        })
      }
      return yield* AccountConnectorTools.make({
        provider: "chatgpt",
        catalog: entries,
        permission: options.permission,
        guardrail: options.guardrail,
        current,
        call: (id, name, args) =>
          Effect.scoped(connect(id).pipe(Effect.flatMap((client) => client.callTool({ name, args })))),
      })
    }),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const integration = yield* Integration.Service
    const permission = yield* Permission.Service
    const guardrail = yield* SessionGuardrail.Service
    const location = yield* Location.Service
    const attachments = yield* AttachmentStore.Service
    const chatgpt = make({
      attachments,
      integration,
      permission,
      guardrail,
      directory: location.directory,
      settings: () =>
        config.entries().pipe(Effect.map((entries) => Config.latest(entries, "account_connectors")?.chatgpt)),
    })
    const claude = ClaudeAccountConnectors.make({
      integration,
      permission,
      guardrail,
      directory: location.directory,
      credentials: createClaudeCodeCredentialStore({
        source: createManagedClaudeCodeCredentialSource({
          directory: join(Global.Path.data, "claude-code", "profiles"),
        }),
      }),
      settings: () =>
        config.entries().pipe(Effect.map((entries) => Config.latest(entries, "account_connectors")?.claude)),
    })
    return Service.of({
      tools: (input) =>
        Effect.gen(function* () {
          const native = yield* isolate("chatgpt-library", chatgpt.library(input))
          const first = yield* isolate("chatgpt-account-connectors", chatgpt.tools(input))
          const second = yield* isolate("claude-account-connectors", claude.tools(input.claude ?? {}))
          return [...native, ...first, ...second]
        }),
    })
  }),
)

/**
 * A hosted catalog failure (including a protocol-invalid listing) makes only that provider's tools
 * unavailable for the request; the Session still runs, and the warning names the connector server.
 */
export const isolate = <A>(server: string, catalog: Effect.Effect<ReadonlyArray<A>, Error>) =>
  catalog.pipe(
    Effect.catch((error) =>
      Effect.logWarning("account connector tools unavailable", { server, error: error.message }).pipe(
        Effect.as([] as ReadonlyArray<A>),
      ),
    ),
  )

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Integration.node, Permission.node, SessionGuardrail.node, Location.node, AttachmentStore.node],
})
