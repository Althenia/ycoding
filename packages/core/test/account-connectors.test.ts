import { describe, expect, test } from "bun:test"
import { createMcpHandler, Server } from "@modelcontextprotocol/server"
import type { FetchLike } from "@modelcontextprotocol/client"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { Credential } from "@ycoding-ai/core/credential"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Integration } from "@ycoding-ai/core/integration"
import { Permission } from "@ycoding-ai/core/permission"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { Tool } from "@ycoding-ai/core/tool/tool"
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventRuntime.node])))
const integrationID = Integration.ID.make("openai")
const methodID = Integration.MethodID.make("chatgpt-browser")
const context = {
  sessionID: SessionSchema.ID.make("ses_connectors"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_connectors"),
  callID: "call_connector",
  progress: () => Effect.void,
}
const settings = { enabled: true, connectors: { connector_hidden: "deny" as const } }
const tools = [
  {
    name: "mail_search",
    description: "Search synthetic mail",
    inputSchema: {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    outputSchema: { type: "object" as const, properties: { matched: { type: "number" } }, required: ["matched"] },
    _meta: { connector_id: "connector_mail", connector_name: "Mail" },
  },
  {
    name: "mail_send",
    description: "Send synthetic mail",
    inputSchema: { type: "object" as const, properties: { query: { type: "string" } }, required: ["query"] },
    annotations: { readOnlyHint: false },
    _meta: { connector_id: "connector_mail", connector_name: "Mail" },
  },
  {
    name: "hidden_search",
    inputSchema: { type: "object" as const },
    _meta: { connector_id: "connector_hidden", connector_name: "Hidden" },
  },
  {
    name: "uninstalled_setup",
    inputSchema: { type: "object" as const },
    _meta: { connector_id: "connector_uninstalled", _codex_apps: { synthetic_link: true } },
  },
]

function backend(
  options: {
    status?: number
    onceUnauthorized?: boolean
    isError?: boolean
    malformedIdentity?: boolean
    invalidOutput?: boolean
  } = {},
) {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "synthetic-account-connectors", version: "1" }, { capabilities: { tools: {} } })
    server.setRequestHandler("tools/list", async (request) => ({
      tools: request.params?.cursor
        ? [tools[1], tools[2], tools[3]]
        : [options.malformedIdentity ? { ...tools[0], _meta: {} } : tools[0]],
      ...(request.params?.cursor ? {} : { nextCursor: "synthetic-page-2" }),
    }))
    server.setRequestHandler("tools/call", async (request) => ({
      content: [
        {
          type: "text",
          text: options.isError ? "Synthetic connector failure" : `result:${request.params.arguments?.query}`,
        },
      ],
      structuredContent: { name: request.params.name, matched: options.invalidOutput ? "invalid" : 1 },
      isError: options.isError,
    }))
    return server
  })
  const fetcher: FetchLike = async (input, init) => {
    const request = new Request(input.toString(), init)
    const body = (await request.clone().json()) as Record<string, unknown>
    requests.push({ url: request.url, headers: request.headers, body })
    if (options.status) return new Response("Synthetic denied response", { status: options.status })
    if (options.onceUnauthorized && requests.length === 1) return new Response(null, { status: 401 })
    return handler.fetch(request)
  }
  return { requests, fetch: fetcher, close: () => handler.close() }
}

const profiles = Effect.fn(function* () {
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  const refreshed: string[] = []
  yield* integrations.transform((draft) =>
    draft.method.update({
      integrationID,
      method: { id: methodID, type: "oauth", label: "Synthetic ChatGPT" },
      authorize: () => Effect.die("Authentication must not be started"),
      refresh: (value) =>
        Effect.sync(() => {
          refreshed.push(value.access)
          return Credential.OAuth.make({ ...value, access: "fixture-refreshed", expires: Date.now() + 3_600_000 })
        }),
    }),
  )
  const first = yield* credentials.create({
    integrationID,
    label: "fixture-a",
    value: Credential.OAuth.make({
      type: "oauth",
      methodID,
      access: "fixture-access-a",
      refresh: "fixture-refresh-a",
      expires: Date.now() + 3_600_000,
      metadata: { accountID: "fixture-account-a" },
    }),
  })
  const second = yield* credentials.create({
    integrationID,
    label: "fixture-b",
    value: Credential.OAuth.make({
      type: "oauth",
      methodID,
      access: "fixture-access-b",
      refresh: "fixture-refresh-b",
      expires: Date.now() + 3_600_000,
      metadata: { accountID: "fixture-account-b" },
    }),
  })
  yield* credentials.activate(first.id)
  return { integrations, credentials, first, second, refreshed }
})

