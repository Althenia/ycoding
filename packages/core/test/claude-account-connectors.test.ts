import { describe, expect, test } from "bun:test"
import { createMcpHandler, Server } from "@modelcontextprotocol/server"
import type { FetchLike } from "@modelcontextprotocol/client"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import type { ConfigAccountConnectors } from "@ycoding-ai/core/config/account-connectors"
import { Credential } from "@ycoding-ai/core/credential"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Integration } from "@ycoding-ai/core/integration"
import { Permission } from "@ycoding-ai/core/permission"
import { createClaudeCodeCredentialStore } from "@ycoding-ai/core/plugin/provider/anthropic-claude-code-account"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { Tool } from "@ycoding-ai/core/tool/tool"
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventRuntime.node])))
const integrationID = Integration.ID.make("anthropic")
const methodID = Integration.MethodID.make("claude-code")
const firstSource = "11111111-1111-4111-8111-111111111111"
const secondSource = "22222222-2222-4222-8222-222222222222"
const context = {
  sessionID: SessionSchema.ID.make("ses_claude_connectors"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_claude_connectors"),
  callID: "call_claude_connector",
  progress: () => Effect.void,
}
const settings = { enabled: true, connectors: { hidden: "deny" as const } }
const catalog = [
  {
    id: "mail",
    display_name: "Mail",
    url: "https://untrusted.invalid/mcp",
    tools: [
      { name: "send", effective_max_permission: "ask" },
      { name: "blocked", effective_max_permission: "blocked" },
      { name: "invalid_permission", effective_max_permission: "unknown" },
    ],
  },
  { id: "hidden", display_name: "Hidden" },
  { id: "unavailable", display_name: "Unavailable", eligible: false },
]
const inputSchema = { type: "object" as const, properties: { query: { type: "string" } }, required: ["query"] }

function backend(
  options: {
    status?: number
    unauthorized?: boolean
    classified?: boolean
    isError?: boolean
    invalidOutput?: boolean
    incomplete?: boolean
  } = {},
) {
  const requests: Array<{ url: string; headers: Headers; body?: Record<string, unknown> }> = []
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "synthetic-claude-connector", version: "1" }, { capabilities: { tools: {} } })
    server.setRequestHandler("tools/list", async (request) => ({
      tools: request.params?.cursor
        ? [
            { name: "send", inputSchema },
            { name: "blocked", inputSchema },
            { name: "invalid_permission", inputSchema },
          ]
        : [
            {
              name: "search",
              description: "Search synthetic mail",
              inputSchema,
              outputSchema: { type: "object", properties: { matched: { type: "number" } }, required: ["matched"] },
            },
          ],
      ...(request.params?.cursor ? {} : { nextCursor: "page-2" }),
    }))
    server.setRequestHandler("tools/call", async () => ({
      content: [{ type: "text", text: "synthetic-result" }],
      structuredContent: { matched: options.invalidOutput ? "invalid" : 1 },
      isError: options.isError,
    }))
    return server
  })
  const fetcher: FetchLike = async (url, init) => {
    const request = new Request(url.toString(), init)
    const body = request.method === "POST" ? ((await request.clone().json()) as Record<string, unknown>) : undefined
    requests.push({ url: request.url, headers: request.headers, body })
    if (options.status) return new Response(null, { status: options.status })
    if (options.unauthorized && request.headers.get("authorization") === "Bearer fixture-access-a")
      return new Response(null, {
        status: 401,
        headers: options.classified ? { "X-Mcp-Error-Code": "connector_auth_required" } : {},
      })
    if (request.url === "https://api.anthropic.com/v1/mcp_servers?limit=1000&include_additional_installs=true")
      return Response.json({ data: catalog, has_more: options.incomplete ?? false })
    if (request.url !== "https://mcp-proxy.anthropic.com/v1/mcp/mail")
      throw new Error("Unexpected credential destination")
    if (!request.headers.get("x-mcp-client-session-id"))
      return Response.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "header.X-Mcp-Client-Session-Id: Field required" },
        },
        { status: 400 },
      )
    return handler.fetch(request)
  }
  return { requests, fetch: fetcher, close: () => handler.close() }
}

