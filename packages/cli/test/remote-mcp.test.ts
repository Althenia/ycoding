import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import { RemoteLimits, remoteOperations } from "@ycoding-ai/remote"
import { LocalFailure, type LocalServer } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions, successFrames } from "../src/remote-operations"
import { createRemoteMcp, toolResult } from "../src/remote-mcp"
import { RemoteMcpSchemas } from "../src/remote-mcp-schemas"

const resource = "https://relay.example.com/api/mcp/devices/dev_1"
const context = { requestID: "request_fixture", epoch: "epoch_1", principal: { ownerID: "own_1", deviceID: "dev_1", clientID: "client_1" } }
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
}

const expectedTools = [
  "provider_auth_list", "provider_auth_key", "provider_auth_begin", "provider_auth_status", "provider_auth_complete", "provider_auth_cancel",
  "workspace_list", "workspace_catalog", "workspace_file_find", "session_list", "session_active", "session_get", "session_messages",
  "session_captured_changes_list", "session_compaction_list", "session_compact", "session_snapshot", "session_pending_list",
  "session_attachment_read", "session_todo_list", "session_subagent_list", "session_pin", "session_unpin", "session_subagent_cancel",
  "session_subagent_answer", "session_team_economics", "session_team_shell_list", "session_team_shell_kill", "session_side_chat_list",
  "session_side_chat_create", "session_family_activity", "session_log", "session_prompt", "session_interrupt", "session_prediction",
  "session_prompt_generate", "session_permission_list", "session_permission_reply", "session_guardrail_status",
  "session_guardrail_request_list", "session_guardrail_reply", "session_review_list", "session_review_decide", "session_form_list",
  "session_form_reply", "session_form_cancel", "session_shell_output", "session_autonomy_get", "session_autonomy_set", "session_goal_set",
  "session_goal_stop", "session_create", "session_status", "session_catalog", "session_file_find", "session_switch_model",
  "session_switch_agent", "session_command", "session_skill", "usage_providers", "usage_summary", "usage_report", "session_usage_report",
  "session_prompt_costs", "session_task_costs", "usage_forecast", "incident_report", "incident_recent", "incident_guidance",
  "incident_guidance_clear", "machine_keep_awake_get", "machine_keep_awake_set", "artifact_demo_preview", "artifact_demo_export",
  "local_app_register", "local_app_list", "local_app_revoke", "local_app_open", "local_app_status", "local_app_http", "session_create_in_directory",
]
const excludedOperations = [
  "session.subscribe", "session.unsubscribe", "session.message.stream", "session.attachment.upload",
  "machine.telemetry.consent.get", "machine.telemetry.consent.set", "machine.latency.append", "machine.latency.list",
]

function sessionInfo(id: string, directory = "/work"): SessionInfo {
  return {
    id, projectID: "prj_1", model: { providerID: "test", id: "model" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 }, title: id, location: { directory, workspaceID: undefined },
  } as unknown as SessionInfo
}

type Call = { readonly method: string; readonly args: readonly unknown[] }
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function fixture(results: Partial<Record<keyof LocalServer, unknown>> = {}, sessions = [sessionInfo("ses_1"), sessionInfo("ses_2")], verification: { verifyWindowMs?: number } = {}) {
  results.listPage ??= async () => ({ data: sessions })
  results.getSession ??= async (sessionID: string) => sessions.find((info) => info.id === sessionID)
  results.outstandingSessions ??= { data: [], running: [], failed: [], lost: [] }
  const calls: Call[] = []
  const local = new Proxy({} as LocalServer, {
    get: (_target, property: PropertyKey) => (...args: unknown[]) => {
      calls.push({ method: String(property), args })
      const result = results[property as keyof LocalServer]
      if (typeof result === "function") return Promise.resolve((result as (...a: unknown[]) => unknown)(...args))
      if (result instanceof Error) return Promise.reject(result)
      return Promise.resolve(result)
    },
  })
  const registry = createSessionRegistry({ local, ...verification })
  await registry.refresh()
  calls.length = 0
  const state = { allowed: true, now: 1000 }
  const holds: boolean[] = []
  const subscriptions = createSubscriptions()
  const create = () => {
    const created = createRemoteMcp({ local, sessions: registry, subscriptions, resource, allowed: (epoch) => state.allowed && epoch === context.epoch, now: () => state.now, onLaneHold: (held) => holds.push(held) })
    closers.push(() => created.close())
    return created
  }
  const mcp = create()
  let current = mcp
  const restart = async () => {
    await current.close()
    current = create()
  }
  const request = (method: string, params: Record<string, unknown>, init: { name?: string; signal?: AbortSignal; body?: BodyInit; url?: string; verb?: string } = {}) =>
    current.fetch(
      new Request(init.url ?? resource, {
        method: init.verb ?? "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(init.name === undefined ? {} : { "mcp-name": init.name }),
        },
        body: init.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      }),
      context,
    )
  const tool = (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
    request("tools/call", { name, arguments: args }, { name, ...(signal === undefined ? {} : { signal }) })
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await tool(name, args)
    expect(response.status).toBe(200)
    return ((await response.json()) as { result: { isError?: boolean; structuredContent?: unknown; content: { text: string }[] } }).result
  }
  return { mcp, calls, state, request, tool, run, results, holds, restart }
}

