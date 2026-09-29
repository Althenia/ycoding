import { describe, expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { pacedFlowTimeoutMs, startRelayDouble, waitFor, type RelayHandlerOutcome, type RelayRequestHandler } from "./relay-double"

const workspace = { id: "workspace_alpha", projectID: "project_alpha", directory: "/workspace/alpha", name: "Alpha" }
const other = { id: "workspace_beta", projectID: "project_beta", directory: "/workspace/beta", name: "Beta" }
const created = {
  id: "ses_created",
  title: "New session",
  projectID: workspace.projectID,
  location: { directory: workspace.directory },
  time: { created: 3, updated: 3 },
}

async function setup(handler?: RelayRequestHandler, sessionGroups?: () => readonly typeof workspace[]) {
  const relay = await startRelayDouble({
    handler: (request) => {
      if (request.operation === "workspace.list" && request.input?.sessionsOnly === true)
        return sessionGroups ? { ok: true, value: { data: sessionGroups() } } : "default"
      const result = handler?.(request)
      if (result !== undefined && result !== "default") return result
      if (request.operation === "workspace.list") return { ok: true, value: { data: [workspace, other] } }
      if (request.operation === "session.create") return { ok: true, value: { data: created } }
      return "default"
    },
  })
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10, maxDelayMs: 20 }),
    createSessionID: () => created.id,
  })
  await store.load()
  await waitFor(() => store.state().connection.kind === "connected" && store.state().sessions.length > 0)
  return {
    store,
    relay,
    stop: async () => {
      store.dispose()
      await relay.stop()
    },
  }
}