const client = Effect.fn(function* (input: {
  backend: ReturnType<typeof backend>
  settings?: () => ConfigAccountConnectors.Claude | undefined
  scopes?: string[]
  permission?: Permission.Interface["assert"]
  guardrail?: SessionGuardrail.Interface["assert"]
}) {
  const { ClaudeAccountConnectors } = yield* Effect.promise(() => import("../src/account-connectors/claude"))
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  yield* integrations.transform((draft) =>
    draft.method.update({
      integrationID,
      method: { id: methodID, type: "oauth", label: "Synthetic Claude" },
      authorize: () => Effect.die("Authentication must not start"),
      refresh: () => Effect.die("Managed profile references must not be refreshed as bearer tokens"),
    }),
  )
  const create = (source: string, label: string) =>
    credentials.create({
      integrationID,
      label,
      value: Credential.OAuth.make({
        type: "oauth",
        methodID,
        access: source,
        refresh: "",
        expires: Number.MAX_SAFE_INTEGER,
        metadata: { authKind: "claude-code", managed: true, source },
      }),
    })
  const suffix = Credential.ID.create()
  const first = yield* create(firstSource, `fixture-a-${suffix}`)
  const second = yield* create(secondSource, `fixture-b-${suffix}`)
  yield* credentials.activate(first.id)
  const accesses: string[] = []
  const refreshed: string[] = []
  const values = new Map(
    [firstSource, secondSource].map((source) => [
      source,
      {
        accessToken: source === firstSource ? "fixture-access-a" : "fixture-access-b",
        refreshToken: "fixture-refresh",
        expiresAt: Date.now() + 3_600_000,
        scopes: input.scopes ?? ["user:mcp_servers"],
      },
    ]),
  )
  const store = createClaudeCodeCredentialStore({
    source: {
      list: async () => [],
      read: async (source) => {
        accesses.push(source)
        return values.get(source) ?? null
      },
      write: async (source, value) => {
        values.set(source, { ...value, scopes: [...(value.scopes ?? [])] })
        return true
      },
    },
    fetch: Object.assign(
      async () => {
        refreshed.push("refresh")
        return Response.json({ access_token: "fixture-refreshed", expires_in: 3600 })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const assertions: Permission.AssertInput[] = []
  const service = ClaudeAccountConnectors.make({
    integration: integrations,
    credentials: store,
    directory: "/synthetic-project",
    fetch: input.backend.fetch,
    settings: () => Effect.sync(input.settings ?? (() => settings)),
    permission: {
      assert:
        input.permission ??
        ((value) =>
          Effect.sync(() => {
            assertions.push(value)
          })),
    },
    guardrail: { assert: input.guardrail ?? (() => Effect.succeed({ release: Effect.void })) },
  })
  yield* Effect.addFinalizer(() => Effect.promise(input.backend.close))
  return { service, credentials, first, second, assertions, accesses, refreshed }
})

function find(registrations: ReadonlyArray<{ tools: Readonly<Record<string, Tool.AnyTool>> }>, suffix: string) {
  const entry = registrations
    .flatMap((value) => Object.entries(value.tools))
    .find(([name]) => name.includes(`_${suffix}_`))
  if (!entry) throw new Error("Missing synthetic tool")
  return entry
}

describe("Claude account connectors", () => {
  test("configuration retains an independent opt-in profile and connector policy", () => {
    const value = { account_connectors: { claude: { ...settings, profile: "fixture-a" } } }
    expect(Schema.decodeUnknownSync(Config.Info)(value)).toMatchObject(value)
    expect(
      Permission.evaluate("claude_mail_send", "mail", Agent.Info.empty(Agent.ID.make("fixture")).permissions).effect,
    ).toBe("ask")
  })

  it.live("omitted and disabled settings perform no credential reads or requests", () =>
    Effect.gen(function* () {
      for (const value of [undefined, { ...settings, enabled: false }]) {
        const remote = backend()
        const current = yield* client({ backend: remote, settings: () => value })
        expect(yield* current.service.tools({})).toEqual([])
        expect(current.accesses).toEqual([])
        expect(remote.requests).toEqual([])
      }
    }),
  )

  it.live("discovers paginated schemas through the fixed proxy and enforces connector and organization denies", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote })
      const entries = (yield* current.service.tools({})).flatMap((value) => Object.keys(value.tools))
      expect(entries).toHaveLength(2)
      expect(entries.some((name) => name.includes("_blocked_") || name.includes("invalid_permission"))).toBe(false)
      expect(remote.requests[0].headers.get("anthropic-beta")).toBe("mcp-servers-2025-12-04")
      expect(
        remote.requests.every((request) => request.headers.get("authorization") === "Bearer fixture-access-a"),
      ).toBe(true)
      const [discovery, ...proxied] = remote.requests
      expect(discovery.headers.get("user-agent")).toMatch(/^claude-cli\/\S+ \(external, sdk-cli\)$/)
      expect(discovery.headers.get("x-mcp-client-session-id")).toBeNull()
      expect(proxied.every((request) => /^claude-code\/\S+ \(cli\)$/.test(request.headers.get("user-agent") ?? ""))).toBe(true)
      expect(proxied.every((request) => request.headers.get("accept-encoding") === "identity")).toBe(true)
      const sessions = new Set(proxied.map((request) => request.headers.get("x-mcp-client-session-id")))
      expect(sessions.size).toBe(1)
      expect([...sessions][0]).toMatch(/^[0-9a-f-]{36}$/)
      expect(remote.requests.every((request) => request.headers.get("cookie") === null)).toBe(true)
      expect(remote.requests.filter((request) => request.body?.method === "tools/list")).toHaveLength(2)
    }),
  )

  it.live("rejects missing scopes, missing profiles, and incomplete catalogs without using another account", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote, scopes: ["user:inference"] })
      expect(Exit.isFailure(yield* current.service.tools({}).pipe(Effect.exit))).toBe(true)
      expect(remote.requests).toEqual([])
      expect(Exit.isFailure(yield* current.service.tools({ profile: "absent" }).pipe(Effect.exit))).toBe(true)
      const incomplete = backend({ incomplete: true })
      const selected = yield* client({ backend: incomplete })
      expect(Exit.isFailure(yield* selected.service.tools({}).pipe(Effect.exit))).toBe(true)
      expect(incomplete.requests).toHaveLength(1)
    }),
  )

  it.live("captures the selected profile across global activation and rejects implicit-profile switches", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote })
      const [, captured] = find(yield* current.service.tools({}), "search")
      yield* current.credentials.activate(current.second.id)
      expect(
        Exit.isFailure(yield* Tool.settle(captured, { input: { query: "synthetic" } }, context).pipe(Effect.exit)),
      ).toBe(true)
      yield* current.service.tools({
        binding: { credentialID: current.first.id, accountGeneration: current.first.accountGeneration },
      })
      expect(
        remote.requests.every((request) => request.headers.get("authorization") === "Bearer fixture-access-a"),
      ).toBe(true)
    }),
  )

  it.live("waits for human-required permission and dispatches only the original tool name", () =>
    Effect.gen(function* () {
      const remote = backend()
      const entered = yield* Deferred.make<Permission.AssertInput>()
      const approved = yield* Deferred.make<void>()
      const current = yield* client({
        backend: remote,
        permission: (value) => Deferred.succeed(entered, value).pipe(Effect.andThen(Deferred.await(approved))),
      })
      const [, send] = find(yield* current.service.tools({}), "send")
      const fiber = yield* Tool.settle(send, { input: { query: "synthetic" } }, context).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(entered)
      expect(request.requireExplicitDecision).toBe(true)
      expect(request.save).toBeUndefined()
      expect(request.resources).toEqual(["mail"])
      expect(request.metadata).toMatchObject({ connector: "mail", connectorLabel: "Mail", tool: "send" })
      expect(remote.requests.some((request) => request.body?.method === "tools/call")).toBe(false)
      yield* Deferred.succeed(approved, undefined)
      const result = yield* Fiber.join(fiber)
      expect(JSON.stringify(result)).toContain("synthetic-result")
      const params = remote.requests.find((request) => request.body?.method === "tools/call")?.body?.params
      expect(params).toHaveProperty("name", "send")
      expect(params).toHaveProperty("arguments", { query: "synthetic" })
      expect(params).toMatchObject({ _meta: { "io.modelcontextprotocol/clientInfo": { name: "ycoding" } } })
    }),
  )

  it.live("rechecks disablement after permission and does not dispatch", () =>
    Effect.gen(function* () {
      const remote = backend()
      let enabled = true
      const current = yield* client({
        backend: remote,
        settings: () => ({ ...settings, enabled }),
        permission: () =>
          Effect.sync(() => {
            enabled = false
          }),
      })
      const [, send] = find(yield* current.service.tools({}), "send")
      expect(
        Exit.isFailure(yield* Tool.settle(send, { input: { query: "synthetic" } }, context).pipe(Effect.exit)),
      ).toBe(true)
      expect(remote.requests.some((request) => request.body?.method === "tools/call")).toBe(false)
    }),
  )

  it.live("rechecks connector denial and captured account replacement before dispatch", () =>
    Effect.gen(function* () {
      const remote = backend()
      let denied = false
      const current = yield* client({
        backend: remote,
        settings: () => ({ enabled: true, connectors: { mail: denied ? "deny" : "allow", hidden: "deny" } }),
        permission: () =>
          Effect.sync(() => {
            denied = true
          }),
      })
      const [, send] = find(yield* current.service.tools({}), "send")
      expect(
        Exit.isFailure(yield* Tool.settle(send, { input: { query: "synthetic" } }, context).pipe(Effect.exit)),
      ).toBe(true)
      expect(remote.requests.some((request) => request.body?.method === "tools/call")).toBe(false)
      denied = false
      const [, search] = find(yield* current.service.tools({}), "search")
      yield* current.credentials.update(current.first.id, {
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: secondSource,
          refresh: "",
          expires: Number.MAX_SAFE_INTEGER,
          metadata: { authKind: "claude-code", managed: true, source: secondSource },
        }),
      })
      expect(
        Exit.isFailure(yield* Tool.settle(search, { input: { query: "synthetic" } }, context).pipe(Effect.exit)),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* current.service
            .tools({ binding: { credentialID: current.first.id, accountGeneration: current.first.accountGeneration } })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(remote.requests.some((request) => request.body?.method === "tools/call")).toBe(false)
    }),
  )

  it.live("refreshes only the same selected managed profile after an unclassified 401", () =>
    Effect.gen(function* () {
      const remote = backend({ unauthorized: true })
      const current = yield* client({ backend: remote })
      expect(yield* current.service.tools({})).toHaveLength(1)
      expect(current.refreshed).toEqual(["refresh"])
      expect(current.accesses.every((source) => source === firstSource)).toBe(true)
      expect(remote.requests[1].headers.get("authorization")).toBe("Bearer fixture-refreshed")
    }),
  )

  it.live("does not refresh or rotate accounts for classified proxy failures or entitlement rejection", () =>
    Effect.gen(function* () {
      for (const options of [{ unauthorized: true, classified: true }, { status: 403 }]) {
        const remote = backend(options)
        const current = yield* client({ backend: remote })
        expect(Exit.isFailure(yield* current.service.tools({}).pipe(Effect.exit))).toBe(true)
        expect(current.refreshed).toEqual([])
        expect(remote.requests).toHaveLength(1)
      }
    }),
  )

  it.live("validates input, output, tool failure, and guardrail denial", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote })
      const [, search] = find(yield* current.service.tools({}), "search")
      expect(Exit.isFailure(yield* Tool.settle(search, { input: { query: 1 } }, context).pipe(Effect.exit))).toBe(true)
      expect(current.assertions).toEqual([])
      for (const options of [{ invalidOutput: true }, { isError: true }]) {
        const faulty = backend(options)
        const selected = yield* client({ backend: faulty })
        const [, tool] = find(yield* selected.service.tools({}), "search")
        expect(
          Exit.isFailure(yield* Tool.settle(tool, { input: { query: "synthetic" } }, context).pipe(Effect.exit)),
        ).toBe(true)
      }
      const blocked = backend()
      const denied = yield* client({
        backend: blocked,
        guardrail: () =>
          Effect.fail(
            new SessionGuardrail.BlockedError({
              rootSessionID: context.sessionID,
              sessionID: context.sessionID,
              action: "mcp_execute",
              ruleIDs: ["fixture"],
              reason: "Synthetic denial",
            }),
          ),
      })
      const [, tool] = find(yield* denied.service.tools({}), "send")
      expect(
        Exit.isFailure(yield* Tool.settle(tool, { input: { query: "synthetic" } }, context).pipe(Effect.exit)),
      ).toBe(true)
      expect(blocked.requests.some((request) => request.body?.method === "tools/call")).toBe(false)
    }),
  )
})