describe("inventory and discovery", () => {
  test("serves discovery and lists exactly the closed mapping with full typed schemas", async () => {
    const { request } = await fixture()
    const discovered = await request("server/discover", {})
    expect(discovered.status).toBe(200)
    const listed = (await (await request("tools/list", {})).json()) as { result: { tools: { name: string; inputSchema: Record<string, unknown> }[] } }
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(expectedTools)
    for (const tool of listed.result.tools) {
      expect(tool.inputSchema.type).toBe("object")
      if (tool.name !== "usage_forecast") expect(tool.inputSchema.additionalProperties).toBe(false)
    }
    const operations = RemoteMcpSchemas.tools.map((tool) => tool.operation).filter((operation) => operation !== "session.createInDirectory")
    expect(operations.map(String).toSorted()).toEqual(remoteOperations.filter((operation) => !excludedOperations.includes(operation)).map(String).toSorted())
    expect(RemoteMcpSchemas.tools.at(-1)?.operation).toBe("session.createInDirectory")
    expect(new Set(expectedTools).size).toBe(81)
  })

  test("session-scoped tools require sessionID and parameterless ones publish no input", async () => {
    type InputSchema = { required?: string[]; properties?: Record<string, InputSchema>; oneOf?: InputSchema[]; allOf?: InputSchema[] }
    const schemas = new Map(RemoteMcpSchemas.tools.map((tool) => [tool.name, tool.inputSchema as InputSchema]))
    expect(schemas.get("session_get")).toMatchObject({ required: ["sessionID"], properties: { sessionID: { type: "string" } } })
    expect(schemas.get("session_get")?.properties?.input).toBeUndefined()
    expect(schemas.get("session_prompt")?.required).toEqual(["sessionID", "input"])
    expect(schemas.get("session_prompt")?.properties?.input?.required).toEqual(["id", "text"])
    expect(schemas.get("session_create")?.required).toEqual(["input"])
    expect(schemas.get("session_create")?.properties?.input?.required).toEqual(["id", "workspace"])
    expect(schemas.get("provider_auth_key")?.properties?.sessionID).toBeUndefined()
    expect(schemas.get("provider_auth_key")?.properties?.input?.properties?.target?.oneOf).toHaveLength(2)
    expect(schemas.get("incident_guidance")?.required).toEqual(["input"])
    expect(schemas.get("incident_guidance")?.properties?.sessionID).toBeDefined()
    expect(schemas.get("workspace_list")?.required).toBeUndefined()
    expect(schemas.get("usage_forecast")?.allOf).toHaveLength(1)
  })
})

