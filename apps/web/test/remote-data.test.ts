import { describe, expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor, type RelayHandlerResult } from "./relay-double"

async function setup(handler?: (request: { operation: string; input?: Readonly<Record<string, unknown>>; sessionID?: string }) => RelayHandlerResult, requestTimeoutMs = 30_000) {
  const relay = await startRelayDouble({ handler })
  let nextMessage = 0
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10, maxDelayMs: 20, requestTimeoutMs }),
    now: () => 1_000,
    createMessageID: () => `msg_local_${++nextMessage}`,
    createSessionID: () => "ses_created",
  })
  return { store, relay, stop: async () => { store.dispose(); await relay.stop() } }
}

describe("remote data", () => {
  test("a frame before the initial list remains the status baseline after the later read", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await setup(async (request) => {
      if (request.operation === "workspace.list" && request.input?.sessionsOnly === true) await gate
      if (request.operation === "session.status") return { ok: true, value: { running: [], attention: [] } }
      return "default" as const
    })
    try {
      await test.store.load()
      await waitFor(() => test.relay.requests.some((request) => request.operation === "workspace.list" && request.input?.sessionsOnly === true))
      test.relay.pushStatus(["ses_b"], ["ses_a"])
      await waitFor(() => test.store.state().sessionStatus?.running.has("ses_b") === true)
      release?.()
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.status"))
      await waitFor(() => test.store.state().sessions.length === 2)
      await Bun.sleep(15)
      expect(test.store.state().sessionStatus?.attention.has("ses_a")).toBe(true)
      expect(test.store.state().notifications).toEqual([])
    } finally { release?.(); await test.stop() }
  })
  test("keeps an uncertain command visible and resends only on explicit retry with its original ID", async () => {
    let commands = 0
    const test = await setup((request) => {
      if (request.operation !== "session.command") return "default"
      commands += 1
      return commands === 1 ? "silent" : { ok: true, value: { data: { id: request.input?.id } } }
    }, 25)
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await test.store.selectSession("ses_a")
      await test.store.runCommand({ command: "build", delivery: "steer" })
      expect(commands).toBe(1)
      const mutation = test.store.state().mutations.find((entry) => entry.kind === "command")
      expect(mutation).toMatchObject({ state: "unknown", operation: "session.command", input: { command: "build" } })
      await Bun.sleep(40)
      expect(commands).toBe(1)
      if (!mutation) throw new Error("missing uncertain command")
      await test.store.retryMutation(mutation.id)
      expect(commands).toBe(2)
      expect(test.relay.requests.filter((request) => request.operation === "session.command").map((request) => request.input?.id)).toEqual([mutation.input.id, mutation.input.id])
    } finally { await test.stop() }
  })
  test("a frame arriving before the status read is the silent baseline and cannot be overwritten by that read", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await setup(async (request) => {
      if (request.operation !== "session.status") return "default"
      await gate
      return { ok: true, value: { running: [], attention: [] } }
    })
    try {
      await test.store.load()
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.status"))
      test.relay.pushStatus(["ses_b"], ["ses_a"])
      await waitFor(() => test.store.state().sessionStatus?.running.has("ses_b") === true)
      expect(test.store.state().notifications).toEqual([])
      release?.()
      await Bun.sleep(15)
      expect(test.store.state().sessionStatus?.attention.has("ses_a")).toBe(true)
      test.relay.pushStatus([], ["ses_a"])
      await waitFor(() => test.store.state().notifications.some((notice) => notice.category === "agent-completed"))
      expect(test.store.state().notifications[0]).toMatchObject({ category: "agent-completed", sessionID: "ses_b" })
    } finally { release?.(); await test.stop() }
  })
  test("follows durable active-session agent and model changes in the selected list row", async () => {
    const test = await setup()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await test.store.selectSession("ses_a")
      test.relay.pushEvent("ses_a", { type: "session.agent.selected", data: { sessionID: "ses_a", agent: "reviewer" },
        durable: { aggregateID: "ses_a", seq: 1, version: 1 } })
      test.relay.pushEvent("ses_a", { type: "session.model.selected", data: { sessionID: "ses_a", model: { providerID: "openai", id: "gpt-6" } },
        durable: { aggregateID: "ses_a", seq: 2, version: 1 } })
      await waitFor(() => test.store.state().selectedSessionInfo?.model?.id === "gpt-6")
      expect(test.store.state().selectedSessionInfo).toMatchObject({ agent: "reviewer", model: { providerID: "openai", id: "gpt-6" } })
    } finally { await test.stop() }
  })
  test("the first status frame after a baseline read alerts on new attention and stopped work", async () => {
    const test = await setup((request) => request.operation === "session.status"
      ? { ok: true, value: { running: ["ses_b"], attention: [] } } : "default")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessionStatus?.running.has("ses_b") === true)
      expect(test.store.state().notifications).toEqual([])
      test.relay.pushStatus([], ["ses_a"])
      await waitFor(() => test.store.state().sessionStatus?.attention.has("ses_a") === true)
      expect(test.store.state().notifications.map((notice) => [notice.category, notice.sessionID, notice.sessionTitle])).toEqual([
        ["agent-completed", "ses_b", "Beta session"], ["approval-requested", "ses_a", "Alpha session"],
      ])
    } finally { await test.stop() }
  })
  test("coalesces missing attention roots into one first-page reload during a status burst", async () => {
    const test = await setup()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      const before = test.relay.requests.filter((request) => request.operation === "session.list").length
      test.relay.pushStatus([], ["ses_missing"])
      test.relay.pushStatus(["ses_missing"], ["ses_missing"])
      test.relay.pushStatus(["ses_missing"], [])
      await waitFor(() => test.relay.requests.filter((request) => request.operation === "session.list").length > before)
      expect(test.relay.requests.filter((request) => request.operation === "session.list")).toHaveLength(before + 1)
      expect(test.store.state().sessionStatus?.running.has("ses_missing")).toBe(true)
    } finally { await test.stop() }
  })

  test("runs one trailing missing-root reload after an in-flight status reload and its cooldown", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let lists = 0
    const test = await setup(async (request) => {
      if (request.operation === "session.list" && ++lists === 2) await gate
      return "default" as const
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      test.relay.pushStatus([], ["ses_missing"])
      await waitFor(() => lists === 2)
      test.relay.pushStatus(["ses_missing"], ["ses_missing"])
      expect(lists).toBe(2)
      release?.()
      await waitFor(() => lists === 3, 7_000)
      expect(lists).toBe(3)
    } finally { release?.(); await test.stop() }
  }, 10_000)

  test("serializes file searches per target and drops superseded results", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await setup(async (request) => {
      if (request.operation !== "session.file.find") return "default"
      if (request.input?.query === "first") await gate
      return { ok: true, value: { files: [{ path: String(request.input?.query), uri: "file:///work/a.ts", kind: "file" }] } }
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      const target = { sessionID: "ses_a" }
      const first = test.store.findFiles(target, "first")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.file.find"))
      const second = test.store.findFiles(target, "second")
      const third = test.store.findFiles(target, "third")
      expect(test.relay.requests.filter((request) => request.operation === "session.file.find")).toHaveLength(1)
      release?.()
      expect((await first).status).toBe("failed")
      expect((await second).status).toBe("failed")
      expect(await third).toMatchObject({ status: "ok", files: [{ path: "third" }] })
      expect(test.relay.requests.filter((request) => request.operation === "session.file.find").map((request) => request.input?.query)).toEqual(["first", "third"])
    } finally { release?.(); await test.stop() }
  })

  test("a device switch drops pending catalog and file results from the former connection", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await setup(async (request) => {
      if (request.operation === "session.catalog" || request.operation === "session.file.find") await gate
      return request.operation === "session.catalog"
        ? { ok: true, value: { agents: [], models: [], commands: [], skills: [], references: [], resources: [] } }
        : request.operation === "session.file.find" ? { ok: true, value: { files: [] } } : "default"
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      const catalog = test.store.loadCatalog({ sessionID: "ses_a" })
      const files = test.store.findFiles({ sessionID: "ses_a" }, "a")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.file.find"))
      test.store.connect("dev_other")
      release?.()
      await catalog
      expect((await files).status).toBe("failed")
      expect(test.store.state().catalogs).toEqual({})
    } finally { release?.(); await test.stop() }
  })
  test("creates with selected defaults, then opens and submits the first prompt exactly once", async () => {
    const test = await setup((request) => {
      if (request.operation === "workspace.list" && request.input?.sessionsOnly !== true)
        return { ok: true, value: { data: [{ id: "wsp_project", projectID: "prj_a", directory: "/work/a", name: "Project A" }] } }
      if (request.operation === "session.create") return { ok: true, value: { data: {
        id: request.input?.id, projectID: "prj_a", location: { directory: "/work/a" }, agent: "reviewer",
        model: { providerID: "openai", id: "gpt-6" }, time: { created: 1, updated: 1 },
      } } }
      return "default"
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await test.store.loadWorkspaces()
      const id = await test.store.createSession({ workspaceID: "wsp_project", agent: "reviewer", model: { providerID: "openai", id: "gpt-6" },
        prompt: { text: "Start", files: [{ uri: "file:///work/a.ts" }], skills: ["audit"] } })
      expect(id).toBe("ses_created")
      expect(test.store.state().activeSessionID).toBe(id)
      expect(test.relay.requests.find((request) => request.operation === "session.create")?.input).toMatchObject({
        id, workspace: "wsp_project", agent: "reviewer", model: { providerID: "openai", id: "gpt-6" },
      })
      expect(test.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(2)
      expect(test.relay.requests.filter((request) => request.operation === "session.skill")).toHaveLength(1)
    } finally { await test.stop() }
  })
  test("switches only changed selections and admits skills before waking one prompt with attachments", async () => {
    const test = await setup((request) => request.operation === "session.snapshot" ? { ok: true, value: {
      sourceEpoch: "epoch_1", session: { agent: "god", model: { providerID: "openai", id: "gpt-5" } }, messages: [],
      watermark: { type: "log.synced", aggregateID: request.sessionID, seq: 0 },
    } } : "default")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await test.store.selectSession("ses_a")
      await test.store.sendPrompt({ text: "Review", delivery: "steer", agent: "reviewer", model: { providerID: "openai", id: "gpt-6" },
        files: [{ uri: "file:///work/a.ts", name: "a.ts" }], agents: [{ name: "helper" }], skills: ["audit", "test"] })
      expect(test.relay.requests.filter((request) => ["session.switchAgent", "session.switchModel", "session.skill", "session.prompt"].includes(request.operation))
        .map((request) => [request.operation, request.input])).toMatchObject([
        ["session.switchAgent", { agent: "reviewer" }], ["session.switchModel", { model: { providerID: "openai", id: "gpt-6" } }],
        ["session.skill", { skill: "audit", resume: false }], ["session.skill", { skill: "test", resume: false }],
        ["session.prompt", { text: "Review", resume: false, files: [{ uri: "file:///work/a.ts", name: "a.ts" }], agents: [{ name: "helper" }] }],
        ["session.prompt", { text: "Review", resume: true }],
      ])
      const prompts = test.relay.requests.filter((request) => request.operation === "session.prompt")
      expect(prompts[0]?.input?.id).toBe(prompts[1]?.input?.id)
    } finally { await test.stop() }
  })

  test("stops submission after a selection failure and runs a command with its own durable ID", async () => {
    const test = await setup((request) => request.operation === "session.switchModel"
      ? { ok: false, code: "invalid_message", message: "Unavailable" } : "default")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await test.store.selectSession("ses_a")
      await test.store.sendPrompt({ text: "Do not send", delivery: "steer", model: { providerID: "openai", id: "unavailable" } })
      expect(test.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(0)
      expect(test.store.state().mutations.some((item) => item.kind === "model" && item.state === "failed")).toBe(true)
      await test.store.runCommand({ command: "build", arguments: "--fast", delivery: "queue", files: [{ uri: "file:///work/a.ts" }] })
      expect(test.relay.requests.find((request) => request.operation === "session.command")?.input).toMatchObject({
        command: "build", arguments: "--fast", delivery: "queue", files: [{ uri: "file:///work/a.ts" }], id: "msg_local_2",
      })
    } finally { await test.stop() }
  })
  test("caches catalogs per target and connection, refreshes explicitly, and reads bounded file matches", async () => {
    const test = await setup((request) => {
      if (request.operation === "workspace.catalog" || request.operation === "session.catalog") return { ok: true, value: {
        agents: [], models: [], commands: [], skills: [], references: [], resources: [],
      } }
      if (request.operation === "session.file.find" || request.operation === "workspace.file.find") return {
        ok: true, value: { files: [{ path: "src/a.ts", uri: "file:///work/src/a.ts", kind: "file" }] },
      }
      return "default"
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await test.store.selectSession("ses_a")
      const target = { sessionID: "ses_a" }
      await test.store.loadCatalog(target)
      await test.store.loadCatalog(target)
      expect(test.store.state().catalogs["session:ses_a"]).toMatchObject({ status: "ready" })
      expect(test.relay.requests.filter((request) => request.operation === "session.catalog")).toHaveLength(1)
      await test.store.loadCatalog(target, { refresh: true })
      expect(test.relay.requests.filter((request) => request.operation === "session.catalog")).toHaveLength(2)
      expect(await test.store.findFiles(target, "a", 12)).toEqual({ status: "ok", files: [{ path: "src/a.ts", uri: "file:///work/src/a.ts", kind: "file" }] })
      expect(test.relay.requests.find((request) => request.operation === "session.file.find")?.input).toEqual({ query: "a", limit: 12 })
      test.store.disconnect()
      expect(test.store.state().catalogs).toEqual({})
    } finally { await test.stop() }
  })
  test("status frames replace family sets, reorder roots, and alert only on live transitions", async () => {
    const test = await setup()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await waitFor(() => test.store.state().sessionStatus !== undefined)
      test.relay.pushStatus(["ses_b"], ["ses_a"])
      await waitFor(() => test.store.state().sessionStatus?.attention.has("ses_a") === true)
      expect(test.store.state().sessions.map((row) => row.id)).toEqual(["ses_b", "ses_a"])
      expect(test.store.state().notifications.map((notice) => [notice.category, notice.sessionID])).toEqual([["approval-requested", "ses_a"]])

      test.relay.pushStatus(["ses_a"], ["ses_b"])
      await waitFor(() => test.store.state().sessionStatus?.running.has("ses_a") === true)
      expect(test.store.state().sessions.map((row) => [row.id, row.running, row.attention])).toEqual([
        ["ses_a", true, false], ["ses_b", false, true],
      ])
      expect(test.store.state().notifications.map((notice) => [notice.category, notice.sessionID, notice.read])).toEqual([
        ["agent-completed", "ses_b", false], ["approval-requested", "ses_b", false], ["approval-requested", "ses_a", false],
      ])
      expect(test.store.state().notifications[0]?.body).toContain("stopped running")
      test.store.markNotificationsRead()
      expect(test.store.state().notifications.every((notice) => notice.read)).toBe(true)
      test.store.clearNotifications()
      expect(test.store.state().notifications).toEqual([])
    } finally { await test.stop() }
  })
  test("reads family status once and loads root Sessions in active order without a per-page active read", async () => {
    const test = await setup((request) => request.operation === "session.status"
      ? { ok: true, value: { running: ["ses_b"], attention: ["ses_a"] } } : "default")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await waitFor(() => test.store.state().sessionStatus?.running.has("ses_b") === true)
      expect(test.store.state().sessions.map((row) => [row.id, row.running, row.attention])).toEqual([
        ["ses_b", true, false], ["ses_a", false, true],
      ])
      expect(test.relay.requests.filter((request) => request.operation === "session.status")).toHaveLength(1)
      expect(test.relay.requests.filter((request) => request.operation === "session.active")).toHaveLength(0)
      expect(test.relay.requests.find((request) => request.operation === "session.list")?.input).toMatchObject({ order: "active", limit: 25, parentID: null })
    } finally { await test.stop() }
  })
})