const client = Effect.fn(function* (input: {
  settings?: () => typeof settings | undefined
  backend: ReturnType<typeof backend>
  assert?: Permission.Interface["assert"]
  guardrail?: SessionGuardrail.Interface["assert"]
}) {
  const { AccountConnectors } = yield* Effect.promise(() => import("../src/account-connectors"))
  const profile = yield* profiles()
  const assertions: Permission.AssertInput[] = []
  const service = AccountConnectors.make({
    integration: profile.integrations,
    settings: () => Effect.sync(input.settings ?? (() => settings)),
    directory: "/synthetic-project",
    permission: {
      assert:
        input.assert ??
        ((value) =>
          Effect.sync(() => {
            assertions.push(value)
          })),
    },
    guardrail: { assert: input.guardrail ?? (() => Effect.succeed({ release: Effect.void })) },
    fetch: input.backend.fetch,
  })
  yield* Effect.addFinalizer(() => Effect.promise(input.backend.close))
  return { ...profile, service, assertions }
})

function find(registrations: ReadonlyArray<{ tools: Readonly<Record<string, Tool.AnyTool>> }>, description: string) {
  const found = registrations
    .flatMap((item) => Object.entries(item.tools))
    .find(([, tool]) => tool.description.includes(description))
  if (!found) throw new Error(`Missing synthetic tool: ${description}`)
  return found
}