describe("fixed artifact demo over authorized Relay MCP", () => {
  test("discovers only fixed resources and exports original PNG bytes without accessing a Session", async () => {
    const { request, run, calls } = await fixture()
    const catalog = await (await request("tools/list", {})).json() as { result: { tools: { name: string; _meta?: unknown; outputSchema?: unknown }[] } }
    expect(catalog.result.tools.find((tool) => tool.name === "artifact_demo_preview")).toMatchObject({ _meta: { ui: { resourceUri: "ui://ycoding/artifact-demo/v1.html" } } })
    expect(catalog.result.tools.find((tool) => tool.name === "artifact_demo_export")?._meta).toBeUndefined()
    expect(catalog.result.tools.filter((tool) => tool.name.startsWith("artifact_demo_")).every((tool) => tool.outputSchema !== undefined)).toBe(true)
    expect((await run("artifact_demo_preview")).structuredContent).toMatchObject({ variants: ["list", "cards"], hostVerification: "required" })
    const exported = await run("artifact_demo_export")
    expect(exported.structuredContent).toMatchObject({ filename: "ycoding-demo.png", mime: "image/png", size: 79, sha256: "d3a97d031a3094c93d334c8e01e97c5a235ae1f44d5aab476d51311f16f0bce5", expiresAt: 901000 })
    const link = exported.content[0] as unknown as { type: string; uri: string }
    expect(link.type).toBe("resource_link")
    const read = async (uri: string) => (await (await request("resources/read", { uri }, { name: uri })).json()) as { result: { contents: { uri: string; mimeType: string; blob?: string; text?: string; _meta?: unknown }[] } }
    const png = (await read(link.uri)).result.contents[0]
    const bytes = Buffer.from(png.blob ?? "", "base64")
    expect(bytes.length).toBe(79)
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("d3a97d031a3094c93d334c8e01e97c5a235ae1f44d5aab476d51311f16f0bce5")
    expect(JSON.stringify(exported)).not.toContain(png.blob!)
    expect((await read(link.uri)).result.contents[0]).toEqual(png)
    const html = (await read("ui://ycoding/artifact-demo/v1.html")).result.contents[0]
    expect(html).toMatchObject({ mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } })
    expect(html.text).toContain("ui/initialize")
    const listed = await (await request("resources/list", {})).json() as { result: { resources: { uri: string }[] } }
    expect(listed.result.resources.map((item) => item.uri)).toEqual([html.uri, png.uri])
    expect(await (await request("resources/templates/list", {})).json()).toMatchObject({ result: { resourceTemplates: [] } })
    expect(calls.every((call) => call.method === "mcpEventsStatus")).toBe(true)
  })

  test("rejects paths, caller-selected Sessions and unknown resources; expiry never renews on retry", async () => {
    const { run, request, state, calls } = await fixture()
    for (const name of ["artifact_demo_preview", "artifact_demo_export"]) for (const args of [{ path: "/etc/passwd" }, { sessionID: "ses_1" }, { input: { uri: "file:///etc/passwd" } }])
      expect((await run(name, args)).isError).toBe(true)
    for (const uri of ["file:///etc/passwd", "ui://ycoding/artifact-demo/../../secret", "artifact://ycoding-demo/unknown"])
      expect(await (await request("resources/read", { uri }, { name: uri })).json()).toMatchObject({ error: { code: -32602, data: { uri } } })
    const exported = await run("artifact_demo_export")
    const uri = (exported.content[0] as unknown as { uri: string }).uri
    state.now = 901000
    expect((await run("artifact_demo_export")).isError).toBe(true)
    expect(await (await request("resources/read", { uri }, { name: uri })).json()).toMatchObject({ error: { code: -32602, data: { uri } } })
    expect(await (await request("resources/list", {})).json()).toMatchObject({ result: { resources: [{ uri: "ui://ycoding/artifact-demo/v1.html" }] } })
    expect(calls.every((call) => call.method === "mcpEventsStatus")).toBe(true)
  })

  test.each(["tools/list", "resources/list", "resources/templates/list", "resources/read", "tools/call"])("rechecks authority after asynchronous admission for %s", async (method) => {
    const { request, state, calls } = await fixture()
    const started = Promise.withResolvers<void>()
    const body = Promise.withResolvers<void>()
    const params = method === "resources/read" ? { uri: "ui://ycoding/artifact-demo/v1.html" } : method === "tools/call" ? { name: "artifact_demo_export", arguments: {} } : {}
    const target = "uri" in params ? params.uri : "name" in params ? params.name : undefined
    const pending = request(method, params, { ...(target === undefined ? {} : { name: target }), body: new ReadableStream({ async start(controller) {
      started.resolve()
      await body.promise
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } })))
      controller.close()
    } }) })
    await started.promise
    state.allowed = false
    body.resolve()
    expect((await pending).status).toBe(503)
    expect(calls).toEqual([])
  })

  test("cancelled and closed resource reads disclose no bytes, and a safe read retry retains identity", async () => {
    const { request, run, mcp } = await fixture()
    const exported = await run("artifact_demo_export")
    const uri = (exported.content[0] as unknown as { uri: string }).uri
    const controller = new AbortController()
    controller.abort()
    expect((await request("resources/read", { uri }, { name: uri, signal: controller.signal })).status).toBe(503)
    const retry = await request("resources/read", { uri }, { name: uri })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ result: { contents: [{ uri, mimeType: "image/png" }] } })
    await mcp.close()
    expect((await request("resources/read", { uri }, { name: uri })).status).toBe(503)
  })
})