describe("remote workspace session creation", () => {
  test("uploads a file after creating the Session and sends its first prompt with the completed reference", async () => {
    const h = await setup((request) => {
      if (request.operation !== "session.attachment.upload") return "default"
      return { ok: true, value: { uri: `ycoding-upload://${String(request.input?.uploadID)}` } }
    })
    try {
      await h.store.loadWorkspaces()
      expect(await h.store.createSession({ workspaceID: workspace.id, prompt: { text: "Inspect screenshot", files: [{ uri: "data:image/png;base64,AAAA", name: "capture.png" }] } })).toBe(created.id)
      const operations = h.relay.requests.filter((request) => ["session.create", "session.attachment.upload", "session.prompt"].includes(request.operation))
      expect(operations.map((request) => request.operation)).toEqual(["session.create", "session.attachment.upload", "session.prompt"])
      expect(operations[1]?.sessionID).toBe(created.id)
      expect(operations[2]?.input?.files).toEqual([{ uri: `ycoding-upload://${String(operations[1]?.input?.uploadID)}`, name: "capture.png" }])
    } finally { await h.stop() }
  })

  test("failed first-prompt upload retains the created Session ID and attachment for explicit retry", async () => {
    let failed = true
    const h = await setup((request) => request.operation === "session.attachment.upload"
      ? failed ? { ok: false, code: "invalid_message", message: "Upload failed" } : { ok: true, value: { uri: `ycoding-upload://${String(request.input?.uploadID)}` } }
      : request.operation === "session.get" && request.sessionID === created.id ? { ok: true, value: { data: created } } : "default")
    try {
      await h.store.loadWorkspaces()
      expect(await h.store.createSession({ workspaceID: workspace.id, prompt: { text: "Inspect", files: [{ uri: "data:image/png;base64,AAAA", name: "capture.png" }] } })).toBeUndefined()
      expect(h.store.state().sessionCreation).toMatchObject({ id: created.id, status: "failed", message: "Upload failed" })
      expect(h.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
      failed = false
      expect(await h.store.retrySessionCreation()).toBe(created.id)
      expect(h.relay.requests.filter((request) => request.operation === "session.create")).toHaveLength(1)
      expect(h.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
    } finally { await h.stop() }
  }, pacedFlowTimeoutMs)
  test("keeps drafts with their Session across selection and same-device reconnect, but not another device", async () => {
    const h = await setup()
    try {
      await h.store.selectSession("ses_a")
      h.store.setDraft("ses_a", "Alpha draft")
      await h.store.selectSession("ses_b")
      h.store.setDraft("ses_b", "Beta draft")
      expect(h.store.state().drafts).toEqual({ ses_a: "Alpha draft", ses_b: "Beta draft" })
      h.store.connect("dev_1")
      expect(h.store.state().drafts).toEqual({ ses_a: "Alpha draft", ses_b: "Beta draft" })
      h.store.connect("dev_other")
      expect(h.store.state().drafts).toEqual({})
    } finally { await h.stop() }
  })

  test("creates in a listed workspace, opens it, and submits only when the caller asks", async () => {
    let createdVisible = false
    const h = await setup((request) => request.operation === "session.list" && request.input?.workspace === workspace.id
      ? { ok: true, value: { data: createdVisible ? [created] : [] } } : "default", () => [
        { id: "wsp_prj_default__work", projectID: "prj_default", directory: "/work", name: "Current" },
        ...(createdVisible ? [workspace] : []),
      ])
    try {
      await h.store.selectSession("ses_a")
      await h.store.loadWorkspaces()
      expect(h.store.state().workspaces).toEqual([workspace, other])
      expect(h.store.state().workspaceStatus).toBe("ready")
      expect(await h.store.createSession({ workspaceID: workspace.id })).toBe(created.id)
      expect(h.relay.requests.find((request) => request.operation === "session.create")?.input).toEqual({ id: created.id, workspace: workspace.id })
      expect(h.store.state().sessions.some((session) => session.id === created.id && session.directory === workspace.directory)).toBe(true)
      expect(h.store.state().activeSessionID).toBe(created.id)
      expect(h.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
      createdVisible = true
      h.relay.pushSessions([])
      await waitFor(() => h.store.state().sessionGroups.some((group) => group.id === workspace.id))
      h.store.selectWorkspace(workspace.id)
      await waitFor(() => h.store.state().sessions.some((session) => session.id === created.id))
      expect(h.store.state().sessions[0]?.directory).toBe(workspace.directory)
      expect(h.store.state().activeSessionID).toBe(created.id)
      await h.store.sendPrompt({ text: "Continue on the selected repository", delivery: "steer" })
      expect(h.relay.requests.find((request) => request.operation === "session.prompt")?.sessionID).toBe(created.id)
    } finally { await h.stop() }
  }, pacedFlowTimeoutMs)

  test("keeps drafts and uncertain creation when the account reports the selected machine offline", async () => {
    const delayed = Promise.withResolvers<RelayHandlerOutcome>()
    const h = await setup((request) => request.operation === "workspace.list"
      ? { ok: true, value: { data: [workspace] } }
      : request.operation === "session.create" ? delayed.promise
      : request.operation === "session.get" ? { ok: true, value: { data: created } } : "default")
    try {
      await h.store.selectSession("ses_a")
      h.store.setDraft("ses_a", "Keep while offline")
      await h.store.loadWorkspaces()
      const creating = h.store.createSession({ workspaceID: workspace.id })
      await waitFor(() => h.relay.requests.some((request) => request.operation === "session.create"))
      h.relay.setMe({
        user: { id: "user_1" }, session: { expiresAt: 4_102_444_800_000 },
        devices: [{ id: "dev_1", name: "Studio Mac", createdAt: 1, status: "active", online: false }],
      })
      await h.store.load()
      expect(await creating).toBeUndefined()
      expect(h.store.state().connection.kind).toBe("offline")
      expect(h.store.state().drafts.ses_a).toBe("Keep while offline")
      expect(h.store.state().sessionCreation).toMatchObject({ id: created.id, status: "unknown" })
      h.store.connect("dev_1")
      await waitFor(() => h.store.state().connection.kind === "connected")
      expect(await h.store.retrySessionCreation()).toBe(created.id)
      expect(h.relay.requests.filter((request) => request.operation === "session.create")).toHaveLength(1)
      expect(h.store.state().drafts.ses_a).toBe("Keep while offline")
      h.store.disconnect()
      expect(h.store.state().drafts).toEqual({})
    } finally { delayed.resolve("default"); await h.stop() }
  })

  test("refuses an unlisted workspace and distinguishes empty and failed inventory reads", async () => {
    let fail = false
    const h = await setup((request) => request.operation === "workspace.list"
      ? fail ? { ok: false, code: "internal_error", message: "Inventory unavailable" } : { ok: true, value: { data: [] } }
      : "default")
    try {
      await h.store.loadWorkspaces()
      expect(h.store.state().workspaceStatus).toBe("ready")
      expect(h.store.state().workspaces).toEqual([])
      expect(await h.store.createSession({ workspaceID: "workspace_unknown" })).toBeUndefined()
      expect(h.relay.requests.some((request) => request.operation === "session.create")).toBe(false)
      fail = true
      await h.store.loadWorkspaces()
      expect(h.store.state().workspaceStatus).toBe("error")
      expect(h.store.state().workspaceError).toContain("Inventory unavailable")
    } finally { await h.stop() }
  })

  test("keeps the latest workspace read when a previous response arrives later", async () => {
    const delayed = Promise.withResolvers<RelayHandlerOutcome>()
    let reads = 0
    const h = await setup((request) => request.operation === "workspace.list"
      ? ++reads === 1 ? delayed.promise : { ok: true, value: { data: [other] } }
      : "default")
    try {
      const first = h.store.loadWorkspaces()
      await waitFor(() => reads === 1)
      await h.store.loadWorkspaces()
      delayed.resolve({ ok: true, value: { data: [workspace] } })
      await first
      expect(h.store.state().workspaces).toEqual([other])
      expect(h.store.state().workspaceStatus).toBe("ready")
    } finally { delayed.resolve("default"); await h.stop() }
  })

  test("does not apply an inventory or creation outcome to a replacement connection", async () => {
    const delayed = Promise.withResolvers<RelayHandlerOutcome>()
    const h = await setup((request) => request.operation === "workspace.list"
      ? { ok: true, value: { data: [workspace] } }
      : request.operation === "session.create" ? delayed.promise : "default")
    try {
      await h.store.loadWorkspaces()
      const creating = h.store.createSession({ workspaceID: workspace.id })
      await waitFor(() => h.relay.requests.some((request) => request.operation === "session.create"))
      h.store.connect("dev_other")
      expect(await creating).toBeUndefined()
      delayed.resolve({ ok: true, value: { data: created } })
      await waitFor(() => h.store.state().connection.kind === "connected")
      expect(h.store.state().sessionCreation).toBeUndefined()
      expect(h.store.state().workspaces).toEqual([])
      expect(h.store.state().sessions.some((session) => session.id === created.id)).toBe(false)
    } finally { delayed.resolve("default"); await h.stop() }
  })

  test("deduplicates an in-flight creation and retains uncertain outcomes without replay", async () => {
    const delayed = Promise.withResolvers<RelayHandlerOutcome>()
    const h = await setup((request) => request.operation === "workspace.list"
      ? { ok: true, value: { data: [workspace] } }
      : request.operation === "session.create" ? delayed.promise
      : request.operation === "session.get" ? { ok: true, value: { data: created } } : "default")
    try {
      await h.store.loadWorkspaces()
      const creating = h.store.createSession({ workspaceID: workspace.id })
      await waitFor(() => h.relay.requests.some((request) => request.operation === "session.create"))
      expect(await h.store.createSession({ workspaceID: workspace.id })).toBeUndefined()
      delayed.resolve("close")
      expect(await creating).toBeUndefined()
      await waitFor(() => h.store.state().connection.kind === "connected")
      expect(h.store.state().sessionCreation?.status).toBe("unknown")
      expect(h.relay.requests.filter((request) => request.operation === "session.create")).toHaveLength(1)
      expect(await h.store.retrySessionCreation()).toBe(created.id)
      expect(h.relay.requests.filter((request) => request.operation === "session.create")).toHaveLength(1)
      expect(h.store.state().sessionCreation).toBeUndefined()
    } finally { delayed.resolve("default"); await h.stop() }
  })

  test("retries an absent uncertain creation with the same Session ID only on explicit request", async () => {
    let attempts = 0
    const h = await setup((request) => request.operation === "workspace.list"
      ? { ok: true, value: { data: [workspace] } }
      : request.operation === "session.create" ? ++attempts === 1 ? "close" : { ok: true, value: { data: created } }
      : request.operation === "session.get" ? { ok: false, code: "session_not_allowed", message: "Session not found" } : "default")
    try {
      await h.store.loadWorkspaces()
      await h.store.createSession({ workspaceID: workspace.id })
      await waitFor(() => h.store.state().connection.kind === "connected")
      expect(attempts).toBe(1)
      expect(await h.store.retrySessionCreation()).toBe(created.id)
      expect(h.relay.requests.filter((request) => request.operation === "session.create").map((request) => request.input?.id)).toEqual([created.id, created.id])
    } finally { await h.stop() }
  })

  test("keeps a mismatched creation response uncertain instead of opening the wrong workspace", async () => {
    const h = await setup((request) => request.operation === "workspace.list"
      ? { ok: true, value: { data: [workspace] } }
      : request.operation === "session.create" ? { ok: true, value: { data: { ...created, location: { directory: other.directory } } } } : "default")
    try {
      await h.store.loadWorkspaces()
      expect(await h.store.createSession({ workspaceID: workspace.id })).toBeUndefined()
      expect(h.store.state().sessionCreation?.status).toBe("unknown")
      expect(h.store.state().sessions.some((session) => session.id === created.id)).toBe(false)
    } finally { await h.stop() }
  })
})