describe("account connectors", () => {
  test("configuration retains opt-in profile and connector policy", () => {
    const value = { account_connectors: { chatgpt: { ...settings, profile: "fixture-a" } } }
    expect(Schema.decodeUnknownSync(Config.Info)(value)).toMatchObject(value)
  })

  test("new agents ask before account connector calls", () => {
    expect(
      Permission.evaluate("chatgpt_connector_mail_send", "*", Agent.Info.empty(Agent.ID.make("fixture")).permissions)
        .effect,
    ).toBe("ask")
  })

  it.live("disabled configuration makes no backend requests", () =>
    Effect.gen(function* () {
      for (const value of [undefined, { ...settings, enabled: false }]) {
        const remote = backend()
        const current = yield* client({ backend: remote, settings: () => value })
        expect(yield* current.service.tools({})).toEqual([])
        expect(remote.requests).toEqual([])
      }
    }),
  )

  it.live("discovers paginated schemas for the selected profile and excludes denied connectors", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote })
      const registrations = yield* current.service.tools({ profile: "fixture-b" })
      expect(registrations.flatMap((item) => Object.keys(item.tools))).toHaveLength(2)
      const [, search] = find(registrations, "Search synthetic mail")
      expect(Tool.definition("synthetic", search).inputSchema).toMatchObject(tools[0].inputSchema)
      expect(remote.requests.every((request) => request.url === "https://chatgpt.com/backend-api/ps/mcp")).toBe(true)
      expect(
        remote.requests.every((request) => request.headers.get("authorization") === "Bearer fixture-access-b"),
      ).toBe(true)
      expect(
        remote.requests.every((request) => request.headers.get("chatgpt-account-id") === "fixture-account-b"),
      ).toBe(true)
      expect(remote.requests.every((request) => request.headers.get("user-agent")?.startsWith("ycoding/"))).toBe(true)
      expect(
        remote.requests.every(
          (request) =>
            !request.headers.has("cookie") &&
            !request.headers.has("oai-did") &&
            !request.headers.has("x-openai-codex-window-type") &&
            !request.headers.has("x-openai-product-sku"),
        ),
      ).toBe(true)
      expect(remote.requests.filter((request) => request.body.method === "tools/list")).toHaveLength(2)
    }),
  )

  it.live("calls the original tool name and preserves structured and text results", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote })
      const [name, search] = find(yield* current.service.tools({}), "Search synthetic mail")
      const result = yield* Tool.settle(search, { input: { query: "synthetic" } }, context)
      expect(result).toMatchObject({
        structured: { name: "mail_search", matched: 1 },
        content: [{ type: "text", text: "result:synthetic" }],
      })
      expect(current.assertions).toMatchObject([
        {
          action: name,
          sessionID: context.sessionID,
          source: { type: "tool", messageID: context.messageID, callID: context.callID },
        },
      ])
      expect(remote.requests.find((request) => request.body.method === "tools/call")?.body.params).toMatchObject({
        name: "mail_search",
        arguments: { query: "synthetic" },
      })
    }),
  )

  it.live("waits for permission before sending a writing tool call", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const remote = backend()
      const current = yield* client({
        backend: remote,
        assert: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      })
      const [, send] = find(yield* current.service.tools({}), "Send synthetic mail")
      const running = yield* Tool.settle(send, { input: { query: "synthetic" } }, context).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      expect(remote.requests.some((request) => request.body.method === "tools/call")).toBe(false)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      expect(remote.requests.filter((request) => request.body.method === "tools/call")).toHaveLength(1)
    }),
  )

  it.live("rechecks configuration after permission and never calls a disabled connector", () =>
    Effect.gen(function* () {
      let enabled = true
      const remote = backend()
      const current = yield* client({
        backend: remote,
        settings: () => (enabled ? settings : undefined),
        assert: () =>
          Effect.sync(() => {
            enabled = false
          }),
      })
      const [, send] = find(yield* current.service.tools({}), "Send synthetic mail")
      expect(
        Exit.isFailure(yield* Tool.settle(send, { input: { query: "synthetic" } }, context).pipe(Effect.exit)),
      ).toBe(true)
      expect(remote.requests.some((request) => request.body.method === "tools/call")).toBe(false)
    }),
  )

  it.live("rejects captured tools after the active profile switches", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote })
      const [, search] = find(yield* current.service.tools({}), "Search synthetic mail")
      yield* current.credentials.activate(current.second.id)
      expect(
        Exit.isFailure(yield* Tool.settle(search, { input: { query: "synthetic" } }, context).pipe(Effect.exit)),
      ).toBe(true)
      expect(remote.requests.some((request) => request.body.method === "tools/call")).toBe(false)
    }),
  )

  it.live("refreshes the same profile once after a confirmed unauthorized response", () =>
    Effect.gen(function* () {
      const remote = backend({ onceUnauthorized: true })
      const current = yield* client({ backend: remote })
      expect((yield* current.service.tools({})).length).toBeGreaterThan(0)
      expect(current.refreshed).toEqual(["fixture-access-a"])
      expect(remote.requests[0].headers.get("authorization")).toBe("Bearer fixture-access-a")
      expect(remote.requests[1].headers.get("authorization")).toBe("Bearer fixture-refreshed")
    }),
  )

  it.live("stops on entitlement rejection without switching accounts or spoofing a desktop client", () =>
    Effect.gen(function* () {
      const remote = backend({ status: 403 })
      const current = yield* client({ backend: remote })
      expect(Exit.isFailure(yield* current.service.tools({}).pipe(Effect.exit))).toBe(true)
      expect(current.refreshed).toEqual([])
      expect(remote.requests).toHaveLength(1)
    }),
  )

  it.live("preserves connector failures instead of reporting successful output", () =>
    Effect.gen(function* () {
      const remote = backend({ isError: true })
      const current = yield* client({ backend: remote })
      const [, search] = find(yield* current.service.tools({}), "Search synthetic mail")
      expect(
        Exit.isFailure(yield* Tool.settle(search, { input: { query: "synthetic" } }, context).pipe(Effect.exit)),
      ).toBe(true)
      expect(remote.requests.filter((request) => request.body.method === "tools/call")).toHaveLength(1)
    }),
  )

  it.live("rejects missing profiles without using the active account", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote })
      expect(Exit.isFailure(yield* current.service.tools({ profile: "absent" }).pipe(Effect.exit))).toBe(true)
      expect(remote.requests).toEqual([])
    }),
  )

  it.live("retains the model's captured credential binding across global activation", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote })
      yield* current.credentials.activate(current.second.id)
      yield* current.service.tools({
        binding: { credentialID: current.first.id, accountGeneration: current.first.accountGeneration },
      })
      expect(
        remote.requests.every((request) => request.headers.get("authorization") === "Bearer fixture-access-a"),
      ).toBe(true)
    }),
  )

  it.live("rejects results outside the captured output schema", () =>
    Effect.gen(function* () {
      const remote = backend({ invalidOutput: true })
      const current = yield* client({ backend: remote })
      const [, search] = find(yield* current.service.tools({}), "Search synthetic mail")
      expect(
        Exit.isFailure(yield* Tool.settle(search, { input: { query: "synthetic" } }, context).pipe(Effect.exit)),
      ).toBe(true)
    }),
  )

  it.live("validates arguments before asking permission or dispatching", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote })
      const [, search] = find(yield* current.service.tools({}), "Search synthetic mail")
      expect(Exit.isFailure(yield* Tool.settle(search, { input: { query: 10 } }, context).pipe(Effect.exit))).toBe(true)
      expect(current.assertions).toEqual([])
      expect(remote.requests.some((request) => request.body.method === "tools/call")).toBe(false)
    }),
  )

  it.live("honors a guardrail denial before a connector side effect", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({
        backend: remote,
        guardrail: () =>
          Effect.fail(
            new SessionGuardrail.BlockedError({
              rootSessionID: context.sessionID,
              sessionID: context.sessionID,
              action: "mcp_execute",
              ruleIDs: ["fixture-deny"],
              reason: "Synthetic denial",
            }),
          ),
      })
      const [, send] = find(yield* current.service.tools({}), "Send synthetic mail")
      expect(
        Exit.isFailure(yield* Tool.settle(send, { input: { query: "synthetic" } }, context).pipe(Effect.exit)),
      ).toBe(true)
      expect(remote.requests.some((request) => request.body.method === "tools/call")).toBe(false)
    }),
  )

  it.live("does not expose tools without a connector identity", () =>
    Effect.gen(function* () {
      const remote = backend({ malformedIdentity: true })
      const current = yield* client({ backend: remote })
      expect(Exit.isFailure(yield* current.service.tools({}).pipe(Effect.exit))).toBe(true)
    }),
  )
})