describe("tool calls run the connector operations", () => {
  test("provider_auth_list accepts only its target and reaches the connector listing", async () => {
    const { run, calls } = await fixture({ providerIntegrations: [], integrationList: [] })
    const result = await run("provider_auth_list", { input: { target: { sessionID: "ses_1" } } })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ data: [] })
    expect(calls.filter((call) => call.method === "integrationList")).toHaveLength(1)
    expect((await run("provider_auth_list", { input: { target: { sessionID: "ses_1" }, integrationID: "extra" } })).isError).toBe(true)
  })

  test("returns the complete connector value as structured content and matching text", async () => {
    const { run } = await fixture()
    const result = await run("session_get", { sessionID: "ses_1" })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ data: { id: "ses_1" } })
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent)
  })

  test("refuses inputs the published schema does not allow before Session operations", async () => {
    const { run, calls } = await fixture()
    for (const args of [{}, { sessionID: "ses_1", input: {} }, { sessionID: "ses_1", extra: 1 }, { sessionID: "bad id" }]) {
      expect((await run("session_get", args)).isError).toBe(true)
    }
    expect((await run("session_prompt", { sessionID: "ses_1", input: { text: "hi" } })).isError).toBe(true)
    expect((await run("session_create", { input: { workspace: "wsp_1" } })).isError).toBe(true)
    expect((await run("session_list", { sessionID: "ses_1" })).isError).toBe(true)
    expect((await run("provider_auth_list", { sessionID: "ses_1", input: { target: { sessionID: "ses_1" } } })).isError).toBe(true)
    expect(calls.every((call) => call.method === "mcpEventsStatus")).toBe(true)
  })

  test("session_prompt passes the client id unchanged and reports an unconfirmed outcome without replay", async () => {
    const { run, calls, results } = await fixture({ prompt: { id: "msg_one" } })
    const sent = await run("session_prompt", { sessionID: "ses_1", input: { id: "msg_one", text: "hi" } })
    expect(sent.structuredContent).toEqual({ data: { id: "msg_one" } })
    expect(calls.find((call) => call.method === "prompt")?.args).toEqual(["ses_1", { directory: "/work" }, { id: "msg_one", text: "hi" }])
    results.prompt = new LocalFailure("transport", "no response")
    const unknown = await run("session_prompt", { sessionID: "ses_1", input: { id: "msg_two", text: "hi" } })
    expect(unknown.isError).toBe(true)
    expect(unknown.structuredContent).toEqual({ error: { code: "outcome_unknown", message: expect.any(String) } })
    expect(unknown.content[0]!.text).toContain("Inspect the Session's current state")
    expect(calls.filter((call) => call.method === "prompt")).toHaveLength(2)
  })

  test("usage_forecast ties the Location scope to sessionID", async () => {
    const { run, calls } = await fixture({ usageForecast: { data: { ok: true } } })
    expect((await run("usage_forecast", { input: { localScope: "backend" } })).structuredContent).toEqual({ data: { ok: true } })
    expect((await run("usage_forecast", { sessionID: "ses_1", input: { localScope: "location" } })).isError).toBeUndefined()
    expect((await run("usage_forecast", { input: { localScope: "location" } })).isError).toBe(true)
    expect((await run("usage_forecast", { sessionID: "ses_1", input: { localScope: "backend" } })).isError).toBe(true)
    expect(calls.filter((call) => call.method === "usageForecast").map((call) => call.args)).toEqual([["backend"], ["location", { directory: "/work" }]])
  })

  test("incident guidance keeps its optional Session and resolves its Location through the connector", async () => {
    const { run, calls } = await fixture({ incidentGuidance: { guidance: null } })
    await run("incident_guidance", { input: { provider: "p", model: "m" } })
    await run("incident_guidance", { sessionID: "ses_1", input: { provider: "p", model: "m" } })
    expect(calls.filter((call) => call.method === "incidentGuidance").map((call) => call.args)).toEqual([
      [{ provider: "p", model: "m" }],
      [{ provider: "p", model: "m" }, { directory: "/work" }],
    ])
  })

  test("create tools require the client id and keep the existing workspace rule", async () => {
    const { run, calls } = await fixture({ projectList: [], projectDirectories: [] })
    const result = await run("session_create", { input: { id: "ses_new", workspace: "wsp_missing" } })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: "invalid_message" } })
    expect(calls.some((call) => call.method === "createSession")).toBe(false)
  })
})

describe("routing descriptors", () => {
  const tool = (name: string) => RemoteMcpSchemas.tools.find((item) => item.name === name)!
  test.each([
    ["session_prompt", { sessionID: "ses_1", input: {} }, "session:ses_1"],
    ["session_get", { sessionID: "ses_1" }, undefined],
    ["session_create", { input: { id: "ses_new", workspace: "w" } }, "session:ses_new"],
    ["session_create_in_directory", { input: { id: "ses_dir", directory: "/x" } }, "session:ses_dir"],
    ["session_side_chat_create", { sessionID: "ses_1", input: { id: "ses_side" } }, "session:ses_1"],
    ["provider_auth_key", { input: { target: { sessionID: "ses_9" } } }, "session:ses_9"],
    ["provider_auth_key", { input: { target: { workspace: "wsp_1" } } }, "backend"],
    ["incident_guidance_clear", { sessionID: "ses_1", input: {} }, "session:ses_1"],
    ["incident_guidance_clear", { input: {} }, "backend"],
    ["machine_keep_awake_set", { input: { enabled: true } }, "backend"],
    ["machine_keep_awake_get", {}, undefined],
    ["session_interrupt", { sessionID: "ses_1" }, "session:ses_1"],
  ])("%s -> %p lane %p", (name, args, lane) => {
    expect(RemoteMcpSchemas.laneOf(tool(name), args)).toBe(lane)
  })
})

describe("result conversion", () => {
  test("names the machine update for an operation an older connector does not know", () => {
    const result = toolResult([{ type: "response", id: "r", ok: false, error: { code: "unknown_operation", message: "Operation is not proxied by this agent" } }])
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("Update YCoding on this machine")
  })

  test("reassembles a chunked response completely", () => {
    const value = { data: "x".repeat(RemoteLimits.maxAgentMessageChars + 5_000) }
    const frames = successFrames("r", value)
    expect(frames.length).toBeGreaterThan(1)
    const result = toolResult(frames, 10_000_000)
    expect(result.structuredContent).toEqual(value)
    expect(JSON.parse(result.content[0]!.text)).toEqual(value)
  })

  test("fails explicitly past the result bound and for incomplete chunk sequences", () => {
    const frames = successFrames("r", { data: "x".repeat(RemoteLimits.maxAgentMessageChars + 5_000) })
    expect(toolResult(frames, 1_000).structuredContent).toEqual({ error: { code: "message_too_large", message: expect.any(String) } })
    expect(toolResult(frames.slice(0, 1), 10_000_000).structuredContent).toEqual({ error: { code: "internal_error", message: expect.any(String) } })
    expect(toolResult(successFrames("r", { data: "y".repeat(2_000) }), 1_000).structuredContent).toEqual({ error: { code: "message_too_large", message: expect.any(String) } })
  })
})

