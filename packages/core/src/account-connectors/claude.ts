export * as ClaudeAccountConnectors from "./claude"

import type { FetchLike } from "@modelcontextprotocol/client"
import { Effect, Schema } from "effect"
import type { AccountConnectors } from "../account-connectors"
import type { ConfigAccountConnectors } from "../config/account-connectors"
import { Integration } from "../integration"
import { MCPClient } from "../mcp/client"
import type { Permission } from "../permission"
import type { ClaudeCodeCredentialStore } from "../plugin/provider/anthropic-claude-code-account"
import { claudeCodeAPIUserAgent, claudeCodeMCPProxyHeaders } from "../plugin/provider/anthropic-claude-code-request"
import type { SessionGuardrail } from "../session/guardrail"
import { AccountConnectorTools } from "./tools"

const endpoint = "https://api.anthropic.com/v1/mcp_servers?limit=1000&include_additional_installs=true"
const Connector = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()),
  display_name: Schema.String.pipe(Schema.optional),
  eligible: Schema.Boolean.pipe(Schema.optional),
  tools: Schema.Array(
    Schema.Struct({ name: Schema.String, effective_max_permission: Schema.Unknown.pipe(Schema.optional) }),
  ).pipe(Schema.optional),
})
const Catalog = Schema.Struct({ data: Schema.Array(Connector), has_more: Schema.Boolean.pipe(Schema.optional) })

