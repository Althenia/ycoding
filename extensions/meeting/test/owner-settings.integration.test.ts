import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startBridge } from "../src/bridge"
import { sendControl } from "../src/bridge-client"
import { meetingConfigSchema } from "../src/config"
import { createMeetingQuestions, createOwnerSettings } from "../src/plugin"
import { MeetingRuntime } from "../src/runtime"
import { MeetingStore } from "../src/store"

type OwnerSettings = Awaited<ReturnType<ReturnType<typeof createOwnerSettings>["read"]>>

const controlToken = "owner-settings-test-controller-credential"
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

const revisionAware = {
  type: "object",
  properties: { id: {}, content: {}, expectedRevision: {} },
  required: ["id", "content", "expectedRevision"],
}

async function fixture(
  inventory: {
    models?: { providerID: string; id: string; name?: string; enabled?: boolean; status?: string; variants?: { id: string }[] }[]
    servers?: { name: string; status: { status: string } }[]
    tools?: { server: string; name: string; inputSchema?: unknown }[]
    config?: Record<string, unknown>
  } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-owner-"))
  const store = new MeetingStore(path.join(directory, "meetings.sqlite"))
  store.createMeeting({ id: "meeting-1", title: "Owner settings", sessionID: "analysis-session" })
  store.putSegment({
    id: "segment-1",
    meetingID: "meeting-1",
    sequence: 1,
    source: "remote",
    speakerID: "remote-unknown",
    startMs: 0,
    endMs: 900,
    rawText: "Rollout decision pending",
    text: "Rollout decision pending",
    state: "final",
    model: "speech",
    createdAt: new Date().toISOString(),
  })
  const created: { parentID?: string; model?: unknown }[] = []
  const toolCalls: unknown[] = []
  const runtime = new MeetingRuntime({
    directory,
    store,
    config: meetingConfigSchema.parse(inventory.config ?? { analysis: { incremental: false } }),
    createSession: async (parentID, model) => {
      created.push({ parentID, model })
      return `session-${created.length}`
    },
    generate: async () => "Advisory answer [segment-1]",
    mcp: {
      servers: async () =>
        inventory.servers ?? [
          { name: "docs", status: { status: "connected" } },
          { name: "wiki", status: { status: "failed", error: "down" } },
        ],
      tools: async () =>
        inventory.tools ?? [
          { server: "docs", name: "search" },
          { server: "docs", name: "read" },
          { server: "docs", name: "replace", inputSchema: revisionAware },
          { server: "wiki", name: "find" },
          { server: "wiki", name: "get" },
          { server: "wiki", name: "put", inputSchema: { type: "object", properties: { id: {} }, required: ["id"] } },
        ],
      callTool: async (input) => {
        toolCalls.push(input)
        throw new Error("Discovery must not call tools")
      },
    },
    providerFactory: (config) => ({
      id: config.provider,
      initialize: async () => undefined,
      healthCheck: async () => ({ healthy: true, initialized: true }),
      dispose: async () => undefined,
      transcribe: async () => [],
    }),
  })
  const questions = createMeetingQuestions(runtime)
  const ownerSettings = createOwnerSettings(
    runtime,
    async () =>
      inventory.models ?? [
        { providerID: "p", id: "m1", name: "Model One", enabled: true, status: "active", variants: [{ id: "fast" }, { id: "deep" }] },
        { providerID: "p", id: "m2", name: "Model Two", enabled: false, status: "active", variants: [] },
      ],
  )
  const bridge = await startBridge({
    controlToken,
    onControl: (input) => runtime.control(input),
    onCapture: (input) => runtime.capture(input),
    onView: () => questions.state(),
    onAsk: (question) => questions.ask(question),
    onOwnerRead: () => ownerSettings.read(),
    onOwnerUpdate: (input) => ownerSettings.update(input),
  })
  cleanups.push(async () => {
    await bridge.close()
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  })
  const links = async () => {
    const view = await sendControl(bridge.url, controlToken, { action: "view" })
    const ownerView = await sendControl(bridge.url, controlToken, { action: "owner-view" })
    const url = (value: unknown) => {
      if (typeof value !== "object" || value === null || !("url" in value) || typeof value.url !== "string")
        throw new Error("Missing page URL")
      return new URL(value.url)
    }
    const ordinary = url(view)
    const owner = url(ownerView)
    const fields = (value: URL) => new URLSearchParams(value.hash.slice(1))
    return {
      ordinary: ordinary.href,
      owner: owner.href,
      key: fields(ordinary).get("key")!,
      ownerKey: fields(owner).get("owner")!,
      ownerFields: fields(owner),
    }
  }
  const request = (
    route: string,
    options: { token?: string; origin?: string | null; body?: unknown; method?: string } = {},
  ) =>
    fetch(`${bridge.url}${route}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.origin === null ? {} : { origin: options.origin ?? bridge.url }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  return { directory, store, runtime, questions, bridge, links, request, created, toolCalls }
}

test("native control issues an ordinary link without owner authority and a separate owner link", async () => {
  const f = await fixture()
  const links = await f.links()
  expect(links.ordinary).not.toContain("owner=")
  expect(links.key).toMatch(/^[0-9a-f]{64}$/)
  expect(links.ownerKey).toMatch(/^[0-9a-f]{64}$/)
  expect(links.ownerKey).not.toBe(links.key)
  expect(links.ownerFields.get("key")).toBe(links.key)
  expect(links.owner).not.toContain(controlToken)
  expect((await f.request("/control", { token: links.key, origin: null, body: { action: "owner-view" } })).status).toBe(401)
  expect((await f.request("/control", { origin: null, body: { action: "owner-view" } })).status).toBe(401)
})

test("owner settings reject missing, view, controller and foreign-origin credentials while the readonly view stays usable", async () => {
  const f = await fixture()
  const { key, ownerKey } = await f.links()
  for (const token of [undefined, key, controlToken, "f".repeat(64)])
    expect((await f.request("/view/owner/settings", { token })).status).toBe(401)
  expect((await f.request("/view/owner/settings", { token: ownerKey, origin: "https://example.com" })).status).toBe(403)
  expect((await f.request("/view/owner/settings", { token: ownerKey })).status).toBe(200)
  expect((await f.request("/view/owner/settings", { token: ownerKey, body: {} })).status).toBe(400)
  expect((await f.request("/view/state", { token: key })).status).toBe(200)
  expect((await f.request("/view/state", { token: ownerKey })).status).toBe(401)
  const state = await (await f.request("/view/state", { token: key })).text()
  expect(state).not.toContain(ownerKey)
  expect(state).not.toContain(controlToken)
})

test("owner credential cannot stop capture, ask, approve or reach native control", async () => {
  const f = await fixture()
  const { ownerKey } = await f.links()
  expect((await f.request("/view/control", { token: ownerKey, body: { action: "stop" } })).status).toBe(401)
  expect((await f.request("/view/ask", { token: ownerKey, body: { question: "Hi" } })).status).toBe(401)
  expect((await f.request("/control", { token: ownerKey, origin: null, body: { action: "approve", proposalID: "x" } })).status).toBe(401)
  expect(
    (await f.request("/view/owner/settings", { token: ownerKey, body: { action: "approve", proposalID: "x" } })).status,
  ).toBe(400)
})

test("owner read returns bounded live inventory without calling any MCP tool", async () => {
  const f = await fixture()
  const { ownerKey } = await f.links()
  const body = await (await f.request("/view/owner/settings", { token: ownerKey })).json() as OwnerSettings
  expect(body.askModel).toBe("inherit")
  expect(body.models).toEqual([
    { providerID: "p", id: "m1", name: "Model One", enabled: true, status: "active", variants: ["fast", "deep"] },
    { providerID: "p", id: "m2", name: "Model Two", enabled: false, status: "active", variants: [] },
  ])
  expect(body.knowledge).toMatchObject({ mcpEnabled: true, autoApply: false, requireApproval: true, bindings: [] })
  expect(body.servers).toContainEqual({ name: "docs", status: "connected", tools: ["search", "read", "replace"] })
  expect(body.servers).toContainEqual({ name: "wiki", status: "failed", tools: ["find", "get", "put"] })
  expect(f.toolCalls).toEqual([])
  expect(JSON.stringify(body)).not.toContain(ownerKey)
})

test("owner update strictly validates payload shape and live inventory before persisting", async () => {
  const f = await fixture()
  const { ownerKey } = await f.links()
  const post = (body: unknown) => f.request("/view/owner/settings", { token: ownerKey, body })
  for (const body of [
    { askModel: "inherit", tool: "search" },
    { knowledge: { mcpEnabled: true, autoApply: true, bindings: [] } },
    { knowledge: { mcpEnabled: true, requireApproval: false, bindings: [] } },
    { askModel: { providerID: "p", id: "m1", account: "x" } },
    { knowledge: { mcpEnabled: true, bindings: Array.from({ length: 5 }, () => ({ server: "docs", search: "search", read: "read", enabled: true })) } },
    {},
  ])
    expect((await post(body)).status).toBe(400)
  for (const body of [
    { askModel: { providerID: "p", id: "missing" } },
    { askModel: { providerID: "p", id: "m1", variant: "missing" } },
    { askModel: { providerID: "p", id: "m2" } },
    { knowledge: { mcpEnabled: true, bindings: [{ server: "missing", search: "search", read: "read", enabled: true }] } },
    { knowledge: { mcpEnabled: true, bindings: [{ server: "docs", search: "missing", read: "read", enabled: true }] } },
    { knowledge: { mcpEnabled: true, bindings: [{ server: "docs", search: "search", read: "read", write: "missing", enabled: true }] } },
    {
      knowledge: {
        mcpEnabled: true,
        bindings: [
          { server: "docs", search: "search", read: "read", enabled: true },
          { server: "docs", search: "search", read: "read", enabled: false },
        ],
      },
    },
  ]) {
    const response = await post(body)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: "selection_unavailable" })
  }
  expect(f.runtime.config.analysis.askModel).toBe("inherit")
  expect(f.runtime.config.knowledge.bindings).toEqual([])
  expect(f.toolCalls).toEqual([])
})

test("owner update persists Ask model and bindings through settings.json and applies them live", async () => {
  const f = await fixture()
  const { key, ownerKey } = await f.links()
  const response = await f.request("/view/owner/settings", {
    token: ownerKey,
    body: {
      askModel: { providerID: "p", id: "m1", variant: "deep" },
      knowledge: {
        mcpEnabled: true,
        bindings: [
          { server: "docs", search: "search", read: "read", write: "replace", enabled: true },
          { server: "wiki", search: "find", read: "get", write: "put", enabled: false },
        ],
      },
    },
  })
  expect(response.status).toBe(200)
  const body = await response.json() as OwnerSettings
  expect(body.askModel).toEqual({ providerID: "p", id: "m1", variant: "deep" })
  expect(body.knowledge.bindings).toEqual([
    { server: "docs", search: "search", read: "read", write: "replace", enabled: true, writeCapability: "revision-aware" },
    { server: "wiki", search: "find", read: "get", write: "put", enabled: false, writeCapability: "manual-only" },
  ])
  const saved = JSON.parse(await readFile(path.join(f.directory, "settings.json"), "utf8"))
  expect(saved.analysis.askModel).toEqual({ providerID: "p", id: "m1", variant: "deep" })
  expect(saved.knowledge.autoApply).toBe(false)
  expect(saved.knowledge.requireApproval).toBe(true)
  expect(saved.knowledge.bindings).toHaveLength(2)
  expect(f.runtime.intelligence.options.bindings.map((binding) => binding.server)).toEqual(["docs"])
  expect((await f.request("/view/state", { token: key })).status).toBe(200)

  const off = await f.request("/view/owner/settings", {
    token: ownerKey,
    body: { knowledge: { mcpEnabled: false, bindings: body.knowledge.bindings.map(({ writeCapability: _cap, ...binding }) => binding) } },
  })
  expect(off.status).toBe(200)
  expect(f.runtime.intelligence.options.bindings).toEqual([])
})

test("saved Ask model changes future Ask sessions only, never the meeting analysis session", async () => {
  const f = await fixture()
  const { ownerKey } = await f.links()
  await f.questions.ask("What is pending?")
  expect(f.created.at(-1)).toEqual({ parentID: undefined, model: undefined })
  await f.request("/view/owner/settings", {
    token: ownerKey,
    body: { askModel: { providerID: "p", id: "m1", variant: "fast" } },
  })
  await f.questions.ask("What changed?")
  expect(f.created.at(-1)).toEqual({ parentID: undefined, model: { providerID: "p", id: "m1", variant: "fast" } })
  expect(f.store.getMeeting("meeting-1")?.sessionID).toBe("analysis-session")
  await f.request("/view/owner/settings", { token: ownerKey, body: { askModel: "inherit" } })
  await f.questions.ask("And now?")
  expect(f.created.at(-1)).toEqual({ parentID: undefined, model: undefined })
})

test("owner read preserves every catalog model and the last one stays selectable", async () => {
  const models = Array.from({ length: 585 }, (_, index) => ({
    providerID: "p",
    id: `m${index}`,
    name: `Model ${index}`,
    enabled: true,
    status: "active",
    variants: index === 584 ? Array.from({ length: 70 }, (_, variant) => ({ id: `v${variant}` })) : [],
  }))
  const servers = Array.from({ length: 70 }, (_, index) => ({
    name: `s${index}`,
    status: { status: "connected" },
  }))
  const tools = [
    ...Array.from({ length: 140 }, (_, index) => ({ server: "s69", name: `t${index}` })),
    { server: "s69", name: "search" },
    { server: "s69", name: "read" },
  ]
  const f = await fixture({ models, servers, tools })
  const { ownerKey } = await f.links()
  const body = await (await f.request("/view/owner/settings", { token: ownerKey })).json() as OwnerSettings
  expect(body.models).toHaveLength(585)
  expect(body.models.at(-1)).toMatchObject({ providerID: "p", id: "m584" })
  expect(body.models.at(-1)?.variants).toHaveLength(70)
  expect(body.servers).toHaveLength(70)
  expect(body.servers.find((server) => server.name === "s69")?.tools).toHaveLength(142)
  const saved = await f.request("/view/owner/settings", {
    token: ownerKey,
    body: { askModel: { providerID: "p", id: "m584", variant: "v69" } },
  })
  expect(saved.status).toBe(200)
  expect(f.runtime.config.analysis.askModel).toEqual({ providerID: "p", id: "m584", variant: "v69" })
  const bound = await f.request("/view/owner/settings", {
    token: ownerKey,
    body: {
      knowledge: { mcpEnabled: true, bindings: [{ server: "s69", search: "search", read: "read", enabled: true }] },
    },
  })
  expect(bound.status).toBe(200)
})

test("owner read fails explicitly instead of truncating an inventory beyond the reply bound", async () => {
  const f = await fixture({
    models: Array.from({ length: 4000 }, (_, index) => ({
      providerID: "p",
      id: `m${index}`,
      name: `Model ${index} ${"x".repeat(300)}`,
      enabled: true,
      status: "active",
      variants: [{ id: "fast" }],
    })),
  })
  const { ownerKey } = await f.links()
  const response = await f.request("/view/owner/settings", { token: ownerKey })
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ error: "owner_failed" })
})

test("disabling an offline connector or turning connectors off needs no live tools, but enabling does", async () => {
  const f = await fixture()
  const { ownerKey } = await f.links()
  const offline = { server: "offline", search: "find", read: "get", write: "put", enabled: false }
  const disabled = await f.request("/view/owner/settings", {
    token: ownerKey,
    body: { knowledge: { mcpEnabled: true, bindings: [offline] } },
  })
  expect(disabled.status).toBe(200)
  expect(f.runtime.config.knowledge.bindings).toEqual([offline])
  expect(f.runtime.intelligence.options.bindings).toEqual([])

  const inactive = { ...offline, enabled: true }
  const off = await f.request("/view/owner/settings", {
    token: ownerKey,
    body: { knowledge: { mcpEnabled: false, bindings: [inactive] } },
  })
  expect(off.status).toBe(200)
  expect(f.runtime.config.knowledge).toMatchObject({ mcpEnabled: false, autoApply: false, requireApproval: true })
  expect(f.runtime.intelligence.options.bindings).toEqual([])
  const saved = JSON.parse(await readFile(path.join(f.directory, "settings.json"), "utf8"))
  expect(saved.knowledge.bindings).toEqual([inactive])

  const enable = await f.request("/view/owner/settings", {
    token: ownerKey,
    body: { knowledge: { mcpEnabled: true, bindings: [inactive] } },
  })
  expect(enable.status).toBe(422)
  expect(await enable.json()).toEqual({ error: "selection_unavailable" })
  expect(f.runtime.config.knowledge.mcpEnabled).toBe(false)

  const missingTool = await f.request("/view/owner/settings", {
    token: ownerKey,
    body: {
      knowledge: {
        mcpEnabled: true,
        bindings: [{ server: "docs", search: "search", read: "missing", enabled: true }],
      },
    },
  })
  expect(missingTool.status).toBe(422)
})

test("unset askModel inherits the explicit analysis model captured at question admission", async () => {
  const analysisModel = { providerID: "p", id: "m1", variant: "deep", profile: "acct" }
  const f = await fixture({ config: { analysis: { incremental: false, model: analysisModel } } })
  const { ownerKey } = await f.links()
  expect(f.runtime.config.analysis.askModel).toBe("inherit")
  const body = await (await f.request("/view/owner/settings", { token: ownerKey })).json() as OwnerSettings
  expect(body.askModel).toBe("inherit")
  expect(body.analysisModel).toEqual(analysisModel)
  await f.questions.ask("What is pending?")
  expect(f.created.at(-1)).toEqual({ parentID: undefined, model: analysisModel })
  await f.request("/view/owner/settings", {
    token: ownerKey,
    body: { askModel: { providerID: "p", id: "m1", variant: "fast" } },
  })
  await f.questions.ask("And now?")
  expect(f.created.at(-1)).toEqual({ parentID: undefined, model: { providerID: "p", id: "m1", variant: "fast" } })
  expect(f.store.getMeeting("meeting-1")?.sessionID).toBe("analysis-session")
  await f.request("/view/owner/settings", { token: ownerKey, body: { askModel: "inherit" } })
  await f.questions.ask("Once more?")
  expect(f.created.at(-1)).toEqual({ parentID: undefined, model: analysisModel })
})

test("owner update carries an explicit profile bounded like other selection names", async () => {
  const f = await fixture()
  const { ownerKey } = await f.links()
  const saved = await f.request("/view/owner/settings", {
    token: ownerKey,
    body: { askModel: { providerID: "p", id: "m1", variant: "fast", profile: "acct" } },
  })
  expect(saved.status).toBe(200)
  expect(f.runtime.config.analysis.askModel).toEqual({ providerID: "p", id: "m1", variant: "fast", profile: "acct" })
  await f.questions.ask("What is pending?")
  expect(f.created.at(-1)).toEqual({
    parentID: undefined,
    model: { providerID: "p", id: "m1", variant: "fast", profile: "acct" },
  })
  const oversized = await f.request("/view/owner/settings", {
    token: ownerKey,
    body: { askModel: { providerID: "p", id: "m1", profile: "x".repeat(201) } },
  })
  expect(oversized.status).toBe(400)
})