describe("mutation ordering", () => {
  test("a missing baseline model does not prove that an uncertain explicit profile binding completed", async () => {
    const target = { providerID: "synthetic", id: "model-next", profile: "synthetic-account" }
    const selected: { model?: typeof target } = {}
    const { run, calls, holds } = await fixture({
      getSession: async (sessionID: string) => ({ ...sessionInfo(sessionID), model: selected.model }),
      switchModel: async () => {
        selected.model = target
        throw new LocalFailure("transport", "The profile binding response was lost")
      },
      interrupt: async () => {},
    })
    expect((await run("session_switch_model", { sessionID: "ses_1", input: { model: target } })).isError).toBe(true)
    expect((await run("session_interrupt", { sessionID: "ses_1" })).structuredContent).toMatchObject({ error: { code: "outcome_unknown" } })
    expect(calls.filter((call) => call.method === "interrupt")).toEqual([])
    expect(holds).toEqual([true])
  })

  test("a verification failure before dispatch does not hold a mutation lane", async () => {
    const state = { unavailable: false }
    const { run, calls, holds } = await fixture({
      getSession: async (sessionID: string) => {
        if (state.unavailable) throw new LocalFailure("transport", "The verification read failed")
        return sessionInfo(sessionID)
      },
      interrupt: async () => {},
    })
    state.unavailable = true
    expect((await run("session_interrupt", { sessionID: "ses_1" })).structuredContent).toMatchObject({ error: { code: "internal_error" } })
    expect(calls.filter((call) => call.method === "interrupt")).toEqual([])
    expect(holds).toEqual([])
    state.unavailable = false
    expect((await run("session_interrupt", { sessionID: "ses_1" })).isError).toBeUndefined()
    expect(calls.filter((call) => call.method === "interrupt")).toHaveLength(1)
  })

  test("an uncertain mutation blocks its lane while reads and other Sessions remain usable", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const { tool, run, calls } = await fixture({
      prompt: async (sessionID: string) => {
        if (sessionID !== "ses_1") return { id: "msg_other" }
        started.resolve()
        await release.promise
        throw new LocalFailure("transport", "Local deadline expired")
      },
      interrupt: async () => {},
    })
    const first = tool("session_prompt", { sessionID: "ses_1", input: { id: "msg_unknown", text: "Synthetic input" } })
    await started.promise
    const next = tool("session_interrupt", { sessionID: "ses_1" })
    release.resolve()
    expect((await (await first).json()).result.isError).toBe(true)
    const queued = await (await next).json()
    expect(queued.result.isError).toBe(true)
    expect(queued.result.content[0].text).toContain("Inspect")
    expect((await run("session_interrupt", { sessionID: "ses_1" })).isError).toBe(true)
    expect(calls.filter((call) => call.method === "interrupt")).toEqual([])
    expect((await run("session_get", { sessionID: "ses_1" })).isError).toBeUndefined()
    expect((await run("session_prompt", { sessionID: "ses_2", input: { id: "msg_other", text: "Other Session" } })).isError).toBeUndefined()
  })

  test("holds a Session's mutation lane through settlement while other Sessions and reads proceed", async () => {
    const order: string[] = []
    const firstStarted = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<{ id: string }>()
    const { tool, run } = await fixture({
      prompt: (sessionID: string, _location: unknown, input: { id: string }) => {
        order.push(`prompt:${sessionID}:${input.id}`)
        if (input.id === "msg_slow") {
          firstStarted.resolve()
          return releaseFirst.promise
        }
        return { id: input.id }
      },
      interrupt: (sessionID: string) => {
        order.push(`interrupt:${sessionID}`)
      },
    })
    const slow = tool("session_prompt", { sessionID: "ses_1", input: { id: "msg_slow", text: "a" } })
    await firstStarted.promise
    const interrupt = tool("session_interrupt", { sessionID: "ses_1" })
    expect((await run("session_prompt", { sessionID: "ses_2", input: { id: "msg_other", text: "b" } })).isError).toBeUndefined()
    expect((await run("session_get", { sessionID: "ses_1" })).isError).toBeUndefined()
    expect(order).toEqual(["prompt:ses_1:msg_slow", "prompt:ses_2:msg_other"])
    releaseFirst.resolve({ id: "msg_slow" })
    expect((await (await slow).json()) as unknown).toBeDefined()
    expect((await interrupt).status).toBe(200)
    expect(order).toEqual(["prompt:ses_1:msg_slow", "prompt:ses_2:msg_other", "interrupt:ses_1"])
  })

  test("orders same-Session mutations by arrival even when the first body is delayed", async () => {
    const order: string[] = []
    const { request } = await fixture({
      prompt: (_sessionID: string, _location: unknown, input: { id: string }) => {
        order.push(input.id)
        return { id: input.id }
      },
    })
    const body = (id: string) =>
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session_prompt", arguments: { sessionID: "ses_1", input: { id, text: "t" } }, _meta: meta } })
    const delayed = new TransformStream<Uint8Array>()
    const writer = delayed.writable.getWriter()
    const first = request("tools/call", {}, { name: "session_prompt", body: delayed.readable })
    const second = request("tools/call", {}, { name: "session_prompt", body: body("msg_b") })
    await Bun.sleep(10)
    expect(order).toEqual([])
    await writer.write(new TextEncoder().encode(body("msg_a")))
    await writer.close()
    await Promise.all([first, second])
    expect(order).toEqual(["msg_a", "msg_b"])
  })

  test("an aborted queued request is never dispatched and does not break the lane", async () => {
    const order: string[] = []
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<{ id: string }>()
    const { tool } = await fixture({
      prompt: (_sessionID: string, _location: unknown, input: { id: string }) => {
        order.push(input.id)
        if (input.id === "msg_a") {
          started.resolve()
          return release.promise
        }
        return { id: input.id }
      },
    })
    const args = (id: string) => ({ sessionID: "ses_1", input: { id, text: "t" } })
    const first = tool("session_prompt", args("msg_a"))
    await started.promise
    const controller = new AbortController()
    const queued = tool("session_prompt", args("msg_b"), controller.signal).catch(() => undefined)
    const third = tool("session_prompt", args("msg_c"))
    controller.abort()
    await queued
    release.resolve({ id: "msg_a" })
    await first
    expect((await third).status).toBe(200)
    expect(order).toEqual(["msg_a", "msg_c"])
  })
})