export function make(options: {
  readonly integration: Pick<Integration.Interface, "get" | "connection">
  readonly credentials: ClaudeCodeCredentialStore
  readonly permission: Pick<Permission.Interface, "assert">
  readonly guardrail: Pick<SessionGuardrail.Interface, "assert">
  readonly settings: () => Effect.Effect<ConfigAccountConnectors.Claude | undefined>
  readonly directory: string
  readonly fetch?: FetchLike
}): AccountConnectors.Interface {
  const select = Effect.fn("ClaudeAccountConnectors.select")(function* (
    input: Parameters<AccountConnectors.Interface["tools"]>[0],
  ) {
    const settings = yield* options.settings()
    if (settings?.enabled !== true) return undefined
    const selected = settings.profile ?? input.profile
    const binding = settings.profile === undefined ? input.binding : undefined
    const integration = yield* options.integration.get(Integration.ID.make("anthropic"))
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
          "Claude connectors require an existing Claude OAuth profile. Select account_connectors.claude.profile.",
        ),
      )
    const snapshot = yield* options.integration.connection.snapshot(connection)
    if (!snapshot.credential || (binding && snapshot.credential.accountGeneration !== binding.accountGeneration))
      return yield* Effect.fail(
        new Error("The selected Claude connector profile was replaced. Select the profile again."),
      )
    const { claudeCodeCredentialSource } = yield* Effect.promise(() => import("../plugin/provider/anthropic"))
    const source = claudeCodeCredentialSource(snapshot.value)
    if (!source)
      return yield* Effect.fail(
        new Error(
          "Claude connectors require a YCoding-managed Claude OAuth profile; API keys and inference-only setup tokens are unsupported.",
        ),
      )
    const value = yield* Effect.tryPromise(() => options.credentials.resolve(source)).pipe(
      Effect.mapError(() => new Error("The selected Claude connector profile is unavailable. Reconnect that profile.")),
    )
    if (!value?.scopes?.includes("user:mcp_servers"))
      return yield* Effect.fail(
        new Error("The selected Claude profile lacks user:mcp_servers. Reconnect that profile with connector access."),
      )
    return { settings, connection, credential: snapshot.credential, source, value }
  })
  return {
    tools: Effect.fn("ClaudeAccountConnectors.tools")(function* (input) {
      const selected = yield* select(input)
      if (!selected) return []
      const current = Effect.fn("ClaudeAccountConnectors.current")(function* (id?: string) {
        const value = yield* select(input)
        if (!value || (id !== undefined && value.settings.connectors?.[id] === "deny"))
          return yield* Effect.fail(new Error("This Claude connector is disabled. Refresh the tool catalog."))
        if (
          value.connection.id !== selected.connection.id ||
          value.credential.accountGeneration !== selected.credential.accountGeneration ||
          value.source !== selected.source
        )
          return yield* Effect.fail(new Error("The Claude connector profile changed. Refresh the tool catalog."))
        return value
      })
      const send =
        (id?: string): FetchLike =>
        async (url, init) => {
          const target =
            id === undefined ? endpoint : `https://mcp-proxy.anthropic.com/v1/mcp/${encodeURIComponent(id)}`
          if (url.toString() !== target) throw new Error("Unsupported Claude connector credential destination")
          const method = init?.method?.toUpperCase() ?? "GET"
          if (method !== (id === undefined ? "GET" : "POST")) return new Response(null, { status: 405 })
          const before = await Effect.runPromise(current(id))
          const request = (access: string) => {
            const headers = new Headers(init?.headers)
            headers.set("authorization", `Bearer ${access}`)
            Object.entries(
              id === undefined
                ? {
                    "user-agent": claudeCodeAPIUserAgent(),
                    "anthropic-version": "2023-06-01",
                    "anthropic-beta": "mcp-servers-2025-12-04",
                  }
                : claudeCodeMCPProxyHeaders(),
            ).forEach(([key, value]) => headers.set(key, value))
            return (options.fetch ?? fetch)(url, { ...init, headers, redirect: "error" })
          }
          const first = await request(before.value.accessToken)
          const response =
            first.status !== 401 || first.headers.has("X-Mcp-Error-Code")
              ? first
              : await (async () => {
                  await first.body?.cancel()
                  await Effect.runPromise(current(id))
                  const reloaded = await options.credentials.reload(before.source)
                  const next =
                    reloaded?.accessToken !== before.value.accessToken && reloaded
                      ? reloaded
                      : await options.credentials.refresh(before.source)
                  await Effect.runPromise(current(id))
                  if (!next?.scopes?.includes("user:mcp_servers"))
                    throw new Error(
                      "Claude connector authentication could not refresh with connector access. Reconnect that profile.",
                    )
                  return request(next.accessToken)
                })()
          await Effect.runPromise(current(id))
          if (!response.ok) {
            await response.body?.cancel()
            throw new Error(
              `Claude connector request rejected (HTTP ${response.status}). Check account access and connector authorization in Claude; no client-identity fallback is available.`,
            )
          }
          return response
        }
      const response = yield* Effect.tryPromise(() =>
        send()(endpoint, { method: "GET", signal: AbortSignal.timeout(12_000) }),
      )
      const catalog = yield* Effect.tryPromise(() => response.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Catalog)),
        Effect.mapError(() => new Error("Claude connector catalog response is invalid")),
      )
      if (catalog.has_more || catalog.data.length > 1000)
        return yield* Effect.fail(
          new Error("Claude connector catalog is incomplete; paginated account discovery is unsupported."),
        )
      const connect = (id: string) =>
        MCPClient.connect(
          "claude-account-connectors",
          {
            type: "remote",
            url: `https://mcp-proxy.anthropic.com/v1/mcp/${encodeURIComponent(id)}`,
            oauth: false,
            timeout: { startup: 10_000, catalog: 30_000, execution: 120_000 },
          },
          options.directory,
          { fetch: send(id) },
        )
      const entries: Array<{ id: string; label: string; tool: MCPClient.ToolDefinition; requireExplicitDecision: boolean }> = []
      const ids = new Set<string>()
      for (const connector of catalog.data) {
        if ([".", ".."].includes(connector.id) || ids.has(connector.id))
          return yield* Effect.fail(new Error("Claude connector catalog contains an invalid or duplicate identity"))
        ids.add(connector.id)
        if (connector.eligible === false || selected.settings.connectors?.[connector.id] === "deny") continue
        const tools = yield* Effect.scoped(connect(connector.id).pipe(Effect.flatMap((client) => client.tools())))
        for (const tool of tools) {
          const policy = connector.tools?.findLast(
            (value) => value.name === tool.name && value.effective_max_permission !== undefined,
          )?.effective_max_permission
          if (policy !== undefined && policy !== "allow" && policy !== "ask") continue
          if (entries.length >= 8192)
            return yield* Effect.fail(new Error("Claude connector catalog exceeds 8192 tools"))
          entries.push({
            id: connector.id,
            label: connector.display_name ?? connector.id,
            tool,
            requireExplicitDecision: policy === "ask" || tool.metadata?.["anthropic/requiresUserInteraction"] === true,
          })
        }
      }
      return yield* AccountConnectorTools.make({
        provider: "claude",
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
