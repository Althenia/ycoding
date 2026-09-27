import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import { Project } from "@ycoding-ai/schema/project"
import { RemoteLimits, parseChunkedValue, requireSession, type RemoteRequest } from "@ycoding-ai/remote"
import { assertPrivateEndpoint, type LocalLocation, type LocalServer } from "../src/remote-local"
import { LocalFailure as LocalFailureClass } from "../src/remote-local"
import {
  createSessionRegistry,
  createAttachmentUploads,
  createSubscriptions,
  executeRemoteOperation,
  listPage,
  parseListQuery,
  sessionStatus,
  successFrames,
} from "../src/remote-operations"

test("uploaded chunks resolve only for their Session and reach the local prompt as a canonical data URL", async () => {
  const test = await harness({ sessions: [sessionInfo("ses_1", { updated: 1 }), sessionInfo("ses_2", { updated: 1 })], results: { prompt: { id: "msg_1" }, command: { id: "msg_2" } } })
  const uploads = createAttachmentUploads()
  const uploadID = "4ab94d33-6e6b-41a3-a638-f0a6596854a9"
  const send = (index: number, last: boolean, data: string, sessionID = "ses_1") => executeRemoteOperation({ request: { ...request("session.attachment.upload", { uploadID, index, last, data }), sessionID }, uploads, local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
  expect(valueOf(await send(0, false, "aGVs"))).toMatchObject({ received: 3 })
  const uri = `ycoding-upload://${uploadID}`
  const prompt = (sessionID: string) => executeRemoteOperation({ request: { ...request("session.prompt", { text: "Review", files: [{ uri, name: "hello.txt" }] }), sessionID }, uploads, local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
  expect(errorOf(await prompt("ses_1")).code).toBe("invalid_message")
  expect(errorOf(await send(2, true, "bG8=")).code).toBe("invalid_message")
  expect(errorOf(await send(0, true, "bG8=")).code).toBe("invalid_message")
  expect(errorOf(await send(1, true, "bG8=", "ses_2")).code).toBe("invalid_message")
  expect(valueOf(await send(1, true, "bG8="))).toEqual({ uri })
  expect(errorOf(await prompt("ses_2")).code).toBe("invalid_message")
  expect(valueOf(await prompt("ses_1"))).toEqual({ data: { id: "msg_1" } })
  expect(test.calls.find((call) => call.method === "prompt")?.args[2]).toMatchObject({ files: [{ uri: "data:application/octet-stream;base64,aGVsbG8=", name: "hello.txt" }] })
  const command = await executeRemoteOperation({ request: request("session.command", { command: "test", files: [{ uri }] }), uploads, local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
  expect(valueOf(command)).toEqual({ data: { id: "msg_2" } })
  expect(test.calls.find((call) => call.method === "command")?.args[2]).toMatchObject({ files: [{ uri: "data:application/octet-stream;base64,aGVsbG8=" }] })
  uploads.clear()
  expect(errorOf(await prompt("ses_1")).code).toBe("invalid_message")
})

test("upload storage rejects oversize, expires idle buffers and clears on disconnect", () => {
  let now = 0
  const uploads = createAttachmentUploads({ now: () => now })
  const id = "4ab94d33-6e6b-41a3-a638-f0a6596854a9"
  expect(uploads.append("ses_1", id, 0, false, "AAAA")).toEqual({ received: 3 })
  now = RemoteLimits.attachmentTtlMs + 1
  expect(() => uploads.resolve("ses_1", `ycoding-upload://${id}`)).toThrow()
  expect(() => uploads.append("ses_1", id, 1, true, "AAAA")).toThrow()
  const huge = Buffer.alloc(RemoteLimits.maxAttachmentBytes + 1).toString("base64")
  for (let offset = 0, index = 0; offset < huge.length; offset += RemoteLimits.maxAttachmentChunkChars, index++) {
    const chunk = huge.slice(offset, offset + RemoteLimits.maxAttachmentChunkChars)
    if (offset + RemoteLimits.maxAttachmentChunkChars >= huge.length) expect(() => uploads.append("ses_1", id, index, true, chunk)).toThrow()
    else uploads.append("ses_1", id, index, false, chunk)
  }
  expect(() => uploads.resolve("ses_1", `ycoding-upload://${id}`)).toThrow()
  uploads.append("ses_1", id, 0, true, "AAAA")
  uploads.clear()
  expect(() => uploads.resolve("ses_1", `ycoding-upload://${id}`)).toThrow()
})

test("two maximum-size uploads exhaust the bounded connection buffer", () => {
  const uploads = createAttachmentUploads()
  const encoded = Buffer.alloc(RemoteLimits.maxAttachmentBytes).toString("base64")
  try {
    expect(() => uploads.append("ses_1", "4ab94d33-6e6b-41a3-a638-000000000000", 0, false, "YQ==")).toThrow()
    for (const id of ["4ab94d33-6e6b-41a3-a638-f0a6596854a9", "4ab94d33-6e6b-41a3-a638-f0a6596854aa"]) {
      for (let offset = 0, index = 0; offset < encoded.length; offset += RemoteLimits.maxAttachmentChunkChars, index++)
        uploads.append("ses_1", id, index, offset + RemoteLimits.maxAttachmentChunkChars >= encoded.length, encoded.slice(offset, offset + RemoteLimits.maxAttachmentChunkChars))
    }
    expect(() => uploads.append("ses_1", "4ab94d33-6e6b-41a3-a638-f0a6596854ab", 0, true, "AAAA")).toThrow()
  } finally { uploads.clear() }
})

test("small uploads cannot exhaust the agent through unbounded buffer entries", () => {
  const uploads = createAttachmentUploads()
  try {
    for (let index = 0; index < 64; index++)
      uploads.append("ses_1", `4ab94d33-6e6b-41a3-a638-${index.toString(16).padStart(12, "0")}`, 0, true, "AAAA")
    expect(() => uploads.append("ses_1", "4ab94d33-6e6b-41a3-a638-000000000040", 0, true, "AAAA")).toThrow()
  } finally { uploads.clear() }
})

test("window snapshots forward the opaque cursor and managed reads retain scoped not-found and size errors", async () => {
  const digest = "a".repeat(64)
  const test = await harness({ results: {
    snapshot: async (_id: string, _location: LocalLocation, options?: { limit?: number; before?: string }) => ({ sourceEpoch: "epoch_1", session: sessionInfo("ses_1", { updated: 1 }), messages: [], watermark: { seq: 4 }, before: options?.before }),
    attachmentRead: async (_id: string, _location: LocalLocation, value: string) => {
      if (value === "b".repeat(64)) throw new LocalFailureClass("not_found", "unreferenced")
      if (value === "c".repeat(64)) throw new LocalFailureClass("too_large", "oversized")
      return { mime: "image/png", bytes: 3, data: "YWJj" }
    },
  } })
  const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>) => executeRemoteOperation({ request: request(operation, input), local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
  expect(valueOf(await run("session.snapshot", { limit: 2, before: "opaque_cursor" }))).toMatchObject({ before: "opaque_cursor", watermark: { seq: 4 } })
  expect(test.calls.at(-1)).toEqual({ method: "snapshot", args: ["ses_1", { directory: "/work" }, { limit: 2, before: "opaque_cursor" }] })
  expect(errorOf(await run("session.snapshot", { before: "opaque_cursor" })).code).toBe("invalid_message")
  expect(valueOf(await run("session.attachment.read", { digest }))).toEqual({ mime: "image/png", bytes: 3, data: "YWJj" })
  expect(test.calls.at(-1)).toEqual({ method: "attachmentRead", args: ["ses_1", { directory: "/work" }, digest] })
  expect(errorOf(await run("session.attachment.read", { digest: "../wrong" })).code).toBe("invalid_message")
  expect(errorOf(await run("session.attachment.read", { digest: "b".repeat(64) })).code).toBe("not_found")
  expect(errorOf(await run("session.attachment.read", { digest: "c".repeat(64) })).code).toBe("message_too_large")
})

test("windowed snapshots shrink under the relay chunk cap and fail a single oversized message", async () => {
  const messages = [{ id: "msg_old", text: "x".repeat(9 * 1024 * 1024) }, { id: "msg_new", text: "y".repeat(9 * 1024 * 1024) }]
  const test = await harness({ results: { snapshot: async (_id: string, _location: LocalLocation, options?: { limit?: number }) => ({
    sourceEpoch: "epoch_1", session: sessionInfo("ses_1", { updated: 1 }), messages: messages.slice(-(options?.limit ?? 2)),
    watermark: { seq: 4 }, ...(options?.limit === 1 ? { before: "older" } : {}),
  }) } })
  const frames = await executeRemoteOperation({ request: request("session.snapshot", { limit: 2 }), sessions: test.registry, subscriptions: test.subscriptions, local: test.local })
  expect(frames.length).toBeGreaterThan(1)
  expect(frames.length).toBeLessThanOrEqual(RemoteLimits.maxChunksPerResponse)
  const value = parseChunkedValue(frames.map((frame) => frame.ok ? String(frame.value) : ""))
  expect(value).toMatchObject({ ok: true, value: { before: "older", messages: [{ id: "msg_new" }] } })
  expect(test.calls.filter((call) => call.method === "snapshot").map((call) => call.args[2])).toEqual([{ limit: 2 }, { limit: 1 }])

  const oversized = await harness({ results: { snapshot: async () => ({ messages: [{ id: "msg_large", text: "z".repeat(17 * 1024 * 1024) }] }) } })
  expect(errorOf(await executeRemoteOperation({ request: request("session.snapshot", { limit: 1 }), sessions: oversized.registry, subscriptions: oversized.subscriptions, local: oversized.local })).code).toBe("message_too_large")
})

test("a 10 MiB managed attachment fits the bounded relay response without wasting half of each frame", () => {
  const frames = successFrames("req_attachment", { mime: "image/png", bytes: 10 * 1024 * 1024, data: Buffer.alloc(10 * 1024 * 1024).toString("base64") })
  expect(frames.length).toBeGreaterThan(1)
  expect(frames.length).toBeLessThanOrEqual(RemoteLimits.maxChunksPerResponse)
  expect(frames.every((frame) => frame.ok)).toBe(true)
})

test("streamed JSON chunks preserve Unicode across their UTF-8 byte boundary", () => {
  for (const prefix of ["", "p", "pp", "ppp"]) {
    const message = { id: "msg_emoji", text: prefix + "😀".repeat(180_000) }
    const frames = successFrames("req_emoji", message)
    expect(frames.length).toBeGreaterThan(1)
    const bytes = Buffer.concat(frames.map((frame) => Buffer.from(new TextEncoder().encode(String(frame.ok ? frame.value : "")))))
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(message)
  }
})

test("one-message stream carries a large indexed projection in bounded frames", async () => {
  const message = { id: "msg_long", type: "user", text: "long result ".repeat(200_000) }
  const test = await harness({ results: { messageRead: async () => message } })
  const run = (input: Record<string, unknown>) => executeRemoteOperation({ request: request("session.message.stream", input), sessions: test.registry, subscriptions: test.subscriptions, local: test.local })
  const frames = await run({ messageID: "msg_long" })
  expect(frames.length).toBeGreaterThan(1)
  expect(frames.length).toBeLessThanOrEqual(RemoteLimits.maxChunksPerResponse)
  expect(parseChunkedValue(frames.map((frame) => frame.ok ? String(frame.value) : ""))).toMatchObject({ ok: true, value: message })
  expect(errorOf(await run({ messageID: "msg_long", offset: 1 })).code).toBe("invalid_message")
  expect(test.calls.filter((call) => call.method === "messageRead").every((call) => call.args[0] === "ses_1" && recordOf(call.args[1]).directory === "/work")).toBe(true)
})

test("repeated references cannot expand one upload beyond the local admission byte budget", async () => {
  const test = await harness({ results: { prompt: { id: "msg_1" } } })
  const uploads = createAttachmentUploads()
  const uploadID = "4ab94d33-6e6b-41a3-a638-f0a6596854a9"
  const encoded = Buffer.alloc(RemoteLimits.maxAttachmentBytes).toString("base64")
  try {
    for (let offset = 0, index = 0; offset < encoded.length; offset += RemoteLimits.maxAttachmentChunkChars, index++)
      uploads.append("ses_1", uploadID, index, offset + RemoteLimits.maxAttachmentChunkChars >= encoded.length, encoded.slice(offset, offset + RemoteLimits.maxAttachmentChunkChars))
    const uri = `ycoding-upload://${uploadID}`
    const outcome = await executeRemoteOperation({ request: request("session.prompt", { text: "Review", files: [{ uri }, { uri }, { uri }] }), uploads,
      local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
    expect(errorOf(outcome).code).toBe("message_too_large")
    expect(test.calls.some((call) => call.method === "prompt")).toBe(false)
  } finally { uploads.clear() }
})

test("existing global Sessions appear in read-only workspace groups without enabling global creation", async () => {
  const directory = process.cwd()
  const session = { ...sessionInfo("ses_global", { updated: 1, directory }), projectID: Project.ID.global }
  const test = await harness({ sessions: [session], results: { projectList: [] } })
  const requestGroup = (sessionsOnly: boolean) => executeRemoteOperation({ request: request("workspace.list", { sessionsOnly }),
    local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
  expect(valueOf(await requestGroup(true))).toMatchObject({ data: [{ projectID: Project.ID.global, directory }] })
  expect(valueOf(await requestGroup(false))).toEqual({ data: [] })
})

const scratch = join(import.meta.dir, "../../../.cache/tmp")
await mkdir(scratch, { recursive: true })

function sessionInfo(id: string, table: { updated: number; title?: string; directory?: string; parentID?: string }): SessionInfo {
  const directory = table.directory ?? "/work"
  return {
    id,
    ...(table.parentID === undefined ? {} : { parentID: table.parentID }),
    projectID: "prj_1",
    // The contract carries a Model.Ref object, never a provider/model string.
    model: { providerID: "test", id: "model" },
    cost: { amount: 0, currency: "USD" },
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    time: { created: table.updated, updated: table.updated },
    title: table.title ?? id,
    location: { directory, workspaceID: undefined },
  } as unknown as SessionInfo
}

function formInfo(id: string, sessionID: string) {
  return {
    id,
    sessionID,
    title: "Approval",
    metadata: { kind: "question" },
    fields: [{ key: "approved", type: "boolean", title: "Approve?", required: true }],
  }
}

type Call = { readonly method: string; readonly args: readonly unknown[] }

function fakeLocal(results: Partial<Record<keyof LocalServer, unknown>> = {}) {
  const calls: Call[] = []
  const local = new Proxy({} as LocalServer, {
    get(_target, property: PropertyKey) {
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args })
        const result = results[property as keyof LocalServer]
        if (typeof result === "function") return Promise.resolve((result as (...a: unknown[]) => unknown)(...args))
        if (result instanceof Error) return Promise.reject(result)
        return Promise.resolve(result)
      }
    },
  })
  return { local, calls }
}

async function harness(options: {
  results?: Partial<Record<keyof LocalServer, unknown>>
  sessions?: readonly SessionInfo[]
}) {
  const infos = options.sessions ?? [sessionInfo("ses_1", { updated: 1 })]
  // The caller keeps the reference so a test can install a failure after setup.
  const results = options.results ?? {}
  results.listPage ??= async () => ({ data: infos })
  results.getSession ??= async (sessionID: string) => infos.find((info) => info.id === sessionID)
  const { local, calls } = fakeLocal(results)
  const registry = createSessionRegistry({
    local,
  })
  await registry.refresh()
  // Registry verification is setup, not part of the operation under test.
  calls.length = 0
  const subscriptions = createSubscriptions()
  return { local, calls, registry, subscriptions }
}

function request(operation: RemoteRequest["operation"], input?: Record<string, unknown>): RemoteRequest {
  return {
    type: "request",
    id: "req_1",
    operation,
    ...(requireSession(operation) ? { sessionID: "ses_1" } : {}),
    ...(input === undefined ? {} : { input }),
  }
}

/** Read operations this suite maps; the shared contract owns the full operation list. */
const readOperations = [
  "session.get",
  "session.messages",
  "session.snapshot",
  "session.todo.list",
  "session.active",
  "session.log",
  "session.autonomy.get",
  "session.permission.list",
  "session.guardrail.status",
  "session.guardrail.request.list",
  "session.form.list",
  "session.fileChange.list",
] as const

function valueOf(frames: readonly { ok: boolean }[]) {
  expect(frames).toHaveLength(1)
  const frame = frames[0] as { ok: true; value: unknown }
  expect(frame.ok).toBe(true)
  return frame.value
}

function errorOf(frames: readonly { ok: boolean }[]) {
  expect(frames).toHaveLength(1)
  const frame = frames[0] as { ok: false; error: { code: string; message: string } }
  expect(frame.ok).toBe(false)
  return frame.error
}

function recordOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected an object")
  return value
}

function arrayOf(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array")
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

describe("backend Session authorization", () => {
  test("notifies changed metadata when a scoped verification sees it before periodic refresh", async () => {
    let current = sessionInfo("ses_1", { updated: 1, title: "Initial" })
    let invalidations = 0
    const { local } = fakeLocal({ listPage: async () => ({ data: [current] }), getSession: async () => current })
    const registry = createSessionRegistry({ local, onChange: () => invalidations++ })
    await registry.refresh()
    invalidations = 0
    current = { ...current, title: "Renamed" }
    await registry.verify("ses_1")
    expect(invalidations).toBe(1)
    await registry.refresh()
    expect(invalidations).toBe(1)
    current = { ...current, location: { directory: "/work/moved" }, time: { ...current.time, pinned: 2 } }
    await registry.verify("ses_1")
    expect(invalidations).toBe(2)
  })

  test("keeps activity that only advances the updated time out of client list invalidations", async () => {
    let current = sessionInfo("ses_1", { updated: 1, title: "Initial" })
    let invalidations = 0
    const { local } = fakeLocal({ listPage: async () => ({ data: [current] }), getSession: async () => current })
    const registry = createSessionRegistry({ local, onChange: () => invalidations++ })
    await registry.refresh()
    invalidations = 0
    for (let updated = 2; updated <= 50; updated++) {
      current = { ...current, time: { ...current.time, updated } }
      await registry.verify("ses_1")
    }
    await registry.refresh()
    expect(invalidations).toBe(0)
    expect(registry.snapshot().map((session) => session.time.updated)).toEqual([50])
  })

  test("refuses a session absent from the authoritative backend inventory", async () => {
    const { local, registry, subscriptions, calls } = await harness({})
    const outcome = await executeRemoteOperation({
      request: { ...request("session.messages"), sessionID: "ses_other" },
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("session_not_allowed")
    expect(calls.map((call) => call.method)).toEqual(["listPage"])
  })

  test("serves every backend session from the global list", async () => {
    const sessions = [sessionInfo("ses_1", { updated: 2 }), sessionInfo("ses_2", { updated: 1, directory: "/work/two" })]
    const { local, registry, subscriptions } = await harness({
      sessions,
      results: { getSession: async (sessionID: string) => sessions.find((session) => session.id === sessionID) },
    })
    await registry.refresh()
    const outcome = await executeRemoteOperation({ request: request("session.list"), sessions: registry, subscriptions, local })
    const value = valueOf(outcome) as { data: readonly SessionInfo[] }
    expect(value.data.map((session) => session.id)).toEqual(["ses_1", "ses_2"])
    // The relayed session keeps the contract's field shapes: Model.Ref stays an object.
    expect(value.data[0].model).toEqual({ providerID: "test", id: "model" })
  })

  test("always addresses the local server at its backend Location, never a remote value", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      results: { prompt: async () => ({ id: "msg_1" }) },
    })
    const rejected = await executeRemoteOperation({
      request: request("session.prompt", { text: "hi", directory: "/etc" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(rejected).code).toBe("invalid_message")
    expect(calls).toEqual([])

    const accepted = await executeRemoteOperation({
      request: request("session.prompt", { text: "hi" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(accepted)).toEqual({ data: { id: "msg_1" } })
    expect(calls.at(-1)).toEqual({ method: "prompt", args: ["ses_1", { directory: "/work" }, { text: "hi" }] })
  })
})

describe("workspace inventory and Session creation", () => {
  test("passes explicit agent and model choices to the local Session create", async () => {
    const directory = process.cwd()
    const sessions = [sessionInfo("ses_seed", { updated: 1, directory })]
    const test = await harness({ sessions, results: {
      projectList: [{ id: "prj_1", worktree: directory }], projectDirectories: [], projectCurrent: { id: "prj_1", directory },
      createSession: (id: string) => {
        const created = sessionInfo(id, { updated: 2, directory })
        sessions.push(created)
        return created
      },
    } })
    const workspaces = arrayOf(recordOf(valueOf(await executeRemoteOperation({ request: request("workspace.list"), local: test.local,
      sessions: test.registry, subscriptions: test.subscriptions }))).data)
    const model = { providerID: "test", id: "model", variant: "high" }
    const outcome = await executeRemoteOperation({ request: request("session.create", { id: "ses_chosen", workspace: recordOf(workspaces[0]).id,
      agent: "build", model }), local: test.local, sessions: test.registry, subscriptions: test.subscriptions })
    expect(valueOf(outcome)).toMatchObject({ data: { id: "ses_chosen" } })
    expect(test.calls.find((call) => call.method === "createSession")?.args).toEqual(["ses_chosen", { directory }, "build", model])
  })

  test("hides temporary and global creation workspaces while listing existing global Sessions read-only", async () => {
    const directory = process.cwd()
    const sessions = [sessionInfo("ses_allowed", { updated: 1, directory }),
      { ...sessionInfo("ses_global", { updated: 2, directory }), projectID: "global" },
      sessionInfo("ses_temp", { updated: 3, directory: "/tmp" })]
    const test = await harness({ sessions, results: {
      projectList: [{ id: "global", worktree: directory }, { id: "prj_1", worktree: directory }],
      projectDirectories: async () => [{ directory }, { directory: "/tmp" }],
    } })
    for (const input of [undefined, { sessionsOnly: true }]) {
      const value = arrayOf(recordOf(valueOf(await executeRemoteOperation({ request: request("workspace.list", input), local: test.local,
        sessions: test.registry, subscriptions: test.subscriptions }))).data)
      expect(value).toHaveLength(input?.sessionsOnly ? 2 : 1)
      expect(value.find((item) => recordOf(item).projectID === "prj_1")).toMatchObject({ projectID: "prj_1", directory, name: "cli" })
      if (input?.sessionsOnly) expect(value.find((item) => recordOf(item).projectID === "global")).toMatchObject({ projectID: "global", directory })
    }
  })

  test("resolves dot segments so a recorded directory joins and names its workspace", async () => {
    const directory = process.cwd()
    const sessions = [sessionInfo("ses_plain", { updated: 1, directory }), sessionInfo("ses_dotted", { updated: 2, directory: `${directory}/test/..` })]
    const test = await harness({ sessions, results: { projectList: [{ id: "prj_1", worktree: directory }], projectDirectories: async () => [] } })
    for (const input of [undefined, { sessionsOnly: true }]) {
      const value = arrayOf(recordOf(valueOf(await executeRemoteOperation({ request: request("workspace.list", input), local: test.local,
        sessions: test.registry, subscriptions: test.subscriptions }))).data)
      expect(value).toHaveLength(1)
      expect(value[0]).toMatchObject({ projectID: "prj_1", directory, name: "cli" })
      const id = String(recordOf(value[0]).id)
      expect(listPage(sessions, parseListQuery({ workspace: id, limit: 10 })).data.map((session) => session.id)).toEqual(["ses_dotted", "ses_plain"])
    }
  })

  test("uses backend inventory only, rejects changed project and child-ID reuse, and verifies a root create", async () => {
    const directory = await mkdtemp(join(scratch, "ycoding-remote-workspace-unit-"))
    const globalWorktree = await mkdtemp(join(scratch, "ycoding-global-project-worktree-"))
    try {
      let sessions = [sessionInfo("ses_seed", { updated: 1, directory })]
      let currentProjectID = "prj_changed"
      const results: Partial<Record<keyof LocalServer, unknown>> = {
        listPage: async () => ({ data: sessions }),
        getSession: async (sessionID: string) => sessions.find((session) => session.id === sessionID),
        projectList: async () => [
          { id: "global", worktree: globalWorktree, time: { created: 1, updated: 1 }, sandboxes: [] },
          { id: "prj_1", worktree: "/", name: "Test project", time: { created: 1, updated: 1 }, sandboxes: [] },
        ],
        projectDirectories: async (projectID: string) => (projectID === "prj_1" ? [{ directory }] : []),
        projectCurrent: async () => ({ id: currentProjectID, directory: "/" }),
        createSession: async (id: string, location: { directory: string; workspaceID?: string }) => {
          const created = { ...sessionInfo(id, { updated: 2, directory }), location }
          sessions = [...sessions, created]
          return created
        },
      }
      const { local, calls } = fakeLocal(results)
      const registry = createSessionRegistry({ local })
      await registry.refresh()
      calls.length = 0
      const subscriptions = createSubscriptions()
      const inventoryResponse = await executeRemoteOperation({
        request: request("workspace.list"),
        sessions: registry,
        subscriptions,
        local,
      })
      const inventory = arrayOf(recordOf(valueOf(inventoryResponse)).data)
      expect(inventory).toHaveLength(1)
      expect(recordOf(inventory[0])).toMatchObject({ projectID: "prj_1", directory, name: "Test project" })
      expect(inventory.map((workspace) => recordOf(workspace).directory)).not.toContain(globalWorktree)
      expect(calls.some((call) => call.method === "projectCurrent")).toBe(false)
      const workspace = recordOf(inventory[0]).id
      if (typeof workspace !== "string") throw new Error("workspace identifier was missing")

      const changed = await executeRemoteOperation({
        request: request("session.create", { id: "ses_created", workspace }),
        sessions: registry,
        subscriptions,
        local,
      })
      expect(errorOf(changed).code).toBe("invalid_message")
      expect(calls.some((call) => call.method === "createSession")).toBe(false)

      currentProjectID = "prj_1"
      const created = await executeRemoteOperation({
        request: request("session.create", { id: "ses_created", workspace }),
        sessions: registry,
        subscriptions,
        local,
      })
      expect(valueOf(created)).toMatchObject({ data: { id: "ses_created", projectID: "prj_1", location: { directory } } })
      expect(calls.some((call) => call.method === "projectCurrent")).toBe(true)
      expect(calls.find((call) => call.method === "createSession")).toEqual({
        method: "createSession",
        args: ["ses_created", { directory }],
      })

      sessions = [...sessions, sessionInfo("ses_child_taken", { updated: 3, directory, parentID: "ses_seed" })]
      const childReuse = await executeRemoteOperation({
        request: request("session.create", { id: "ses_child_taken", workspace }),
        sessions: registry,
        subscriptions,
        local,
      })
      expect(errorOf(childReuse).code).toBe("invalid_message")
      expect(calls.filter((call) => call.method === "createSession")).toHaveLength(1)

      results.createSession = () => Promise.reject(new LocalFailureClass("transport", "no response"))
      const uncertain = await executeRemoteOperation({
        request: request("session.create", { id: "ses_create_uncertain", workspace }),
        sessions: registry,
        subscriptions,
        local,
      })
      expect(errorOf(uncertain).code).toBe("outcome_unknown")
      expect(calls.filter((call) => call.method === "createSession")).toHaveLength(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
      await rm(globalWorktree, { recursive: true, force: true })
    }
  })
})

describe("operation mapping", () => {
  test("maps global usage reads to their exact local Protocol bodies without a browser Location", async () => {
    const providers = { location: { directory: "/work", project: { id: "prj_1", directory: "/work" } }, data: [{ providerID: "test", status: "available", source: "provider_api", stability: "stable", windows: [] }] }
    const summary = { logical: 1, physical: 1, tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }
    const report = { group: "model", rows: [], total: summary, rowCount: 0 }
    const test = await harness({ results: { providerUsageList: providers, usageSummary: summary, usageReport: report } })
    const runUsage = (operation: RemoteRequest["operation"], input?: Record<string, unknown>) => executeRemoteOperation({
      request: request(operation, input), local: test.local, sessions: test.registry, subscriptions: test.subscriptions,
    })
    expect(valueOf(await runUsage("usage.providers", { refresh: true }))).toEqual({ data: providers.data })
    expect(valueOf(await runUsage("usage.summary"))).toEqual({ data: summary })
    expect(valueOf(await runUsage("usage.report", { group: "model", from: 0, to: 10, limit: 2, sort: "cost", order: "desc" }))).toEqual({ data: report })
    expect(test.calls.filter((call) => ["providerUsageList", "usageSummary", "usageReport"].includes(call.method))).toEqual([
      { method: "providerUsageList", args: [true] }, { method: "usageSummary", args: [] },
      { method: "usageReport", args: [{ group: "model", from: 0, to: 10, limit: 2, sort: "cost", order: "desc" }] },
    ])
    test.calls.length = 0
    expect(errorOf(await runUsage("usage.report", { group: "model", limit: 201 })).code).toBe("invalid_message")
    expect(test.calls.some((call) => call.method === "usageReport")).toBe(false)
  })

  test("a cached-attention status still refuses more than 500 running roots", async () => {
    const sessions = Array.from({ length: RemoteLimits.maxStatusSessions + 1 }, (_, index) => sessionInfo(`ses_${index}`, { updated: index }))
    const { local } = fakeLocal({ activeSessions: Object.fromEntries(sessions.map((session) => [session.id, { type: "running" }])) })
    const failure = await sessionStatus(local, sessions, []).then(() => undefined, (cause: unknown) => cause)
    expect(failure instanceof Error ? failure.message : undefined).toBe("Session status exceeds the bounded root count")
  })

  test("status reads pending requests only at Locations with an executing Session", async () => {
    const directory = process.cwd()
    const idleLocation = join(directory, "src")
    const sessions = [
      sessionInfo("ses_root", { updated: 1, directory }),
      sessionInfo("ses_child", { updated: 2, directory, parentID: "ses_root" }),
      sessionInfo("ses_idle", { updated: 3, directory }),
      sessionInfo("ses_elsewhere", { updated: 4, directory: idleLocation }),
      sessionInfo("ses_gone", { updated: 5, directory: "/nonexistent/ycoding-removed-workspace" }),
    ]
    const idleRead = new Error("an idle Location was read for status")
    const { local, calls } = fakeLocal({
      activeSessions: { ses_child: { type: "running" } },
      permissionRequests: async (location: LocalLocation) => location.directory === directory ? [{ id: "per_1", sessionID: "ses_child" }] : Promise.reject(idleRead),
      formRequests: async (location: LocalLocation) => location.directory === directory ? [formInfo("frm_1", "ses_idle")] : Promise.reject(idleRead),
      guardrailRequestList: async () => [],
    })
    expect(await sessionStatus(local, sessions)).toEqual({ running: ["ses_root"], attention: ["ses_idle", "ses_root"] })
    expect(calls.filter((call) => call.method === "permissionRequests").map((call) => call.args[0])).toEqual([{ directory }])
    expect(calls.filter((call) => call.method === "formRequests").map((call) => call.args[0])).toEqual([{ directory }])
    expect(calls.filter((call) => call.method === "guardrailRequestList").map((call) => call.args[0])).toEqual(["ses_root"])
    expect(calls.some((call) => call.method === "permissionList" || call.method === "formList")).toBe(false)
  })

  test("status folds active descendants and unresolved requests to unique root IDs", async () => {
    const directory = process.cwd()
    const sessions = [sessionInfo("ses_root", { updated: 1, directory }), sessionInfo("ses_child", { updated: 2, parentID: "ses_root", directory }), sessionInfo("ses_other", { updated: 3, directory })]
    const { local, registry, subscriptions } = await harness({ sessions, results: {
      activeSessions: { ses_child: { type: "running" } },
      permissionRequests: async () => [{ id: "per_1", sessionID: "ses_child" }],
      formRequests: async () => [formInfo("frm_1", "ses_other")],
      guardrailRequestList: async (id: string) => id === "ses_root" ? [{ id: "grq_1", sessionID: "ses_child", rootSessionID: id }] : [],
    } })
    const outcome = await executeRemoteOperation({ request: request("session.status"), local, sessions: registry, subscriptions })
    expect(valueOf(outcome)).toEqual({ running: ["ses_root"], attention: ["ses_other", "ses_root"] })
  })

  test("catalog and file finder read only the verified Location and project workspace", async () => {
    const directory = process.cwd()
    const session = sessionInfo("ses_1", { updated: 1, directory })
    const results: Partial<Record<keyof LocalServer, unknown>> = {
      projectList: [{ id: "prj_1", worktree: directory, name: "Project", time: { created: 1, updated: 1 }, sandboxes: [] }],
      projectDirectories: [],
      projectCurrent: { id: "prj_1", directory },
      agentList: [{ id: "build", name: "Builder", mode: "primary", hidden: false, description: "Build", model: { providerID: "test", id: "model" }, permissions: [], request: {} }],
      providerList: [{ id: "test", name: "Test", package: "test" }, { id: "off", name: "Off", disabled: true, package: "off" }],
      modelList: [{ providerID: "test", id: "model", name: "Model", enabled: true, variants: [{ id: "high" }] }, { providerID: "off", id: "hidden", name: "Hidden", enabled: true, variants: [] }],
      modelDefault: { providerID: "test", id: "model" },
      commandList: [{ name: "test", template: "example", description: "Test" }],
      skillList: [{ id: "skill", name: "Skill", description: "Help", slash: true, content: "secret" }],
      referenceList: [{ name: "Readme", path: join(directory, "README.md"), source: { type: "file" } }],
      resourceCatalog: { resources: [{ name: "Docs", uri: "mcp://docs" }], templates: [] },
      fileFind: [{ path: "package.json", type: "file" }],
    }
    const { local, registry, subscriptions, calls } = await harness({ sessions: [session], results })
    const catalog = valueOf(await executeRemoteOperation({ request: request("session.catalog"), local, sessions: registry, subscriptions }))
    expect(catalog).toEqual({ agents: [{ id: "build", name: "Builder", mode: "primary", hidden: false, description: "Build", model: { providerID: "test", id: "model" } }],
      models: [{ providerID: "test", providerName: "Test", id: "model", name: "Model", variants: ["high"] }],
      defaultModel: { providerID: "test", id: "model" }, commands: [{ name: "test", description: "Test" }],
      skills: [{ id: "skill", name: "Skill", description: "Help", slash: true }],
      references: [{ name: "Readme", uri: pathToFileURL(join(directory, "README.md")).href }], resources: [{ name: "Docs", uri: "mcp://docs" }] })
    const workspace = recordOf(arrayOf(recordOf(valueOf(await executeRemoteOperation({ request: request("workspace.list"), local, sessions: registry, subscriptions }))).data)[0]).id
    expect(workspace).toBeDefined()
    const same = valueOf(await executeRemoteOperation({ request: request("workspace.catalog", { workspace }), local, sessions: registry, subscriptions }))
    expect(same).toEqual(catalog)
    const files = valueOf(await executeRemoteOperation({ request: request("session.file.find", { query: "package", limit: 1 }), local, sessions: registry, subscriptions }))
    expect(files).toEqual({ files: [{ path: "package.json", uri: pathToFileURL(join(directory, "package.json")).href, kind: "file" }] })
    expect(calls.filter((call) => call.method === "fileFind").at(-1)?.args).toEqual([{ directory }, "package", 1])
    expect(errorOf(await executeRemoteOperation({ request: request("workspace.catalog", { workspace: "wsp_missing" }), local, sessions: registry, subscriptions })).code).toBe("invalid_message")
  })

  test("fails a catalog read on a missing source or oversized list instead of publishing partial or sensitive data", async () => {
    const results: Partial<Record<keyof LocalServer, unknown>> = {
      agentList: [], modelList: [], modelDefault: null, providerList: [], commandList: [], skillList: [],
      referenceList: [], resourceCatalog: { resources: [], templates: [] },
    }
    const test = await harness({ results })
    results.modelList = new LocalFailureClass("server", "Provider unavailable")
    expect(errorOf(await executeRemoteOperation({ request: request("session.catalog"), local: test.local,
      sessions: test.registry, subscriptions: test.subscriptions })).code).toBe("internal_error")
    results.modelList = Array.from({ length: 501 }, (_, index) => ({ id: `m${index}`, providerID: "test", name: "Model", variants: [] }))
    expect(errorOf(await executeRemoteOperation({ request: request("session.catalog"), local: test.local,
      sessions: test.registry, subscriptions: test.subscriptions })).code).toBe("message_too_large")
  })

  test("switches model and agent, admits commands and skills, and passes explicit create choices", async () => {
    const { local, registry, subscriptions, calls } = await harness({ results: {
      switchModel: undefined, switchAgent: undefined, command: { id: "msg_command" }, skill: undefined,
    } })
    const invoke = (operation: RemoteRequest["operation"], payload: Record<string, unknown>) => executeRemoteOperation({ request: request(operation, payload), local, sessions: registry, subscriptions })
    expect(valueOf(await invoke("session.switchModel", { model: { providerID: "test", id: "model" } }))).toBeNull()
    expect(valueOf(await invoke("session.switchAgent", { agent: "build" }))).toBeNull()
    expect(valueOf(await invoke("session.command", { command: "test", arguments: "--x" }))).toEqual({ data: { id: "msg_command" } })
    expect(valueOf(await invoke("session.skill", { skill: "skill" }))).toBeNull()
    expect(calls.filter((call) => ["switchModel", "switchAgent", "command", "skill"].includes(call.method))).toEqual([
      { method: "switchModel", args: ["ses_1", { directory: "/work" }, { providerID: "test", id: "model" }] },
      { method: "switchAgent", args: ["ses_1", { directory: "/work" }, "build"] },
      { method: "command", args: ["ses_1", { directory: "/work" }, { command: "test", arguments: "--x" }] },
      { method: "skill", args: ["ses_1", { directory: "/work" }, { skill: "skill" }] },
    ])
  })

  test("refuses file attachments outside the real Session root before a mutation", async () => {
    const directory = process.cwd()
    const session = sessionInfo("ses_1", { updated: 1, directory })
    const { local, registry, subscriptions, calls } = await harness({ sessions: [session], results: {
      prompt: { id: "msg_1" }, command: { id: "msg_2" }, referenceList: [{ name: "Shared", path: "/shared/ref.md" }], resourceCatalog: { resources: [], templates: [] },
      agentList: [], modelList: [], modelDefault: null, providerList: [], commandList: [], skillList: [],
    } })
    const invoke = (operation: "session.prompt" | "session.command", uri: string) => executeRemoteOperation({
      request: request(operation, { ...(operation === "session.prompt" ? { text: "hi" } : { command: "test" }), files: [{ uri }] }),
      local, sessions: registry, subscriptions,
    })
    expect(valueOf(await invoke("session.prompt", pathToFileURL(join(directory, "package.json")).href))).toEqual({ data: { id: "msg_1" } })
    expect(valueOf(await invoke("session.command", "file:///shared/ref.md"))).toEqual({ data: { id: "msg_2" } })
    calls.length = 0
    expect(errorOf(await invoke("session.prompt", "file:///etc/passwd")).code).toBe("invalid_message")
    expect(calls.some((call) => call.method === "prompt")).toBe(false)
    for (const uri of ["https://example.com/a", "file:///etc/passwd", "file:///work/../etc/passwd", "mcp://unknown"])
      expect(errorOf(await invoke("session.command", uri)).code).toBe("invalid_message")
    expect(calls.filter((call) => call.method === "command")).toEqual([])
  })

  test("refuses a file URL whose symlink escapes the Session Location", async () => {
    const directory = await mkdtemp(join(scratch, "ycoding-attachment-"))
    try {
      await symlink("/etc/passwd", join(directory, "escape.txt"))
      const test = await harness({ sessions: [sessionInfo("ses_1", { updated: 1, directory })], results: { prompt: { id: "msg_1" },
        agentList: [], modelList: [], modelDefault: null, providerList: [], commandList: [], skillList: [], referenceList: [],
        resourceCatalog: { resources: [], templates: [] } } })
      const outcome = await executeRemoteOperation({ request: request("session.prompt", { text: "Read it", files: [{ uri: pathToFileURL(join(directory, "escape.txt")).href }] }),
        sessions: test.registry, subscriptions: test.subscriptions, local: test.local })
      expect(errorOf(outcome).code).toBe("invalid_message")
      expect(test.calls.some((call) => call.method === "prompt")).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  test("reads the bounded direct-child task page at the verified parent Location", async () => {
    const page = { data: [{ sessionID: "ses_child", parentID: "ses_1", state: "running", revision: 1 }], summary: { total: 1, active: 1, running: 1, waiting: 0 }, cursor: { next: "opaque" } }
    const { local, registry, subscriptions, calls } = await harness({ results: { subagentPage: async () => page } })
    const outcome = await executeRemoteOperation({ request: request("session.subagent.list", { cursor: "opaque" }), sessions: registry, subscriptions, local })
    expect(valueOf(outcome)).toEqual(page)
    expect(calls.at(-1)).toEqual({ method: "subagentPage", args: ["ses_1", { directory: "/work" }, "opaque"] })
    expect(calls.some((call) => call.method === "getSession")).toBe(true)

    calls.length = 0
    const missing = await executeRemoteOperation({ request: { ...request("session.subagent.list"), sessionID: "ses_missing" }, sessions: registry, subscriptions, local })
    expect(errorOf(missing).code).toBe("session_not_allowed")
    expect(calls.some((call) => call.method === "subagentPage")).toBe(false)
  })
  test("maps each mutation onto its exact Protocol call and payload", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      results: {
        prompt: async () => ({ id: "msg_1" }),
        interrupt: async () => undefined,
        permissionReply: async () => undefined,
        guardrailReply: async () => undefined,
        formList: async () => [formInfo("frm_1", "ses_1"), formInfo("frm_2", "ses_1")],
        formReply: async () => undefined,
        formCancel: async () => undefined,
        autonomySet: async () => ({ mode: "yolo" }),
        guardrailRequestList: async () => [{ id: "grq_1", sessionID: "ses_1", rootSessionID: "ses_1" }],
        agentList: [], modelList: [], modelDefault: null, providerList: [], commandList: [], skillList: [], referenceList: [],
        resourceCatalog: { resources: [{ name: "Accepted", uri: "mcp://accepted" }], templates: [] },
      },
    })

    const prompt = await executeRemoteOperation({
      request: request("session.prompt", {
        id: "msg_1",
        text: "hello",
        files: [{ uri: "mcp://accepted", name: "a.ts" }],
        agents: [{ name: "build" }],
        delivery: "queue",
        resume: false,
      }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(prompt)).toEqual({ data: { id: "msg_1" } })
    expect(calls.at(-1)).toEqual({
      method: "prompt",
      args: [
        "ses_1",
        { directory: "/work" },
        {
          id: "msg_1",
          text: "hello",
          files: [{ uri: "mcp://accepted", name: "a.ts" }],
          agents: [{ name: "build" }],
          delivery: "queue",
          resume: false,
        },
      ],
    })

    await executeRemoteOperation({ request: request("session.interrupt"), sessions: registry, subscriptions, local })
    expect(calls.at(-1)).toEqual({ method: "interrupt", args: ["ses_1", { directory: "/work" }] })

    await executeRemoteOperation({
      request: request("session.permission.reply", { requestID: "per_1", reply: "always", message: "ok" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({ method: "permissionReply", args: ["ses_1", { directory: "/work" }, "per_1", "always", "ok"] })

    await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_1", reply: "once" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({ method: "guardrailReply", args: ["ses_1", { directory: "/work" }, "grq_1", "once"] })

    await executeRemoteOperation({
      request: request("session.form.reply", { formID: "frm_1", answer: { choice: ["yes"], approved: true } }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({
      method: "formReply",
      args: ["ses_1", { directory: "/work" }, "frm_1", { choice: ["yes"], approved: true }],
    })

    await executeRemoteOperation({
      request: request("session.form.cancel", { formID: "frm_2" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({ method: "formCancel", args: ["ses_1", { directory: "/work" }, "frm_2"] })

    await executeRemoteOperation({
      request: request("session.autonomy.set", { yolo: 3, maxNoProgress: 2 }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({
      method: "autonomySet",
      args: ["ses_1", { directory: "/work" }, { yolo: 3, maxNoProgress: 2 }],
    })

    await executeRemoteOperation({
      request: request("session.goal.set", { goal: "ship it" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({
      method: "autonomySet",
      args: ["ses_1", { directory: "/work" }, { goal: "ship it" }],
    })

    await executeRemoteOperation({
      request: request("session.goal.stop", {}),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({ method: "autonomySet", args: ["ses_1", { directory: "/work" }, { goal: null }] })
  })

  test("returns each read body verbatim and validates subscriptions without owning relay state", async () => {
    const snapshot = { sourceEpoch: "epoch_1", session: sessionInfo("ses_1", { updated: 1 }), messages: [], watermark: { seq: 4 } }
    const { local, registry, subscriptions, calls } = await harness({
      results: {
        snapshot: async () => snapshot,
        todoList: async () => [{ content: "Run tests", status: "in_progress", priority: "high" }],
        messages: async () => [{ id: "msg_1" }],
        log: async () => [{ id: "evt_1" }],
        autonomyGet: async () => ({ mode: "normal" }),
        permissionList: async () => [{ id: "per_1", sessionID: "ses_1" }],
        guardrailStatus: async () => ({ profile: "standard" }),
        guardrailRequestList: async () => [],
        formList: async () => [formInfo("frm_1", "ses_1")],
        fileChangeList: async () => [{ path: "a.ts" }],
      },
    })

    expect(valueOf(await executeRemoteOperation({ request: request("session.snapshot"), sessions: registry, subscriptions, local }))).toEqual(snapshot)
    expect(valueOf(await executeRemoteOperation({ request: request("session.todo.list"), sessions: registry, subscriptions, local }))).toEqual({ data: [{ content: "Run tests", status: "in_progress", priority: "high" }] })
    expect(calls.at(-1)).toEqual({ method: "todoList", args: ["ses_1", { directory: "/work" }] })
    expect(valueOf(await executeRemoteOperation({ request: request("session.messages"), sessions: registry, subscriptions, local }))).toEqual({ data: [{ id: "msg_1" }] })
    expect(valueOf(await executeRemoteOperation({ request: request("session.log", { after: 4 }), sessions: registry, subscriptions, local }))).toEqual({ data: [{ id: "evt_1" }] })
    expect(valueOf(await executeRemoteOperation({ request: request("session.autonomy.get"), sessions: registry, subscriptions, local }))).toEqual({ data: { mode: "normal" } })
    expect(valueOf(await executeRemoteOperation({ request: request("session.permission.list"), sessions: registry, subscriptions, local }))).toEqual({ data: [{ id: "per_1", sessionID: "ses_1" }] })
    expect(valueOf(await executeRemoteOperation({ request: request("session.guardrail.status"), sessions: registry, subscriptions, local }))).toEqual({ data: { profile: "standard" } })
    expect(valueOf(await executeRemoteOperation({ request: request("session.form.list", {}), sessions: registry, subscriptions, local }))).toEqual([formInfo("frm_1", "ses_1")])
    expect(valueOf(await executeRemoteOperation({ request: request("session.fileChange.list"), sessions: registry, subscriptions, local }))).toEqual({ data: [{ path: "a.ts" }] })
    expect(calls.filter((call) => call.method === "log").at(-1)).toEqual({ method: "log", args: ["ses_1", { directory: "/work" }, 4] })

    const before = calls.filter((call) => call.method !== "getSession").length
    expect(valueOf(await executeRemoteOperation({ request: request("session.subscribe"), sessions: registry, subscriptions, local }))).toBeNull()
    expect(valueOf(await executeRemoteOperation({ request: request("session.subscribe"), sessions: registry, subscriptions, local }))).toBeNull()
    expect(valueOf(await executeRemoteOperation({ request: request("session.unsubscribe"), sessions: registry, subscriptions, local }))).toBeNull()
    expect(calls.filter((call) => call.method !== "getSession").slice(before).map((call) => call.method)).toEqual([
      "listPage",
      "listPage",
      "listPage",
    ])
    expect(subscriptions.count("ses_1")).toBe(0)
    expect(subscriptions.has("ses_1")).toBe(false)
    expect(valueOf(await executeRemoteOperation({ request: request("session.unsubscribe"), sessions: registry, subscriptions, local }))).toBeNull()
    expect(subscriptions.has("ses_1")).toBe(false)
  })

  test("maps every shared read operation the relay advertises", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      // `session.get` is served by the verification read itself, so the default
      // session info stands in for it.
      results: Object.fromEntries(
        readOperations
          .filter((operation) => operation !== "session.get")
          .map((operation) => [readMethod(operation), async () => []]),
      ),
    })
    for (const operation of readOperations) {
      const outcome = await executeRemoteOperation({
        request: operation === "session.log" ? request(operation, { after: 0 }) : request(operation),
        sessions: registry,
        subscriptions,
        local,
      })
      expect({ operation, frame: outcome[0] }).toMatchObject({ operation, frame: { ok: true } })
    }
    // `session.get` itself is the verification read, so it is counted below.
    expect(calls.filter((call) => call.method !== "getSession" && call.method !== "listPage").map((call) => call.method)).toEqual(
      readOperations.map(readMethod).filter((method) => method !== "getSession"),
    )
    // Every session-scoped read resolves and verifies its current backend Location.
    const scoped = readOperations.filter(requireSession)
    expect(calls.filter((call) => call.method === "getSession")).toHaveLength(scoped.length)
  })

  test("reports running status for shared sessions only", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      sessions: [sessionInfo("ses_1", { updated: 1 })],
      results: {
        activeSessions: async () => ({ ses_1: { type: "running" }, ses_hidden: { type: "running" } }),
      },
    })
    const outcome = await executeRemoteOperation({
      request: request("session.active"),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(outcome)).toEqual({ data: { ses_1: { type: "running" } } })
    expect(calls.filter((call) => call.method === "activeSessions")).toHaveLength(1)
    expect(calls.filter((call) => call.method === "listPage")).toEqual([])

    const rejected = await executeRemoteOperation({
      request: request("session.active", { sessionID: "ses_1" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(rejected).code).toBe("invalid_message")
  })

  test("follows the backend's authoritative current Location after a Session moves", async () => {
    const moved = sessionInfo("ses_1", { updated: 1, directory: "/work/moved" })
    const results: Partial<Record<keyof LocalServer, unknown>> = {
      getSession: async () => moved,
      listPage: async () => ({ data: [moved] }),
      messages: async () => [{ id: "msg_1" }],
    }
    const { local, calls } = fakeLocal(results)
    const registry = createSessionRegistry({
      local,
    })
    await registry.refresh()
    calls.length = 0

    const outcome = await executeRemoteOperation({
      request: request("session.messages"),
      sessions: registry,
      subscriptions: createSubscriptions(),
      local,
    })
    expect(valueOf(outcome)).toEqual({ data: [{ id: "msg_1" }] })
    expect(calls.at(-1)).toEqual({ method: "messages", args: ["ses_1", { directory: "/work/moved" }] })
  })
})

function readMethod(operation: (typeof readOperations)[number]) {
  const method: Record<(typeof readOperations)[number], keyof LocalServer> = {
    "session.get": "getSession",
    "session.messages": "messages",
    "session.snapshot": "snapshot",
    "session.todo.list": "todoList",
    "session.active": "activeSessions",
    "session.log": "log",
    "session.autonomy.get": "autonomyGet",
    "session.permission.list": "permissionList",
    "session.guardrail.status": "guardrailStatus",
    "session.guardrail.request.list": "guardrailRequestList",
    "session.form.list": "formList",
    "session.fileChange.list": "fileChangeList",
  }
  return method[operation]
}

describe("native Form ownership", () => {
  test("replies to and cancels only pending forms owned by the addressed Session", async () => {
    const pending = [
      formInfo("frm_owned", "ses_1"),
      formInfo("frm_cross", "ses_other"),
      formInfo("frm_global", "global"),
    ]
    const { local, registry, subscriptions, calls } = await harness({
      results: {
        formList: async () => pending,
        formReply: async () => undefined,
        formCancel: async () => undefined,
      },
    })

    const replied = await executeRemoteOperation({
      request: request("session.form.reply", { formID: "frm_owned", answer: { approved: true } }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(replied)).toBeNull()
    expect(calls.at(-1)).toEqual({
      method: "formReply",
      args: ["ses_1", { directory: "/work" }, "frm_owned", { approved: true }],
    })

    for (const formID of ["frm_cross", "frm_global", "frm_unknown"]) {
      const before = calls.filter((call) => call.method === "formReply" || call.method === "formCancel").length
      const refused = await executeRemoteOperation({
        request: request("session.form.cancel", { formID }),
        sessions: registry,
        subscriptions,
        local,
      })
      expect(errorOf(refused).code).toBe("invalid_message")
      expect(calls.filter((call) => call.method === "formReply" || call.method === "formCancel")).toHaveLength(before)
    }
  })
})

describe("family-wide guardrail reviews", () => {
  test("keeps reviews for every backend Session and preserves explicit replies", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      results: {
        guardrailRequestList: async () => ({
          data: [
            { id: "grq_mine", sessionID: "ses_1", rootSessionID: "ses_1" },
            { id: "grq_sibling", sessionID: "ses_child", rootSessionID: "ses_1" },
          ],
        }),
        guardrailReply: async () => undefined,
      },
    })
    const listed = await executeRemoteOperation({
      request: request("session.guardrail.request.list"),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(listed)).toEqual({
      data: [
        { id: "grq_mine", sessionID: "ses_1", rootSessionID: "ses_1" },
        { id: "grq_sibling", sessionID: "ses_child", rootSessionID: "ses_1" },
      ],
    })

    const sibling = await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_sibling", reply: "once" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(sibling)).toBeNull()
    expect(calls.some((call) => call.method === "guardrailReply")).toBe(true)

    const allowed = await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_mine", reply: "once" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(allowed)).toBeNull()
    expect(calls.at(-1)).toEqual({ method: "guardrailReply", args: ["ses_1", { directory: "/work" }, "grq_mine", "once"] })
  })

  test("refuses an unknown review and allows a granted child addressed through the root", async () => {
    const infos = [sessionInfo("ses_1", { updated: 1 }), sessionInfo("ses_child", { updated: 1, parentID: "ses_1" })]
    const { local, registry, subscriptions, calls } = await harness({
      sessions: infos,
      results: {
        getSession: async (sessionID: string) => infos.find((info) => info.id === sessionID),
        guardrailRequestList: async () => [{ id: "grq_child", sessionID: "ses_child", rootSessionID: "ses_1" }],
        guardrailReply: async () => undefined,
      },
    })
    await registry.refresh()

    const unknown = await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_missing", reply: "reject" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(unknown).code).toBe("invalid_message")

    const throughRoot = await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_child", reply: "reject" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(throughRoot)).toBeNull()
    expect(calls.at(-1)).toEqual({
      method: "guardrailReply",
      args: ["ses_1", { directory: "/work" }, "grq_child", "reject"],
    })
  })
})

describe("session shell output read", () => {
  const ownedShell = { id: "sh_1", status: "exited", metadata: { sessionID: "ses_1" } }

  async function shellHarness(results: Partial<Record<keyof LocalServer, unknown>> = {}) {
    return harness({
      results: {
        shellGet: async () => ownedShell,
        shellOutput: async () => ({ output: "page", cursor: 4, size: 4, truncated: false }),
        ...results,
      },
    })
  }

  test("refuses a shell owned by another Session before reading any output", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness({
      shellGet: async () => ({ id: "sh_1", metadata: { sessionID: "ses_2" } }),
    })
    const outcome = await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_1" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("forbidden")
    // The refused read never reaches the local output route, so no bytes are copied.
    expect(calls.some((call) => call.method === "shellOutput")).toBe(false)
    expect(JSON.stringify(outcome)).not.toContain("page")
  })

  test("refuses a shell whose owning Session is not recorded", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness({
      shellGet: async () => ({ id: "sh_1", metadata: {} }),
    })
    const outcome = await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_1" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("forbidden")
    expect(calls.some((call) => call.method === "shellOutput")).toBe(false)
  })

  test("returns the stored page verbatim after verifying ownership at the session location", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness()
    const outcome = await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_1", cursor: 0, limit: 2_048 }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(outcome)).toEqual({ data: { output: "page", cursor: 4, size: 4, truncated: false } })
    expect(calls.filter((call) => call.method === "shellGet")).toEqual([
      { method: "shellGet", args: ["sh_1", { directory: "/work" }] },
    ])
    expect(calls.at(-1)).toEqual({
      method: "shellOutput",
      args: ["sh_1", { directory: "/work" }, { cursor: 0, limit: 2_048 }],
    })
  })

  test("defaults to one bounded local page when the page size is omitted", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness()
    await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_1" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({ method: "shellOutput", args: ["sh_1", { directory: "/work" }, { limit: 65_536 }] })
  })

  test("rejects page inputs and unknown fields before any local call", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness()
    const cases = [
      {},
      { shellID: "sh" },
      { shellID: "../etc/passwd" },
      { shellID: "sh_1/../../etc/passwd" },
      { shellID: 4 },
      { shellID: "sh_1", cursor: -1 },
      { shellID: "sh_1", cursor: 1.5 },
      { shellID: "sh_1", limit: 0 },
      { shellID: "sh_1", limit: 1.5 },
      { shellID: "sh_1", limit: 65_537 },
      { shellID: "sh_1", path: "/tmp/shell.out" },
      { shellID: "sh_1", file: "/tmp/shell.out" },
    ]
    for (const input of cases) {
      calls.length = 0
      const outcome = await executeRemoteOperation({
        request: request("session.shell.output", input),
        sessions: registry,
        subscriptions,
        local,
      })
      expect({ input, code: errorOf(outcome).code }).toMatchObject({ input, code: "invalid_message" })
      expect(calls).toEqual([])
    }
  })

  test("maps a shell that is gone to a closed error without reading output", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness({
      shellGet: () => Promise.reject(new LocalFailureClass("not_found", "gone")),
    })
    const outcome = await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_missing" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("invalid_message")
    expect(calls.some((call) => call.method === "shellOutput")).toBe(false)
  })

  test("refuses a backend-unknown Session before any scoped local call", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness()
    const outcome = await executeRemoteOperation({
      request: { ...request("session.shell.output", { shellID: "sh_1" }), sessionID: "ses_other" },
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("session_not_allowed")
    expect(calls.map((call) => call.method)).toEqual(["listPage"])
  })
})

describe("strict validation and error mapping", () => {
  test("rejects unknown fields, malformed values, and unknown operations before any local call", async () => {
    const { local, registry, subscriptions, calls } = await harness({})
    const cases: Array<[RemoteRequest, string]> = [
      [request("session.prompt", { text: "hi", metadata: {} }), "invalid_message"],
      [request("session.prompt", {}), "invalid_message"],
      [request("session.prompt", { text: "hi", id: "per_1" }), "invalid_message"],
      [request("session.prompt", { text: "hi", delivery: "now" }), "invalid_message"],
      [request("session.prompt", { text: "hi", files: [{ uri: 4 }] }), "invalid_message"],
      [request("session.log", { after: -1 }), "invalid_message"],
      [request("session.subagent.list", { cursor: "" }), "invalid_message"],
      [request("session.subagent.list", { limit: 11 }), "invalid_message"],
      [request("session.subagent.list", { directory: "/etc" }), "invalid_message"],
      [request("session.permission.reply", { requestID: "grq_1", reply: "once" }), "invalid_message"],
      [request("session.permission.reply", { requestID: "per_1", reply: "maybe" }), "invalid_message"],
      [request("session.form.reply", { formID: "frm_1", answer: { invalid: { nested: true } } }), "invalid_message"],
      [request("session.form.cancel", { formID: "bad" }), "invalid_message"],
      [request("session.autonomy.set", { yolo: 9 }), "invalid_message"],
      [request("session.autonomy.set", {}), "invalid_message"],
      [request("session.goal.set", { goal: "" }), "invalid_message"],
      [request("session.goal.stop", { goal: "stop" }), "invalid_message"],
      [request("session.list", { limit: 0 }), "invalid_message"],
      [request("session.list", { order: "sideways" }), "invalid_message"],
      [request("workspace.list", { directory: "/etc" }), "invalid_message"],
      [request("session.create", { id: "invalid", workspace: "wsp_1" }), "invalid_message"],
      [request("session.create", { id: "ses_new", workspace: "wsp_1", directory: "/etc" }), "invalid_message"],
      [request("session.get", { directory: "/etc" }), "invalid_message"],
      [request("session.active", { limit: 1 }), "invalid_message"],
      // A frame outside the shared contract; the relay parser rejects it before this layer.
      [{ ...request("session.get"), operation: "session.unknown" as RemoteRequest["operation"] }, "unknown_operation"],
    ]
    for (const [frame, code] of cases) {
      calls.length = 0
      const outcome = await executeRemoteOperation({ request: frame, sessions: registry, subscriptions, local })
      expect(errorOf(outcome).code).toBe(code)
      expect(calls).toEqual([])
    }
  })

  test("maps local failures onto the relay error vocabulary without replaying mutations", async () => {
    const cases: Array<[keyof LocalServer, unknown, string, readonly string[]]> = [
      ["messages", new LocalFailureClass("not_found", "gone"), "session_not_allowed", ["session.messages"]],
      ["permissionReply", new LocalFailureClass("not_found", "gone"), "invalid_message", ["session.permission.reply"]],
      ["prompt", new LocalFailureClass("transport", "no answer"), "outcome_unknown", ["session.prompt"]],
      ["messages", new LocalFailureClass("transport", "no answer"), "internal_error", ["session.messages"]],
      ["prompt", new LocalFailureClass("conflict", "conflict"), "invalid_message", ["session.prompt"]],
      ["messages", new LocalFailureClass("too_large", "big"), "message_too_large", ["session.messages"]],
      ["getSession", new LocalFailureClass("server", "boom"), "internal_error", ["session.get"]],
    ]
    for (const [method, failure, code, operations] of cases) {
      const results: Partial<Record<keyof LocalServer, unknown>> = {}
      const { local, registry, subscriptions, calls } = await harness({ results })
      results[method] = () => Promise.reject(failure)
      for (const operation of operations) {
        const input =
          operation === "session.prompt"
            ? { text: "hi" }
            : operation === "session.permission.reply"
              ? { requestID: "per_1", reply: "once" }
              : undefined
        const outcome = await executeRemoteOperation({
          request: request(operation as never, input),
          sessions: registry,
          subscriptions,
          local,
        })
        expect(errorOf(outcome).code).toBe(code)
        // One attempt per request: an indeterminate mutation is never replayed.
        expect(calls.filter((call) => call.method === method)).toHaveLength(1)
      }
    }
  })
})

describe("bounded response chunking", () => {
  test("keeps a small response in one frame and reassembles a large one in order", () => {
    const small = successFrames("req_1", { data: [1, 2, 3] })
    expect(small).toHaveLength(1)

    const large = { data: Array.from({ length: 20_000 }, (_, index) => ({ index, text: `line ${index} "quoted"` })) }
    const text = JSON.stringify(large)
    expect(text.length).toBeGreaterThan(RemoteLimits.maxAgentMessageChars)
    const frames = successFrames("req_1", large)
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.length).toBeLessThanOrEqual(RemoteLimits.maxChunksPerResponse)
    const parts: string[] = []
    frames.forEach((frame, index) => {
      expect(JSON.stringify(frame).length).toBeLessThanOrEqual(RemoteLimits.maxAgentMessageChars)
      const chunked = frame as { ok: true; value: string; chunk: { index: number; last: boolean } }
      expect(chunked.chunk.index).toBe(index)
      expect(chunked.chunk.last).toBe(index === frames.length - 1)
      parts.push(chunked.value)
    })
    const reassembled = parseChunkedValue(parts)
    expect(reassembled.ok).toBe(true)
    if (reassembled.ok) expect(reassembled.value).toEqual(large)
  })

  test("fails explicitly instead of truncating a value beyond the chunk bound", () => {
    const huge = { data: "x".repeat(RemoteLimits.maxAgentMessageChars * RemoteLimits.maxChunksPerResponse + 1) }
    const frames = successFrames("req_1", huge)
    expect(frames).toHaveLength(1)
    expect(frames[0].ok).toBe(false)
    if (!frames[0].ok) expect(frames[0].error.code).toBe("message_too_large")
  })
})

describe("local endpoint scope", () => {
  test("accepts loopback only and refuses LAN or public endpoints", () => {
    for (const url of ["http://127.0.0.1:4096", "http://localhost:4096", "http://[::1]:4096", "http://0.0.0.0:4096"]) {
      expect(() => assertPrivateEndpoint({ url })).not.toThrow()
    }
    for (const url of [
      "http://192.168.1.20:4096",
      "http://10.0.0.5:4096",
      "http://172.16.4.4:4096",
      "http://workstation.local:4096",
      "https://ycoding.example:4096",
    ]) {
      expect(() => assertPrivateEndpoint({ url })).toThrow(/loopback/)
    }
  })
})

describe("session list paging", () => {
  test("active order ranks running families before pins and pages both directions when running membership changes", () => {
    const root = { ...sessionInfo("ses_root", { updated: 2 }), time: { created: 2, updated: 2 } }
    const child = sessionInfo("ses_child", { updated: 5, parentID: "ses_root" })
    const pinned = { ...sessionInfo("ses_pinned", { updated: 3 }), time: { created: 3, updated: 3, pinned: 9 } }
    const recent = sessionInfo("ses_recent", { updated: 4 })
    const sessions = [root, child, pinned, recent]
    const running = new Set(["ses_child"])
    const page = listPage(sessions, parseListQuery({ order: "active", parentID: null, limit: 1 }), running)
    expect(page.data.map((session) => session.id)).toEqual(["ses_root"])
    const after = listPage(sessions, parseListQuery({ order: "active", parentID: null, limit: 2, cursor: page.cursor.next }), new Set(["ses_child", "ses_recent"]))
    expect(after.data.map((session) => session.id)).toEqual(["ses_pinned"])
    const previous = listPage(sessions, parseListQuery({ order: "active", parentID: null, limit: 1, cursor: after.cursor.previous }), running)
    expect(previous.data.map((session) => session.id)).toEqual(["ses_root"])
    expect(() => parseListQuery({ order: "active", cursor: Buffer.from(JSON.stringify({ id: "ses_root", time: 2, direction: "next" })).toString("base64url") })).toThrow()
  })

  test("distinguishes recorded workspace identities in the same directory", async () => {
    const first = { ...sessionInfo("ses_one", { updated: 1, directory: process.cwd() }), location: { directory: process.cwd(), workspaceID: "one" } }
    const second = { ...sessionInfo("ses_two", { updated: 2, directory: process.cwd() }), location: { directory: process.cwd(), workspaceID: "two" } }
    const test = await harness({ sessions: [first, second], results: { projectList: [] } })
    const response = valueOf(await executeRemoteOperation({ request: request("workspace.list", { sessionsOnly: true }),
      local: test.local, sessions: test.registry, subscriptions: test.subscriptions })) as { data: { id: string; workspaceID?: string }[] }
    expect(response.data.map((group) => group.workspaceID).toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual(["one", "two"])
    expect(response.data[0]?.id).not.toBe(response.data[1]?.id)
    expect(listPage([first, second], parseListQuery({ workspace: response.data.find((group) => group.workspaceID === "one")?.id, limit: 10 })).data.map((session) => session.id)).toEqual(["ses_one"])
  })

  test("pages a selected recorded workspace with summary search, status, and stable pinned order", async () => {
    const directory = await mkdtemp(join(scratch, "ycoding-inventory-"))
    try {
      const first = { ...sessionInfo("ses_first", { updated: 1, title: "First", directory }), agent: "builder",
        model: { providerID: "test", id: "model", variant: "high" }, time: { created: 1, updated: 1, pinned: 2 } }
      const second = { ...sessionInfo("ses_second", { updated: 2, title: "Second", directory }), time: { created: 2, updated: 2, pinned: 1 } }
      const third = sessionInfo("ses_third", { updated: 3, title: "Third", directory })
      const elsewhere = sessionInfo("ses_elsewhere", { updated: 4, title: "Elsewhere", directory: "/other" })
      const test = await harness({ sessions: [first, second, third, elsewhere], results: { projectList: [] } })
      const groups = valueOf(await executeRemoteOperation({
        request: request("workspace.list", { sessionsOnly: true }), local: test.local, sessions: test.registry, subscriptions: test.subscriptions,
      })) as { data: { id: string; directory: string }[] }
      const workspace = groups.data.find((group) => group.directory === directory)
      expect(workspace).toBeDefined()
      expect(test.calls.filter((call) => call.method === "listPage")).toEqual([])
      const wirePage = valueOf(await executeRemoteOperation({ request: request("session.list", { workspace: workspace?.id, order: "pinned", limit: 1 }),
        local: test.local, sessions: test.registry, subscriptions: test.subscriptions })) as { data: SessionInfo[] }
      expect(wirePage.data.map((session) => session.id)).toEqual(["ses_second"])
      expect(test.calls.filter((call) => call.method === "listPage")).toEqual([])
      const page = listPage([first, second, third, elsewhere], parseListQuery({ workspace: workspace?.id, order: "pinned", limit: 1 }))
      expect(page.data.map((session) => session.id)).toEqual(["ses_second"])
      const following = listPage([first, second, third, elsewhere], parseListQuery({ workspace: workspace?.id, order: "pinned", limit: 2, cursor: page.cursor.next }))
      expect(following.data.map((session) => session.id)).toEqual(["ses_first", "ses_third"])
      const backwards = listPage([first, second, third, elsewhere], parseListQuery({ workspace: workspace?.id, order: "pinned", limit: 1, cursor: following.cursor.previous }))
      expect(backwards.data.map((session) => session.id)).toEqual(["ses_second"])
      const searched = listPage([first, second, third], parseListQuery({ workspace: workspace?.id, search: "builder", searchFields: "summary", limit: 10 }))
      expect(searched.data.map((session) => session.id)).toEqual(["ses_first"])
      expect(listPage([first, second], parseListQuery({ workspace: workspace?.id, search: "#high", searchFields: "summary", limit: 10 })).data.map((session) => session.id)).toEqual(["ses_first"])
      expect(listPage([first, second], parseListQuery({ search: "#high", limit: 10 })).data).toEqual([])
      const noModel = { ...second, model: undefined }
      expect(listPage([noModel], parseListQuery({ search: "/", searchFields: "summary", limit: 10 })).data).toEqual([])
      expect(listPage([first, second, third], parseListQuery({ search: "builder", limit: 10 })).data).toEqual([])
      const running = listPage([first, second, third], parseListQuery({ workspace: workspace?.id, status: "running", limit: 10 }), new Set(["ses_third"]))
      expect(running.data.map((session) => session.id)).toEqual(["ses_third"])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("orders, searches, limits, and pages the advertised set without leaking unlisted sessions", () => {
    const sessions = [
      sessionInfo("ses_a", { updated: 1, title: "Alpha" }),
      sessionInfo("ses_b", { updated: 2, title: "Beta" }),
      sessionInfo("ses_c", { updated: 3, title: "Gamma" }),
    ]
    const first = listPage(sessions, parseListQuery({ limit: 2 })) as { data: SessionInfo[]; cursor: { next?: string } }
    expect(first.data.map((session) => session.id)).toEqual(["ses_c", "ses_b"])
    expect(first.cursor.next).toBeDefined()

    const second = listPage(sessions, parseListQuery({ limit: 2, cursor: first.cursor.next })) as {
      data: SessionInfo[]
      cursor: { next?: string }
    }
    expect(second.data.map((session) => session.id)).toEqual(["ses_a"])
    expect(second.cursor.next).toBeUndefined()

    const ascending = listPage(sessions, parseListQuery({ order: "asc", limit: 10 })) as { data: SessionInfo[] }
    expect(ascending.data.map((session) => session.id)).toEqual(["ses_a", "ses_b", "ses_c"])

    const searched = listPage(sessions, parseListQuery({ search: "amm", limit: 10 })) as { data: SessionInfo[] }
    expect(searched.data.map((session) => session.id)).toEqual(["ses_c"])

    const roots = listPage(
      [...sessions, sessionInfo("ses_child", { updated: 4, parentID: "ses_a" })],
      parseListQuery({ parentID: null, limit: 10 }),
    ) as { data: SessionInfo[] }
    expect(roots.data.map((session) => session.id)).toEqual(["ses_c", "ses_b", "ses_a"])
  })
})