describe("unknown outcome holds", () => {
  type Result = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["run"]>>
  const target = { providerID: "test", id: "next", variant: "high" }
  const unknown = () => {
    throw new LocalFailure("transport", "Local deadline expired")
  }
  const sessionsWith = (model: Record<string, string>) => [{ ...sessionInfo("ses_1"), model } as unknown as SessionInfo, sessionInfo("ses_2")]
  const select = (sessions: SessionInfo[], model: Record<string, string>) => {
    sessions[0] = { ...sessions[0], model } as unknown as SessionInfo
  }
  const count = (calls: Call[], method: string) => calls.filter((call) => call.method === method).length
  const codeOf = (result: Result) => (result.structuredContent as { error?: { code: string } } | null)?.error?.code
  const switchTo = (model: Record<string, string>) => ({ sessionID: "ses_1", input: { model } })
  const promptWith = (id: string) => ({ sessionID: "ses_1", input: { id, text: "Synthetic input" } })

  test("a fresh read showing the requested model after a late switch settles the hold and later mutations dispatch", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const { run, calls, holds } = await fixture({ switchModel: unknown, prompt: { id: "msg_after" } }, sessions)
    expect(codeOf(await run("session_switch_model", switchTo(target)))).toBe("outcome_unknown")
    expect(holds).toEqual([true])
    select(sessions, target)
    expect((await run("session_prompt", promptWith("msg_after"))).isError).toBeUndefined()
    expect(count(calls, "prompt")).toBe(1)
    expect(count(calls, "switchModel")).toBe(1)
    expect(holds).toEqual([true, false])
  })

  test("repeating the held switch answers only from a fresh read and never dispatches it again", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const { run, calls, holds } = await fixture({ switchModel: unknown }, sessions)
    await run("session_switch_model", switchTo(target))
    const unconfirmed = await run("session_switch_model", switchTo(target))
    expect(codeOf(unconfirmed)).toBe("outcome_unknown")
    expect(unconfirmed.content[0]!.text).toContain("not executed")
    select(sessions, target)
    const confirmed = await run("session_switch_model", switchTo(target))
    expect(confirmed.isError).toBeUndefined()
    expect(confirmed.content[0]!.text).toBe("null")
    expect(count(calls, "switchModel")).toBe(1)
    expect(holds).toEqual([true, false])
  })

  test.each([
    ["variant absent", { providerID: "test", id: "next", profile: "work" }],
    ["variant differs", { providerID: "test", id: "next", variant: "low", profile: "work" }],
    ["profile absent", { providerID: "test", id: "next", variant: "high" }],
    ["profile differs", { providerID: "test", id: "next", variant: "high", profile: "home" }],
    ["model differs", { providerID: "test", id: "other", variant: "high", profile: "work" }],
    ["provider differs", { providerID: "other", id: "next", variant: "high", profile: "work" }],
  ])("a selected model that is not exactly the target (%s) keeps the Session held", async (_name, selected) => {
    const requested = { providerID: "test", id: "next", variant: "high", profile: "work" }
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const { run, calls, holds } = await fixture({ switchModel: unknown, prompt: { id: "msg_after" } }, sessions)
    await run("session_switch_model", switchTo(requested))
    select(sessions, selected)
    const refused = await run("session_prompt", promptWith("msg_after"))
    expect(codeOf(refused)).toBe("outcome_unknown")
    expect(refused.content[0]!.text).toContain("not executed")
    expect(codeOf(await run("session_switch_model", switchTo(requested)))).toBe("outcome_unknown")
    expect(count(calls, "prompt")).toBe(0)
    expect(count(calls, "switchModel")).toBe(1)
    expect(holds).toEqual([true])
  })

  test("an explicit profile already selected before the switch is a rebind that no later read confirms", async () => {
    const requested = { providerID: "test", id: "next", profile: "work" }
    const sessions = sessionsWith(requested)
    const { run, calls, holds } = await fixture({ switchModel: unknown, prompt: { id: "msg_after" } }, sessions)
    expect(codeOf(await run("session_switch_model", switchTo(requested)))).toBe("outcome_unknown")
    expect(codeOf(await run("session_switch_model", switchTo(requested)))).toBe("outcome_unknown")
    expect(codeOf(await run("session_prompt", promptWith("msg_after")))).toBe("outcome_unknown")
    expect(count(calls, "switchModel")).toBe(1)
    expect(count(calls, "prompt")).toBe(0)
    expect(holds).toEqual([true])
  })

  test("a switch whose Session cannot be read is refused before dispatch and does not hold the Session", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const gate = { unreadable: false }
    const { run, calls, holds } = await fixture({
      getSession: (sessionID: string) => {
        if (gate.unreadable) {
          gate.unreadable = false
          throw new LocalFailure("transport", "Local server unreachable")
        }
        return sessions.find((info) => info.id === sessionID)
      },
      switchModel: undefined,
      prompt: { id: "msg_after" },
    }, sessions)
    gate.unreadable = true
    const refused = await run("session_switch_model", switchTo(target))
    expect(refused.isError).toBe(true)
    expect(codeOf(refused)).toBe("internal_error")
    expect(count(calls, "switchModel")).toBe(0)
    expect((await run("session_prompt", promptWith("msg_after"))).isError).toBeUndefined()
    expect(holds).toEqual([])
  })

  test("only a retry with the held prompt's own ID passes the hold, and its admission settles the hold", async () => {
    const attempts: string[] = []
    const { run, calls, holds } = await fixture({
      prompt: (_sessionID: string, _location: unknown, input: { id: string }) => {
        attempts.push(input.id)
        if (attempts.length === 1) throw new LocalFailure("transport", "Local deadline expired")
        return { id: input.id }
      },
      interrupt: undefined,
    })
    expect(codeOf(await run("session_prompt", promptWith("msg_held")))).toBe("outcome_unknown")
    const other = await run("session_prompt", promptWith("msg_other"))
    expect(codeOf(other)).toBe("outcome_unknown")
    expect(other.content[0]!.text).toContain("msg_held")
    expect(codeOf(await run("session_interrupt", { sessionID: "ses_1" }))).toBe("outcome_unknown")
    expect((await run("session_prompt", promptWith("msg_held"))).isError).toBeUndefined()
    expect(attempts).toEqual(["msg_held", "msg_held"])
    expect((await run("session_interrupt", { sessionID: "ses_1" })).isError).toBeUndefined()
    expect(count(calls, "interrupt")).toBe(1)
    expect(holds).toEqual([true, false])
  })

  test("a held prompt retry that fails or stays unknown keeps the Session held", async () => {
    const failures = [new LocalFailure("transport", "Local deadline expired"), new LocalFailure("invalid", "Rejected"), new LocalFailure("transport", "Local deadline expired")]
    const attempts: string[] = []
    const { run, holds } = await fixture({
      prompt: (_sessionID: string, _location: unknown, input: { id: string }) => {
        attempts.push(input.id)
        const failure = failures.shift()
        if (failure !== undefined) throw failure
        return { id: input.id }
      },
    })
    expect(codeOf(await run("session_prompt", promptWith("msg_held")))).toBe("outcome_unknown")
    expect(codeOf(await run("session_prompt", promptWith("msg_held")))).toBe("invalid_message")
    expect(codeOf(await run("session_prompt", promptWith("msg_held")))).toBe("outcome_unknown")
    expect(codeOf(await run("session_prompt", promptWith("msg_other")))).toBe("outcome_unknown")
    expect(attempts).toEqual(["msg_held", "msg_held", "msg_held"])
    expect(holds).toEqual([true])
  })

  test("an unknown interrupt holds every other mutation of its Session, including any prompt ID, while reads and other Sessions continue", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const { run, calls, holds } = await fixture({
      interrupt: (sessionID: string) => {
        if (sessionID === "ses_1") unknown()
      },
      prompt: { id: "msg_any" },
      switchModel: undefined,
    }, sessions)
    expect(codeOf(await run("session_interrupt", { sessionID: "ses_1" }))).toBe("outcome_unknown")
    select(sessions, target)
    expect(codeOf(await run("session_interrupt", { sessionID: "ses_1" }))).toBe("outcome_unknown")
    expect(codeOf(await run("session_prompt", promptWith("msg_any")))).toBe("outcome_unknown")
    expect(codeOf(await run("session_switch_model", switchTo(target)))).toBe("outcome_unknown")
    expect(count(calls, "interrupt")).toBe(1)
    expect(count(calls, "prompt")).toBe(0)
    expect(count(calls, "switchModel")).toBe(0)
    expect((await run("session_get", { sessionID: "ses_1" })).isError).toBeUndefined()
    expect((await run("session_interrupt", { sessionID: "ses_2" })).isError).toBeUndefined()
    expect(holds).toEqual([true])
  })

  test("a mutation queued behind an unknown switch runs only after a fresh read confirms the requested model", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const { tool, calls } = await fixture({
      switchModel: async (_sessionID: string, _location: unknown, model: Record<string, string>) => {
        started.resolve()
        await release.promise
        select(sessions, model)
        unknown()
      },
      prompt: { id: "msg_queued" },
    }, sessions)
    const first = tool("session_switch_model", switchTo(target))
    await started.promise
    const queued = tool("session_prompt", promptWith("msg_queued"))
    release.resolve()
    expect(((await (await first).json()) as { result: Result }).result.structuredContent).toMatchObject({ error: { code: "outcome_unknown" } })
    expect(((await (await queued).json()) as { result: Result }).result.isError).toBeUndefined()
    expect(count(calls, "prompt")).toBe(1)
  })

  test("revoked authorization refuses a queued mutation of a held Session before any confirmation read", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const { tool, calls, state } = await fixture({
      switchModel: async (_sessionID: string, _location: unknown, model: Record<string, string>) => {
        started.resolve()
        await release.promise
        select(sessions, model)
        unknown()
      },
      prompt: { id: "msg_queued" },
    }, sessions)
    const first = tool("session_switch_model", switchTo(target))
    await started.promise
    const queued = tool("session_prompt", promptWith("msg_queued"))
    state.allowed = false
    const mark = calls.length
    release.resolve()
    await first
    expect(((await (await queued).json()) as { result: Result }).result.structuredContent).toMatchObject({ error: { code: "agent_unavailable" } })
    expect(calls.slice(mark).map((call) => call.method)).toEqual([])
  })

  test("the confirmation read bypasses the Session verification window", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const { run, holds } = await fixture({ switchModel: unknown, prompt: { id: "msg_after" } }, sessions, { verifyWindowMs: 3_600_000 })
    expect((await run("session_get", { sessionID: "ses_1" })).isError).toBeUndefined()
    await run("session_switch_model", switchTo(target))
    select(sessions, target)
    expect((await run("session_prompt", promptWith("msg_after"))).isError).toBeUndefined()
    expect(holds).toEqual([true, false])
  })

  test("a restarted endpoint starts without holds and never replays the earlier call", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const { run, calls, holds, restart } = await fixture({ switchModel: unknown, prompt: { id: "msg_after" } }, sessions)
    await run("session_switch_model", switchTo(target))
    await restart()
    expect(holds).toEqual([true, false])
    expect((await run("session_prompt", promptWith("msg_after"))).isError).toBeUndefined()
    expect(count(calls, "switchModel")).toBe(1)
  })
})

