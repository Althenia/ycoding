import { describe, expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { loadWorkspaces } from "./remote-queries"
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
  test("a failure-only root is failed rather than waiting, still raises one Needs your attention notice, and a pending request restores its dot", async () => {
    const test = await setup()
    const rows = () => test.store.state().sessions.map((row) => [row.id, row.attention, row.failed])
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessionStatus !== undefined && test.store.state().sessions.length === 2 && test.store.state().noticeSync.status === "ready")
      test.relay.pushStatus([], ["ses_a", "ses_b"], undefined, ["ses_a"])
      test.relay.pushNotices({ type: "notice.added", total: 2, notices: [
        { id: "ntc_1", category: "approval-requested", sessionID: "ses_a", createdAt: 1 },
        { id: "ntc_2", category: "approval-requested", sessionID: "ses_b", createdAt: 2 },
      ] })
      await waitFor(() => test.store.state().sessionStatus?.failed.has("ses_a") === true && test.store.state().notifications.length === 2)
      expect(rows()).toEqual([["ses_a", false, true], ["ses_b", true, false]])
      expect(test.store.state().notifications).toHaveLength(2)
      expect(test.store.state().notifications.map((notice) => [notice.category, notice.sessionID])).toEqual(expect.arrayContaining([["approval-requested", "ses_a"], ["approval-requested", "ses_b"]]))
      test.relay.pushStatus([], ["ses_a", "ses_b"])
      await waitFor(() => test.store.state().sessionStatus?.failed.size === 0)
      expect(rows()).toEqual([["ses_a", true, false], ["ses_b", true, false]])
      expect(test.store.state().notifications).toHaveLength(2)
    } finally { await test.stop() }
  })
  test("the initial session.status read carries the failed subset into the Session rows", async () => {
    const test = await setup((request) => request.operation === "session.status"
      ? { ok: true, value: { running: [], attention: ["ses_a"], failed: ["ses_a"] } } : "default")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessionStatus?.failed.has("ses_a") === true && test.store.state().sessions.length === 2)
      expect(test.store.state().sessions.map((row) => [row.id, row.attention, row.failed])).toEqual([["ses_a", false, true], ["ses_b", false, false]])
    } finally { await test.stop() }
  })
  test("loads running roots across workspaces with names before recent rows", async () => {
    const row = (id: string, projectID: string, directory: string, parentID?: string) => ({ id, title: `Session ${id}`,
      projectID, location: { directory }, ...(parentID ? { parentID } : {}), time: { created: 1, updated: 2 } })
    const test = await setup((request) => {
      if (request.operation === "session.status") return { ok: true, value: { running: ["ses_r1", "ses_r2", "ses_r3"], attention: [] } }
      if (request.operation === "workspace.list" && request.input?.sessionsOnly === true) return { ok: true, value: { data: [
        { id: "wsp_a", projectID: "prj_a", directory: "/work/a", name: "Alpha" },
        { id: "wsp_b", projectID: "prj_b", directory: "/work/b", name: "Beta" },
        { id: "wsp_c", projectID: "prj_c", directory: "/work/c", name: "Gamma" },
      ] } }
      if (request.operation === "session.list" && request.input?.status === "running") return { ok: true, value: {
        data: [row("ses_r1", "prj_a", "/work/a"), row("ses_r2", "prj_b", "/work/b"), row("ses_r3", "prj_c", "/work/c")], cursor: {},
      } }
      if (request.operation === "session.list" && request.input?.status === "idle") return { ok: true, value: { data: [] } }
      return "default"
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().carouselSessions?.length === 3)
      expect(test.store.state().carouselSessions?.map((session) => [session.id, session.workspaceName])).toEqual([
        ["ses_r1", "Alpha"], ["ses_r2", "Beta"], ["ses_r3", "Gamma"],
      ])
      const reads = test.relay.requests.filter((request) => request.operation === "session.list" && request.input?.status === "running")
      expect(reads).toHaveLength(1)
      expect(reads[0]?.input).toMatchObject({ order: "active", status: "running", parentID: null, limit: 10 })
      expect(reads[0]?.input).not.toHaveProperty("workspace")
      expect(test.relay.requests.some((request) => request.operation === "session.list" && request.input?.status === "idle" && request.input.workspace === undefined)).toBe(true)
      await test.store.selectSession("ses_r2")
      expect(test.store.state().activeSessionID).toBe("ses_r2")
      expect(test.relay.requests.some((request) => request.operation === "session.subscribe" && request.sessionID === "ses_r2")).toBe(true)
    } finally { await test.stop() }
  })
  test("coalesces running-set changes into the shared status refresh window", async () => {
    const test = await setup((request) => {
      if (request.operation === "session.status") return { ok: true, value: { running: ["ses_r1"], attention: [] } }
      if (request.operation === "session.list" && request.input?.status === "running") {
        const running = request.input.cursor === undefined ? current : []
        return { ok: true, value: { data: running.map((id) => ({ id, title: id, projectID: "prj_a", location: { directory: "/work/a" }, time: { created: 1, updated: 2 } })) } }
      }
      if (request.operation === "session.list" && request.input?.status === "idle") return { ok: true, value: { data: [] } }
      return "default"
    })
    let current = ["ses_r1"]
    try {
      await test.store.load()
      await waitFor(() => test.store.state().carouselSessions?.[0]?.id === "ses_r1")
      current = ["ses_r2"]
      test.relay.pushStatus(["ses_r2"], [])
      current = ["ses_r3"]
      test.relay.pushStatus(["ses_r3"], [])
      await waitFor(() => test.store.state().sessionStatus?.running.has("ses_r3") === true)
      expect(test.store.state().carouselSessions?.map((session) => [session.id, session.running])).toEqual([["ses_r1", false]])
      await Bun.sleep(50)
      expect(test.relay.requests.filter((request) => request.operation === "session.list" && request.input?.status === "running")).toHaveLength(1)
      await waitFor(() => test.store.state().carouselSessions?.[0]?.id === "ses_r3", 6_500)
      expect(test.relay.requests.filter((request) => request.operation === "session.list" && request.input?.status === "running")).toHaveLength(2)
    } finally { await test.stop() }
  }, 8_000)
  test("uploads a large attachment in bounded acknowledged chunks before prompt admission", async () => {
    const uploads: { index: number; last: boolean; data: string; uploadID: string }[] = []
    const test = await setup((request) => {
      if (request.operation !== "session.attachment.upload") return "default"
      const fields = request.input
      if (typeof fields?.index !== "number" || typeof fields.last !== "boolean" || typeof fields.data !== "string" || typeof fields.uploadID !== "string") throw new Error("Invalid upload request")
      const chunk = { index: fields.index, last: fields.last, data: fields.data, uploadID: fields.uploadID }
      uploads.push(chunk)
      return { ok: true, value: chunk.last ? { uri: `ycoding-upload://${chunk.uploadID}` } : { received: chunk.data.length } }
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await test.store.selectSession("ses_a")
      const data = Buffer.alloc(120_000, 42).toString("base64")
      await test.store.sendPrompt({ text: "Review", delivery: "steer", files: [{ uri: `data:image/png;base64,${data}`, name: "capture.png" }] })
      expect(uploads.length).toBeGreaterThan(1)
      expect(uploads.map((chunk) => chunk.data).join("")).toBe(data)
      expect(uploads.every((chunk, index) => chunk.index === index)).toBe(true)
      expect(test.relay.requests.find((request) => request.operation === "session.prompt")?.input?.files).toEqual([{ uri: `ycoding-upload://${uploads[0]!.uploadID}`, name: "capture.png" }])
      expect(test.store.state().upload).toBeUndefined()
    } finally { await test.stop() }
  })
  test("uploads a command attachment and forwards only the completed reference", async () => {
    const test = await setup((request) => request.operation === "session.attachment.upload"
      ? { ok: true, value: { uri: `ycoding-upload://${String(request.input?.uploadID)}` } } : "default")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await test.store.selectSession("ses_a")
      await test.store.runCommand({ command: "plan", delivery: "queue", files: [{ uri: "data:text/plain;base64,aGVsbG8=", name: "notes.txt" }] })
      const upload = test.relay.requests.find((request) => request.operation === "session.attachment.upload")
      expect(upload?.sessionID).toBe("ses_a")
      expect(test.relay.requests.find((request) => request.operation === "session.command")?.input).toMatchObject({ command: "plan", files: [{ uri: `ycoding-upload://${String(upload?.input?.uploadID)}`, name: "notes.txt" }] })
    } finally { await test.stop() }
  })

  test("failed or cancelled upload never admits a prompt and surfaces its reason", async () => {
    const test = await setup((request) => request.operation === "session.attachment.upload"
      ? { ok: false, code: "message_too_large", message: "Attachment rejected" } : "default")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await test.store.selectSession("ses_a")
      await test.store.sendPrompt({ text: "Review", delivery: "steer", files: [{ uri: "data:image/png;base64,AAAA", name: "capture.png" }] })
      expect(test.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
      expect(test.store.state().uploadError).toContain("Attachment rejected")
    } finally { await test.stop() }
  })
  test("rejects a message exceeding the relay frame before uploading any file", async () => {
    const test = await setup()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await test.store.selectSession("ses_a")
      expect(await test.store.sendPrompt({ text: "x".repeat(32_768), delivery: "steer", files: [{ uri: "data:image/png;base64,AAAA", name: "capture.png" }] })).toBe(false)
      expect(test.store.state().uploadError).toContain("32,768")
      expect(test.relay.requests.some((request) => request.operation === "session.attachment.upload" || request.operation === "session.prompt")).toBe(false)
    } finally { await test.stop() }
  })
  test("cancel stops a multi-chunk upload after its acknowledged chunk without admitting a prompt", async () => {
    const test = await setup((request) => {
      if (request.operation !== "session.attachment.upload") return "default"
      return { ok: true, value: { received: 21_000 } }
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await test.store.selectSession("ses_a")
      const unsubscribe = test.store.subscribe(() => { if (test.store.state().upload?.percent) test.store.cancelUpload() })
      const sent = await test.store.sendPrompt({ text: "Review", delivery: "steer", files: [{ uri: `data:image/png;base64,${Buffer.alloc(100_000, 42).toString("base64")}` }] })
      unsubscribe()
      expect(sent).toBe(false)
      expect(test.relay.requests.filter((request) => request.operation === "session.attachment.upload")).toHaveLength(1)
      expect(test.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
      expect(test.store.state().uploadError).toContain("cancelled")
    } finally { await test.stop() }
  })
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
  test("a frame arriving before the status read cannot be overwritten by that read", async () => {
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
      release?.()
      await Bun.sleep(15)
      expect(test.store.state().sessionStatus?.attention.has("ses_a")).toBe(true)
      test.relay.pushStatus([], ["ses_a"])
      await waitFor(() => test.store.state().sessionStatus?.running.size === 0)
      expect(test.store.state().sessionStatus?.attention.has("ses_a")).toBe(true)
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
      if (request.operation === "session.list" && request.input?.workspace !== undefined && ++lists === 2) await gate
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
      await loadWorkspaces(test.store)
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

  test("activates a slash skill without admitting a user prompt", async () => {
    const test = await setup()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await test.store.selectSession("ses_a")
      expect(await test.store.activateSkill("audit")).toBe(true)
      expect(test.relay.requests.filter((request) => request.operation === "session.skill").map((request) => request.input)).toMatchObject([{ skill: "audit" }])
      expect(test.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(0)
    } finally { await test.stop() }
  })

  test("failed skill activation and goal setup report failure without admitting a prompt", async () => {
    const test = await setup((request) => request.operation === "session.skill" || request.operation === "session.goal.set"
      ? { ok: false, code: "invalid_message", message: "Unavailable" } : "default")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await test.store.selectSession("ses_a")
      expect(await test.store.activateSkill("audit")).toBe(false)
      expect(await test.store.setGoal("Finish safely")).toBe(true)
      await waitFor(() => test.store.state().mutations.some((item) => item.kind === "goal" && item.state === "failed"))
      expect(test.store.state().mutationToasts?.at(-1)).toMatchObject({ label: "Set goal", state: "failed", detail: "Unavailable" })
      expect(test.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(0)
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
  test("re-reads a catalog whose first read failed instead of caching the failure", async () => {
    let failing = true
    const test = await setup((request) => {
      if (request.operation !== "session.catalog") return "default"
      if (failing) return { ok: false, code: "internal_error", message: "Catalog read failed" }
      return { ok: true, value: { agents: [], models: [], commands: [], skills: [], references: [], resources: [] } }
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await test.store.selectSession("ses_a")
      const target = { sessionID: "ses_a" }
      await test.store.loadCatalog(target)
      expect(test.store.state().catalogs["session:ses_a"]).toMatchObject({ status: "error" })
      // A failed read must not become a cached verdict: the model picker stays disabled
      // for as long as the catalog is not ready.
      failing = false
      await test.store.loadCatalog(target)
      expect(test.store.state().catalogs["session:ses_a"]).toMatchObject({ status: "ready" })
      expect(test.relay.requests.filter((request) => request.operation === "session.catalog")).toHaveLength(2)
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
  test("status frames replace family sets and reorder roots without raising a local notice", async () => {
    const test = await setup()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length === 2)
      await waitFor(() => test.store.state().sessionStatus !== undefined)
      test.relay.pushStatus(["ses_b"], ["ses_a"])
      await waitFor(() => test.store.state().sessionStatus?.attention.has("ses_a") === true)
      expect(test.store.state().sessions.map((row) => row.id)).toEqual(["ses_b", "ses_a"])
      expect(test.store.state().notifications).toEqual([])

      test.relay.pushStatus(["ses_a"], ["ses_b"])
      await waitFor(() => test.store.state().sessionStatus?.running.has("ses_a") === true)
      expect(test.store.state().sessions.map((row) => [row.id, row.running, row.attention])).toEqual([
        ["ses_a", true, false], ["ses_b", false, true],
      ])
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