describe("authorization gate and request shape", () => {
  test("refuses with 503 and no local call when the epoch is not allowed or the endpoint is closed", async () => {
    const { tool, state, calls, mcp } = await fixture()
    state.allowed = false
    expect((await tool("session_get", { sessionID: "ses_1" })).status).toBe(503)
    state.allowed = true
    await mcp.close()
    expect((await tool("session_get", { sessionID: "ses_1" })).status).toBe(503)
    expect(calls).toEqual([])
  })

  test("rechecks authorization when a queued mutation reaches dispatch", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<{ id: string }>()
    const { tool, state, calls } = await fixture({
      prompt: (_sessionID: string, _location: unknown, input: { id: string }) => {
        if (input.id === "msg_a") {
          started.resolve()
          return release.promise
        }
        return { id: input.id }
      },
    })
    const args = (id: string) => ({ sessionID: "ses_1", input: { id, text: "t" } })
    const first = tool("session_prompt", args("msg_a"))
    await started.promise
    const second = tool("session_prompt", args("msg_b"))
    state.allowed = false
    release.resolve({ id: "msg_a" })
    await first
    const refused = ((await (await second).json()) as { result: { isError: boolean; structuredContent: unknown } }).result
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({ error: { code: "agent_unavailable" } })
    expect(calls.filter((call) => call.method === "prompt")).toHaveLength(1)
  })

  test("serves only POST at the fixed resource, with bounded bodies and no caching", async () => {
    const { request, tool } = await fixture()
    expect((await request("tools/list", {}, { verb: "GET", body: undefined })).status).toBe(405)
    expect((await request("tools/list", {}, { url: "https://relay.example.com/api/mcp/devices/other" })).status).toBe(404)
    expect((await request("tools/list", {}, { url: `${resource}?x=1` })).status).toBe(404)
    expect((await request("tools/call", {}, { name: "session_get", body: "x".repeat(200_000) })).status).toBe(413)
    expect((await tool("session_get", { sessionID: "ses_1" })).headers.get("cache-control")).toBe("no-store")
  })
})
