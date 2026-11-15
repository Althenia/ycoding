import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { BackendController } from "../src/backend-controller"
import { createDesktopRPC } from "../src/rpc"
import { runDesktopWorker } from "../src/worker"
import { env, launch, message, syntheticBundle } from "./synthetic-backend"
import { syntheticDesktop, type SyntheticCall } from "./synthetic-desktop"

const id = "ses_actions"
const info = (sessionID: string, extra: Record<string, unknown> = {}) => ({ id: sessionID, title: "Actions", location: { directory: "/synthetic/repo" }, time: { created: 1, updated: 2 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, ...extra })
const admitted = (call: SyntheticCall, delivery = call.body.delivery ?? "steer") => ({ data: { admittedSeq: 1, id: call.body.id, sessionID: id, timeCreated: 1, type: "user", delivery, data: { text: call.body.text } } })
const writes = (calls: readonly SyntheticCall[]) => calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.route}`)
const compaction = (jobID: string, sessionID = id) => ({ data: { id: jobID, sessionID, trigger: "manual", status: "ended", requestedThrough: { messageID: "msg_1", seq: 3 }, timeCreated: 1 } })
const preferences = { path: "/synthetic/preferences", read: async () => ({}), save: async () => {}, validate: () => ({ mode: "own" as const }) }

test("prompts forward an explicit queue or steer delivery and keep the canonical default when absent", async () => {
  let override: string | undefined
  const owned = await syntheticDesktop((call) => call.route === `/api/session/${id}/prompt` ? admitted(call, override) : undefined)
  try {
    const rpc = createDesktopRPC(owned.controller, preferences)
    expect(await rpc.prompt({ sessionID: id, promptID: "msg_queue", text: "Later", delivery: "queue" })).toMatchObject({ id: "msg_queue", delivery: "queue" })
    expect(await owned.controller.prompt({ sessionID: id, promptID: "msg_steer", text: "Now", delivery: "steer" })).toMatchObject({ id: "msg_steer", delivery: "steer" })
    await owned.controller.prompt({ sessionID: id, promptID: "msg_default", text: "Plain" })
    expect(owned.calls.map((call) => call.body)).toEqual([{ id: "msg_queue", text: "Later", delivery: "queue" }, { id: "msg_steer", text: "Now", delivery: "steer" }, { id: "msg_default", text: "Plain" }])
    const before = owned.calls.length
    for (const delivery of ["now", "", "QUEUE", null]) await expect(owned.controller.prompt({ sessionID: id, promptID: "msg_bad", text: "x", delivery })).rejects.toThrow("Invalid message.")
    expect(owned.calls).toHaveLength(before)
    override = "steer"
    expect(await message(owned.controller.prompt({ sessionID: id, promptID: "msg_queue", text: "Later", delivery: "queue" }))).toContain("different delivery")
    expect(owned.calls).toHaveLength(before + 1)
  } finally { await owned.close() }
})

const steerCalls = (calls: readonly SyntheticCall[]) => calls.filter((call) => call.method !== "GET").map((call) => call.route.endsWith("/interrupt") ? "interrupt" : `${call.body.id} resume:${call.body.resume}`)

test("prompts restore canonical managed attachment references with their mention and refuse malformed references before any write", async () => {
  const owned = await syntheticDesktop((call) => call.route === `/api/session/${id}/prompt` ? admitted(call) : undefined)
  try {
    const digest = "0123456789abcdef".repeat(4)
    const text = "see @notes.md"
    const managed = { uri: `ycoding-attachment://sha256/${digest}`, name: "notes.md", description: "Notes", mention: { start: 4, end: 13, text: "@notes.md" } }
    await owned.controller.prompt({ sessionID: id, promptID: "msg_managed", text, files: [managed, { uri: "file:///synthetic/repo/a.ts" }] })
    expect(owned.calls.map((call) => call.body)).toEqual([{ id: "msg_managed", text, files: [managed, { uri: "file:///synthetic/repo/a.ts" }] }])
    for (const uri of [
      `ycoding-attachment://sha256/${digest.toUpperCase()}`, `YCODING-ATTACHMENT://sha256/${digest}`, `ycoding-attachment://SHA256/${digest}`,
      `ycoding-attachment://sha512/${digest}`, `ycoding-attachment://sha256/${digest.slice(1)}`, `ycoding-attachment://sha256/${digest}0`, `ycoding-attachment://sha256/${digest.slice(1)}g`,
      `ycoding-attachment://sha256/${digest}?x=1`, `ycoding-attachment://sha256/${digest}#x`, `ycoding-attachment://sha256/${digest}/`, `ycoding-attachment://sha256/../${digest}`,
      `ycoding-attachment://sha256/%2e%2e/${digest}`, `ycoding-attachment://user@sha256/${digest}`, `ycoding-attachment:sha256/${digest}`, `ycoding-attachment:///sha256/${digest}`,
      `https://sha256/${digest}`, "file://example.com/a.ts", "file://user@localhost/a.ts",
    ]) await expect(owned.controller.prompt({ sessionID: id, promptID: "msg_bad", text: "x", files: [{ uri }] })).rejects.toThrow("Invalid message.")
    expect(owned.calls).toHaveLength(1)
  } finally { await owned.close() }
})

test("send and steer now admits without waking, interrupts, then wakes the same message and reuses the completed receipt", async () => {
  const owned = await syntheticDesktop((call) => call.route === `/api/session/${id}/prompt` ? admitted(call) : undefined)
  try {
    const revision = owned.revision
    const rpc = createDesktopRPC(owned.controller, preferences)
    const receipt = await rpc.prompt({ sessionID: id, promptID: "msg_now", text: "Stop and do this", steerNow: true, revision })
    expect(receipt).toMatchObject({ id: "msg_now", sessionID: id, delivery: "steer" })
    expect(owned.calls.map((call) => [call.method, call.route, call.body])).toEqual([
      ["POST", `/api/session/${id}/prompt`, { id: "msg_now", text: "Stop and do this", resume: false }],
      ["POST", `/api/session/${id}/interrupt`, {}],
      ["POST", `/api/session/${id}/prompt`, { id: "msg_now", text: "Stop and do this", resume: true }],
    ])
    expect(await owned.controller.prompt({ sessionID: id, promptID: "msg_now", text: "Stop and do this", steerNow: true, revision })).toEqual(receipt)
    await owned.controller.prompt({ sessionID: id, promptID: "msg_explicit", text: "Steer", delivery: "steer", steerNow: true, revision })
    expect(owned.calls.at(-1)?.body).toEqual({ id: "msg_explicit", text: "Steer", delivery: "steer", resume: true })
    const before = owned.calls.length
    expect(await message(owned.controller.prompt({ sessionID: id, promptID: "msg_now", text: "Changed", steerNow: true, revision }))).toContain("different content")
    expect(await message(owned.controller.prompt({ sessionID: id, promptID: "msg_now", text: "Stop and do this", delivery: "steer", steerNow: true, revision }))).toContain("different content")
    expect(await message(owned.controller.prompt({ sessionID: id, promptID: "msg_queued", text: "Later", delivery: "queue", steerNow: true, revision }))).toContain("queued message cannot steer now")
    for (const steerNow of [false, "true", 1, null]) await expect(owned.controller.prompt({ sessionID: id, promptID: "msg_bad", text: "x", steerNow, revision })).rejects.toThrow("Invalid message.")
    for (const extra of [{ steerNow: true }, { steerNow: true, revision: -1 }, { steerNow: true, revision: "1" }, { revision }])
      await expect(owned.controller.prompt({ sessionID: id, promptID: "msg_bad", text: "x", ...extra })).rejects.toThrow("Invalid message.")
    expect(await message(owned.controller.prompt({ sessionID: id, promptID: "msg_stale", text: "x", steerNow: true, revision: revision + 1 }))).toContain("before this steer was sent")
    expect(owned.calls).toHaveLength(before)
  } finally { await owned.close() }
})

test("a failed interrupt blocks its steer for review while a failed wake after a confirmed interrupt wakes once more", async () => {
  const failures = new Set(["interrupt", "msg_wake resume:true"])
  const owned = await syntheticDesktop((call) => {
    const key = call.route.endsWith("/interrupt") ? "interrupt" : `${call.body.id} resume:${call.body.resume}`
    if (failures.delete(key)) return new Response(JSON.stringify({ message: "synthetic failure" }), { status: 500, headers: { "content-type": "application/json" } })
    return call.route === `/api/session/${id}/prompt` ? admitted(call) : undefined
  })
  try {
    const steer = (promptID: string) => owned.controller.prompt({ sessionID: id, promptID, text: "Now", steerNow: true, revision: owned.revision })
    expect(await message(steer("msg_cut"))).toContain("will not interrupt or wake again")
    expect(steerCalls(owned.calls)).toEqual(["msg_cut resume:false", "interrupt"])
    expect(await message(steer("msg_cut"))).toContain("will not interrupt or wake again")
    expect(owned.calls).toHaveLength(2)
    expect(await message(steer("msg_wake"))).toContain("wakes it once more without interrupting")
    expect(await steer("msg_wake")).toMatchObject({ id: "msg_wake" })
    await steer("msg_wake")
    expect(steerCalls(owned.calls).slice(2)).toEqual(["msg_wake resume:false", "interrupt", "msg_wake resume:true", "msg_wake resume:true"])
  } finally { await owned.close() }
})

test("concurrent duplicate steers join one attempt and a changed payload for the same ID is refused", async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let arrived!: () => void
  const reached = new Promise<void>((resolve) => { arrived = resolve })
  const owned = await syntheticDesktop(async (call) => {
    if (call.route.endsWith("/interrupt")) { arrived(); await held; return undefined }
    return call.route === `/api/session/${id}/prompt` ? admitted(call) : undefined
  })
  try {
    const input = { sessionID: id, promptID: "msg_twice", text: "Once", steerNow: true as const, revision: owned.revision }
    const first = owned.controller.prompt(input)
    await reached
    const second = owned.controller.prompt(input)
    expect(await message(owned.controller.prompt({ ...input, text: "Twice" }))).toContain("different content")
    release()
    const [a, b] = await Promise.all([first, second])
    expect(b).toEqual(a)
    expect(steerCalls(owned.calls)).toEqual(["msg_twice resume:false", "interrupt", "msg_twice resume:true"])
  } finally { await owned.close() }
})

test("a connection change during a steer stops its remaining writes and the old revision never replays on the new connection", async () => {
  let reconnect: Promise<unknown> | undefined
  const owned = await syntheticDesktop((call) => {
    if (call.route.endsWith("/interrupt") && !reconnect) { reconnect = owned.controller.connect({ mode: "shared", server: "http://synthetic.invalid" }); return undefined }
    return call.route === `/api/session/${id}/prompt` ? admitted(call) : undefined
  })
  try {
    const input = { sessionID: id, promptID: "msg_moved", text: "Now", steerNow: true as const, revision: owned.revision }
    expect(await message(owned.controller.prompt(input))).toMatch(/connection changed|not confirmed/)
    await reconnect
    expect(steerCalls(owned.calls)).toEqual(["msg_moved resume:false", "interrupt"])
    expect(await message(owned.controller.prompt(input))).toContain("before this steer was sent")
    expect(owned.calls).toHaveLength(2)
  } finally { await owned.close() }
})

test("shell output and kill accept any shell in the Session family by shared root and refuse foreign or cyclic owners before reading or removing", async () => {
  const shellRow = (shellID: string, owner: string) => ({ id: shellID, status: "running", command: "echo", cwd: "/synthetic/repo", shell: "sh", file: "output", time: { started: 1 }, metadata: { sessionID: owner } })
  const parents: Record<string, string | undefined> = { [id]: undefined, ses_child: id, ses_grand: "ses_child", ses_other: undefined, ses_loop: "ses_loop2", ses_loop2: "ses_loop" }
  const owners: Record<string, string> = { sh_root: id, sh_grand: "ses_grand", sh_other: "ses_other", sh_loop: "ses_loop" }
  const owned = await syntheticDesktop((call) => {
    const sessionID = call.route.match(/^\/api\/session\/(ses_[A-Za-z0-9_]+)$/)?.[1]
    if (call.method === "GET" && sessionID && sessionID in parents) return { data: info(sessionID, parents[sessionID] ? { parentID: parents[sessionID] } : {}) }
    if (call.method === "GET" && call.route === "/api/shell") return { location: { directory: "/synthetic/repo" }, data: Object.entries(owners).map(([shellID, owner]) => shellRow(shellID, owner)) }
    if (call.route.endsWith("/output")) return { location: { directory: "/synthetic/repo" }, data: { output: "ok", cursor: 2, size: 2, truncated: false } }
    return undefined
  })
  const reads = () => owned.calls.filter((call) => call.route.endsWith("/output")).length
  const removals = () => writes(owned.calls).filter((call) => call.startsWith("DELETE /api/shell")).length
  try {
    expect(await owned.controller.shellOutput({ sessionID: id, shellID: "sh_grand" })).toMatchObject({ sessionID: id, shellID: "sh_grand", output: "ok" })
    expect(await owned.controller.shellOutput({ sessionID: "ses_grand", shellID: "sh_root" })).toMatchObject({ sessionID: "ses_grand", shellID: "sh_root", output: "ok" })
    expect(reads()).toBe(2)
    for (const [sessionID, shellID] of [[id, "sh_other"], ["ses_child", "sh_loop"], ["ses_loop", "sh_root"]])
      await expect(owned.controller.shellOutput({ sessionID, shellID })).rejects.toThrow("not attributed")
    expect(reads()).toBe(2)
    await owned.controller.manageSession({ kind: "kill-shell", revision: owned.revision, sessionID: id, shellID: "sh_grand" })
    await owned.controller.manageSession({ kind: "kill-shell", revision: owned.revision, sessionID: "ses_child", shellID: "sh_root" })
    expect(removals()).toBe(2)
    for (const [sessionID, shellID] of [[id, "sh_other"], ["ses_child", "sh_loop"]])
      await expect(owned.controller.manageSession({ kind: "kill-shell", revision: owned.revision, sessionID, shellID })).rejects.toThrow("not attributed")
    expect(removals()).toBe(2)
  } finally { await owned.close() }
})

test("compaction sends a canonical compaction job ID under the current revision and checks the settled result", async () => {
  let result: unknown = compaction("cmp_job")
  const owned = await syntheticDesktop((call) => call.route === `/api/session/${id}/compact` ? result : undefined)
  try {
    expect(await owned.controller.compact({ sessionID: id, revision: owned.revision, compactionID: "cmp_job" })).toMatchObject({ id: "cmp_job", sessionID: id, status: "ended" })
    expect(owned.calls.map((call) => [call.method, call.route, call.body])).toEqual([["POST", `/api/session/${id}/compact`, { id: "cmp_job" }]])
    for (const input of [{ sessionID: id, revision: owned.revision, compactionID: "msg_job" }, { sessionID: id, revision: owned.revision }, { sessionID: id, compactionID: "cmp_job" }, { sessionID: id, revision: owned.revision, compactionID: "cmp_job", promptID: "msg_x" }])
      await expect(owned.controller.compact(input)).rejects.toThrow("Invalid compaction request.")
    expect(await message(owned.controller.compact({ sessionID: id, revision: owned.revision + 1, compactionID: "cmp_next" }))).toContain("connection changed")
    expect(owned.calls).toHaveLength(1)
    result = compaction("cmp_other", "ses_foreign")
    expect(await message(owned.controller.compact({ sessionID: id, revision: owned.revision, compactionID: "cmp_two" }))).toContain("different compaction")
    expect(owned.calls).toHaveLength(2)
  } finally { await owned.close() }
})

test("forks from a message create a child of the source Session and refuse foreign results", async () => {
  let parentID: string | undefined = id
  const owned = await syntheticDesktop((call) => call.route === `/api/session/${id}/fork` ? { data: info("ses_fork", parentID ? { parentID } : {}) } : undefined)
  try {
    const forked = await owned.controller.manageSession({ kind: "fork", revision: owned.revision, sessionID: id, messageID: "msg_from" })
    expect(forked).toMatchObject({ revision: owned.revision, sessionID: id, item: { id: "ses_fork", parentID: id } })
    expect(owned.calls.map((call) => call.body)).toEqual([{ messageID: "msg_from" }])
    await owned.controller.manageSession({ kind: "fork", revision: owned.revision, sessionID: id })
    expect(owned.calls.at(-1)?.body).toEqual({})
    parentID = "ses_elsewhere"
    expect(await message(owned.controller.manageSession({ kind: "fork", revision: owned.revision, sessionID: id }))).toContain("different fork")
    parentID = undefined
    expect(await message(owned.controller.manageSession({ kind: "fork", revision: owned.revision, sessionID: id }))).toContain("different fork")
    const before = owned.calls.length
    expect(await message(owned.controller.manageSession({ kind: "fork", revision: owned.revision + 1, sessionID: id }))).toBe("The backend connection changed before the Session change was sent. Refresh the Session and try again.")
    await expect(owned.controller.manageSession({ kind: "fork", revision: owned.revision, sessionID: id, messageID: "prt_1" })).rejects.toThrow()
    expect(owned.calls).toHaveLength(before)
  } finally { await owned.close() }
})

test("reverts stage any user message the Desktop never sent, clear and commit, and archive lifecycle changes use their own routes once under the current revision", async () => {
  let staged: unknown = { data: { messageID: "msg_back", files: [{ file: "a.ts", patch: "@@", additions: 1, deletions: 2, status: "modified", secret: "hidden" }] } }
  const owned = await syntheticDesktop((call) => call.route.endsWith("/revert/stage") ? staged : undefined)
  try {
    const revision = owned.revision
    expect(await owned.controller.revert({ action: "stage", sessionID: id, revision, messageID: "msg_back" })).toEqual({ messageID: "msg_back", files: [{ file: "a.ts", patch: "@@", additions: 1, deletions: 2, status: "modified" }] })
    expect(await owned.controller.revert({ action: "clear", sessionID: id, revision })).toBeNull()
    expect(await owned.controller.revert({ action: "commit", sessionID: id, revision })).toBeNull()
    for (const kind of ["archive", "unarchive", "delete"]) await owned.controller.manageSession({ kind, revision, sessionID: id })
    expect(writes(owned.calls)).toEqual([`POST /api/session/${id}/revert/stage`, `POST /api/session/${id}/revert/clear`, `POST /api/session/${id}/revert/commit`, `POST /api/session/${id}/archive`, `DELETE /api/session/${id}/archive`, `DELETE /api/session/${id}`])
    expect(owned.calls[0]?.body).toEqual({ messageID: "msg_back" })
    staged = { data: { messageID: "msg_other" } }
    await expect(owned.controller.revert({ action: "stage", sessionID: id, revision, messageID: "msg_back" })).rejects.toThrow("not confirmed")
    const before = owned.calls.length
    for (const action of ["stage", "clear", "commit"] as const) expect(await message(owned.controller.revert(action === "stage" ? { action, sessionID: id, revision: revision + 1, messageID: "msg_back" } : { action, sessionID: id, revision: revision + 1 }))).toContain("connection changed")
    for (const kind of ["archive", "unarchive", "delete"]) expect(await message(owned.controller.manageSession({ kind, revision: revision + 1, sessionID: id }))).toContain("before the Session change was sent")
    await expect(owned.controller.manageSession({ kind: "delete", revision, sessionID: "not-a-session" })).rejects.toThrow()
    expect(owned.calls).toHaveLength(before)
  } finally { await owned.close() }
})

test("the stdio worker forwards prompt delivery and compaction identity unchanged", async () => {
  const resources = await syntheticBundle()
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-session-actions-"))
  const bodies: unknown[] = []
  const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/api/health") return Response.json({ healthy: true, version: "synthetic", pid: 101, sourceEpoch: "synthetic" })
    if (url.pathname === "/api/event") return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'))
      request.signal.addEventListener("abort", () => stream.close(), { once: true })
    } }), { headers: { "content-type": "text/event-stream" } })
    const body = (request.body ? await request.json() : {}) as Record<string, unknown>
    bodies.push([url.pathname, body])
    if (url.pathname.endsWith("/prompt")) return Response.json({ data: { admittedSeq: 1, id: body.id, sessionID: id, timeCreated: 1, type: "user", delivery: body.delivery, data: { text: body.text } } })
    if (url.pathname.endsWith("/compact")) return Response.json(compaction(String(body.id)))
    return new Response(null, { status: 204 })
  }, { preconnect: () => {} })
  const input = new PassThrough()
  const output = new PassThrough()
  const replies = new Map<number, (value: { id: number; data?: unknown; error?: string }) => void>()
  let buffer = ""
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const record = JSON.parse(buffer.slice(0, newline)) as { type: string; id: number }
      buffer = buffer.slice(newline + 1)
      if (record.type === "reply") replies.get(record.id)?.(record)
    }
  })
  const done = runDesktopWorker({ resources, preferences: path.join(folder, "preferences.json"), input, output, controller: { env, launch, fetch } })
  let next = 0
  const request = (operation: string, value: unknown) => {
    const requestID = ++next
    const reply = new Promise<{ id: number; data?: unknown; error?: string }>((resolve) => replies.set(requestID, resolve))
    input.write(JSON.stringify({ id: requestID, operation, input: value }) + "\n")
    return reply
  }
  try {
    const connected = await request("connect", { mode: "shared", server: "http://synthetic.invalid" })
    const revision = (connected.data as { revision: number }).revision
    expect(await request("prompt", { sessionID: id, promptID: "msg_worker", text: "Queue it", delivery: "queue" })).toMatchObject({ id: 2, data: { id: "msg_worker", delivery: "queue" } })
    expect(await request("compact", { sessionID: id, revision, compactionID: "cmp_worker" })).toMatchObject({ id: 3, data: { id: "cmp_worker", sessionID: id } })
    expect(bodies).toEqual([[`/api/session/${id}/prompt`, { id: "msg_worker", text: "Queue it", delivery: "queue" }], [`/api/session/${id}/compact`, { id: "cmp_worker" }]])
  } finally {
    input.end()
    await done.catch(() => undefined)
    await fs.rm(resources, { recursive: true, force: true })
    await fs.rm(folder, { recursive: true, force: true })
  }
}, 30_000)

async function headerDesktop(handle: (call: SyntheticCall & { headers: Headers }) => unknown) {
  const resources = await syntheticBundle()
  const calls: (SyntheticCall & { headers: Headers })[] = []
  const controller = new BackendController(resources, { env, launch, cwd: resources, fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/api/health") return Response.json({ healthy: true, version: "synthetic", pid: 101, sourceEpoch: "synthetic" })
    if (url.pathname === "/api/event") return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'))
      request.signal.addEventListener("abort", () => stream.close(), { once: true })
    } }), { headers: { "content-type": "text/event-stream" } })
    const body: unknown = request.body ? await request.json() : {}
    const call = { method: request.method, route: url.pathname, query: url.searchParams, body: { ...(body as Record<string, unknown>) }, headers: request.headers }
    calls.push(call)
    const value = await handle(call)
    if (value instanceof Response) return value
    if (value !== undefined) return Response.json(value)
    return new Response(null, { status: 204 })
  }, { preconnect: () => {} }) })
  const connected = await controller.connect({ mode: "shared", server: "http://synthetic.invalid" })
  return { controller, calls, revision: connected.revision!, async close() { await controller.disconnect(); await fs.rm(resources, { recursive: true, force: true }) } }
}

const form = (formID: string, sessionID: string) => ({ id: formID, sessionID, title: "Server needs input", fields: [{ key: "token", type: "string", title: "Token" }], time: { created: 1 } })

test("global MCP elicitation forms are listed only from their location and answered with scoped location headers after a re-read", async () => {
  const workspace = "/synthetic/repo"
  let foreign = false
  const owned = await headerDesktop((call) => {
    const workspaceID = call.query.get("location[workspace]")
    if (call.method === "GET" && call.route === "/api/form/request") return { location: foreign ? { directory: "/synthetic/other", project: { id: "prj_b", directory: "/synthetic/other" } } : { directory: workspace, ...(workspaceID ? { workspaceID } : {}), project: { id: "prj_a", directory: workspace } }, data: [form("frm_global", "global"), form("frm_session", id)] }
    return undefined
  })
  try {
    const pending = await owned.controller.requests({ scope: "global", directory: workspace })
    expect(pending).toMatchObject({ sessionID: "global", revision: owned.revision, permissions: [], location: { directory: workspace } })
    expect(pending.forms.map((item) => item.id)).toEqual(["frm_global"])
    expect(owned.calls[0]?.query.get("location[directory]")).toBe(workspace)
    const before = owned.calls.length
    for (const scope of [{ scope: "global" }, { scope: "global", directory: "relative" }, { scope: "local", directory: workspace }, { scope: "global", directory: workspace, extra: 1 }])
      await expect(owned.controller.requests(scope)).rejects.toThrow()
    expect(owned.calls).toHaveLength(before)
    await owned.controller.reply({ kind: "form", sessionID: "global", revision: owned.revision, formID: "frm_global", answer: { token: "x" }, location: { directory: workspace, workspace: "wrk_a" } })
    await owned.controller.reply({ kind: "form-cancel", sessionID: "global", revision: owned.revision, formID: "frm_global", location: { directory: workspace } })
    expect(owned.calls.slice(before).map((call) => [call.method, call.route, call.query.get("location[directory]"), call.query.get("location[workspace]"), call.headers.get("x-ycoding-directory"), call.headers.get("x-ycoding-workspace")])).toEqual([
      ["GET", "/api/form/request", workspace, "wrk_a", null, null],
      ["POST", "/api/session/global/form/frm_global/reply", null, null, encodeURIComponent(workspace), "wrk_a"],
      ["GET", "/api/form/request", workspace, null, null, null],
      ["POST", "/api/session/global/form/frm_global/cancel", null, null, encodeURIComponent(workspace), null],
    ])
    expect(owned.calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([{ answer: { token: "x" } }, {}])
    const settled = owned.calls.length
    for (const reply of [
      { kind: "form", sessionID: "global", revision: owned.revision, formID: "frm_global", answer: { token: "x" } },
      { kind: "form", sessionID: id, revision: owned.revision, formID: "frm_session", answer: { token: "x" }, location: { directory: workspace } },
      { kind: "form", sessionID: "global", revision: owned.revision, formID: "frm_global", answer: { token: "x" }, location: { directory: "relative" } },
      { kind: "form", sessionID: "global", revision: owned.revision, formID: "frm_global", answer: { token: "x" }, location: { directory: workspace, extra: 1 } },
      { kind: "permission", sessionID: "global", revision: owned.revision, requestID: "per_x", reply: "once", location: { directory: workspace } },
      { kind: "guardrail", sessionID: "global", revision: owned.revision, requestID: "grq_x", reply: "once" },
      { kind: "review", sessionID: "global", revision: owned.revision, itemID: "rvw_x", decision: { kind: "recovery", choice: "stop" } },
      { kind: "form", sessionID: "global", revision: owned.revision + 1, formID: "frm_global", answer: { token: "x" }, location: { directory: workspace } },
    ]) await expect(owned.controller.reply(reply)).rejects.toThrow()
    expect(owned.calls).toHaveLength(settled)
    for (const formID of ["frm_session", "frm_missing"])
      await expect(owned.controller.reply({ kind: "form", sessionID: "global", revision: owned.revision, formID, answer: { token: "x" }, location: { directory: workspace } })).rejects.toThrow("no longer pending")
    foreign = true
    await expect(owned.controller.reply({ kind: "form-cancel", sessionID: "global", revision: owned.revision, formID: "frm_global", location: { directory: workspace } })).rejects.toThrow()
    expect(owned.calls.filter((call) => call.method === "POST")).toHaveLength(2)
  } finally { await owned.close() }
})

test("pending requests carry the guardrail family root and whitelisted decided history and omit it when unreadable", async () => {
  let status: unknown = { data: { rootSessionID: id, profile: "standard", customRules: 0, approvals: 1, blocked: 0, counters: [], invalidFiles: [], decisions: [{ sessionID: "ses_child", created: 5, requestID: "grq_done", reply: "once", confidence: 0.9, ruleIDs: ["r1"], token: "hidden" }] } }
  const owned = await syntheticDesktop((call) => {
    if (call.route.endsWith("/permission") || call.route.endsWith("/form") || call.route.endsWith("/question") || call.route.endsWith("/guardrail/request") || call.route.endsWith("/review")) return { data: [] }
    if (call.route === `/api/session/${id}/guardrail`) return status
    return undefined
  })
  try {
    const pending = await owned.controller.requests(id)
    expect(pending.rootSessionID).toBe(id)
    expect(pending.guardrailDecisions).toEqual([{ sessionID: "ses_child", created: 5, requestID: "grq_done", reply: "once", confidence: 0.9, ruleIDs: ["r1"] }])
    status = new Response(null, { status: 500 })
    const degraded = await owned.controller.requests(id)
    expect(degraded.rootSessionID).toBeUndefined()
    expect(degraded.guardrailDecisions).toBeUndefined()
  } finally { await owned.close() }
})

test("the Sessions directory first page carries authoritative running and waiting roots and later pages do not re-read them", async () => {
  let decisions: unknown = { data: [{ kind: "permission", sessionID: "ses_child", sessionTitle: "Child", directory: "/synthetic/repo", id: "per_1", summary: "Edit", decide: [] }] }
  const owned = await syntheticDesktop((call) => {
    if (call.method === "GET" && call.route === "/api/session") return { data: [info(id), info("ses_other")], cursor: call.query.get("cursor") ? {} : { next: "page2" } }
    if (call.route === "/api/decision") return decisions
    if (call.route === "/api/session/outstanding") return { data: [], running: ["ses_other"], failed: [], lost: [] }
    if (call.route === "/api/session/ses_child") return { data: info("ses_child", { parentID: id }) }
    if (call.route === `/api/session/${id}`) return { data: info(id) }
    return undefined
  })
  try {
    const first = await owned.controller.sessions({})
    expect(first.running).toEqual(["ses_other"])
    expect(first.waiting).toEqual([id])
    const reads = owned.calls.length
    const next = await owned.controller.sessions({ cursor: "page2", revision: first.revision })
    expect(next.running).toBeUndefined()
    expect(next.waiting).toBeUndefined()
    expect(owned.calls.slice(reads).map((call) => call.route)).toEqual(["/api/session"])
    decisions = new Response(null, { status: 500 })
    const partial = await owned.controller.sessions({})
    expect(partial.running).toEqual(["ses_other"])
    expect(partial.waiting).toBeUndefined()
  } finally { await owned.close() }
})

test("system status adds structured config diagnostics, credential-free providers and references", async () => {
  const location = { directory: "/synthetic/repo", project: { id: "prj_a", directory: "/synthetic/repo" } }
  const owned = await syntheticDesktop((call) => {
    if (call.route === "/api/config/diagnostics") return { location, data: [{ path: "/synthetic/repo/ycoding.json", reason: "invalid-values", jsonPath: "$.model", message: "Unknown model", failClosed: true }] }
    if (call.route === "/api/provider") return { location, data: [{ id: "openai", name: "OpenAI", package: "@ai-sdk/openai", integrationID: "int_1", headers: { authorization: "Bearer secret" }, settings: { apiKey: "secret" }, body: { token: "secret" } }] }
    if (call.route === "/api/reference") return { location, data: [{ name: "docs", path: "/synthetic/docs", source: { type: "git", repository: "https://user:pass@example.test/docs.git", branch: "main" } }, { name: "local", path: "/synthetic/local", hidden: true, source: { type: "local", path: "/synthetic/local" } }] }
    return undefined
  })
  try {
    const system = await owned.controller.systemSnapshot({ directory: "/synthetic/repo" })
    expect(system.configDiagnostics).toEqual([{ path: "/synthetic/repo/ycoding.json", reason: "invalid-values", jsonPath: "$.model", message: "Unknown model", failClosed: true }])
    expect(system.providers).toEqual([{ id: "openai", name: "OpenAI", package: "@ai-sdk/openai", integrationID: "int_1" }])
    expect(system.references).toEqual([{ name: "docs", path: "/synthetic/docs", source: { type: "git", repository: "https://example.test/docs.git", branch: "main" } }, { name: "local", path: "/synthetic/local", hidden: true, source: { type: "local", path: "/synthetic/local" } }])
    expect(JSON.stringify(system)).not.toContain("secret")
    expect(JSON.stringify(system)).not.toContain("pass@")
    expect(owned.calls.find((call) => call.route === "/api/provider")?.query.get("location[directory]")).toBe("/synthetic/repo")
  } finally { await owned.close() }
})

test("the usage dashboard and model incidents forward validated queries and return display data, and guidance clear is fenced", async () => {
  const owned = await syntheticDesktop((call) => {
    if (call.route === "/api/usage/dashboard") return { data: { status: "preparing" } }
    if (call.route === "/api/incident/report") return { data: { group: "model", rows: [{ key: "openai/gpt", count: 2, apiKey: "secret" }], rowCount: 1 } }
    if (call.route === "/api/incident/recent") return { data: { provider: "openai", model: "gpt", items: [] } }
    if (call.route === "/api/incident/guidance") return { data: { provider: "openai", model: "gpt", guidance: call.method === "DELETE" ? null : "Use a smaller context" } }
    if (call.route === `/api/session/${id}`) return { data: info(id) }
    return undefined
  })
  try {
    const query = { group: "day", from: 1, to: 2, offset: 0, limit: 10, sort: "tokens", order: "desc", timeZone: "UTC" }
    expect(await owned.controller.usageDashboard({ refresh: true, daily: query })).toEqual({ revision: owned.revision, dashboard: { status: "preparing" } })
    expect(owned.calls[0]?.body).toEqual({ refresh: true, daily: query })
    await owned.controller.usageDashboard()
    expect(owned.calls[1]?.body).toEqual({})
    const report = await owned.controller.incidents({ kind: "report", group: "model", limit: 20 })
    expect(report).toEqual({ revision: owned.revision, kind: "report", data: { group: "model", rows: [{ key: "openai/gpt", count: 2 }], rowCount: 1 } })
    expect(owned.calls[2]?.query.get("group")).toBe("model")
    expect((await owned.controller.incidents({ kind: "recent", provider: "openai", model: "gpt", limit: 5 })).kind).toBe("recent")
    expect((await owned.controller.incidents({ kind: "guidance", provider: "openai", model: "gpt", source: id })).data).toMatchObject({ guidance: "Use a smaller context" })
    expect(owned.calls.find((call) => call.route === "/api/incident/guidance")?.query.get("location[directory]")).toBe("/synthetic/repo")
    const cleared = await owned.controller.manageIncident({ revision: owned.revision, kind: "guidance-clear", provider: "openai", model: "gpt", source: id })
    expect(cleared).toMatchObject({ kind: "guidance", data: { guidance: null } })
    const before = owned.calls.length
    for (const input of [{ daily: { ...query, group: "week" } }, { daily: { ...query, limit: 201 } }, { daily: { ...query, from: 3, to: 2 } }, { weekly: query }, { refresh: "yes" }])
      await expect(owned.controller.usageDashboard(input)).rejects.toThrow()
    for (const input of [{ kind: "report", group: "provider" }, { kind: "report", group: "model", limit: 201 }, { kind: "recent", provider: "openai", model: "gpt", limit: 51 }, { kind: "recent", provider: "", model: "gpt" }, { kind: "other" }])
      await expect(owned.controller.incidents(input)).rejects.toThrow()
    expect(await message(owned.controller.manageIncident({ revision: owned.revision + 1, kind: "guidance-clear", provider: "openai", model: "gpt" }))).toContain("connection changed")
    expect(owned.calls).toHaveLength(before)
  } finally { await owned.close() }
})

test("debug JSON export carries the durable Session log without sync markers and is refused for Markdown", async () => {
  const log = [
    { id: "evt_1", created: 1, sourceEpoch: "e", type: "session.created", properties: {} },
    { id: "evt_2", created: 2, sourceEpoch: "e", type: "log.synced", properties: {} },
    { id: "evt_3", created: 3, sourceEpoch: "e", type: "session.updated", properties: {} },
  ]
  const owned = await syntheticDesktop((call) => {
    if (call.route === `/api/session/${id}`) return { data: info(id) }
    if (call.route === `/api/session/${id}/message`) return { data: [] }
    if (call.route === `/api/experimental/session/${id}/log`) return new Response(log.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
    return undefined
  })
  try {
    const exported = await owned.controller.exportSession({ sessionID: id, format: "json", debug: true })
    expect(JSON.parse(exported.content)).toEqual({ info: info(id), events: [log[0], log[2]] })
    expect(exported).toMatchObject({ format: "json", mimeType: "application/json" })
    expect(owned.calls.find((call) => call.route.endsWith("/log"))?.query.get("follow")).toBe("false")
    await expect(owned.controller.exportSession({ sessionID: id, format: "markdown", debug: true })).rejects.toThrow()
    await expect(owned.controller.exportSession({ sessionID: id, format: "json", debug: "yes" })).rejects.toThrow()
  } finally { await owned.close() }
})

test("Session insights include the compaction history as display data", async () => {
  const owned = await syntheticDesktop((call) => {
    if (call.route === `/api/session/${id}/compaction`) return { data: [{ jobID: "cmp_1", trigger: "manual", status: "completed", created: 4 }], truncated: false, completedBefore: 0, completedCount: 1, totalSavedTokens: 900 }
    return undefined
  })
  try {
    const insights = await owned.controller.sessionInsights({ sessionID: id })
    expect(insights.compactions).toEqual({ data: [{ jobID: "cmp_1", trigger: "manual", status: "completed", created: 4 }], truncated: false, completedBefore: 0, completedCount: 1, totalSavedTokens: 900 })
  } finally { await owned.close() }
})

test("slash commands forward agent, catalog-bound model, mentions and delivery and refuse unknown bindings before any write", async () => {
  const location = { directory: "/synthetic/repo", project: { id: "prj_a", directory: "/synthetic/repo" } }
  const owned = await syntheticDesktop((call) => {
    if (call.route === `/api/session/${id}`) return { data: info(id) }
    if (call.route === "/api/agent") return { location, data: [{ id: "build", name: "build", mode: "primary", hidden: false }, { id: "scout", name: "scout", mode: "subagent", hidden: false }] }
    if (call.route === "/api/model") return { location, data: [{ id: "gpt", modelID: "gpt", providerID: "openai", name: "GPT", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "high" }], profiles: [], time: { released: 1 }, cost: [], status: "active", enabled: true, limit: { context: 200000, output: 32000 } }] }
    if (call.route === "/api/model/default") return { location, data: null }
    if (call.route === `/api/session/${id}/command`) return { data: { admittedSeq: 1, id: call.body.id, sessionID: id, timeCreated: 1, type: "user", delivery: call.body.delivery ?? "steer", data: { text: "/review" } } }
    return undefined
  })
  try {
    const text = "@notes.md"
    const mention = { start: 8, end: 17, text }
    await owned.controller.command({ sessionID: id, promptID: "msg_cmd", command: "review", arguments: text, agent: "build", model: { id: "gpt", providerID: "openai", variant: "high" }, files: [{ uri: "file:///synthetic/repo/notes.md", mention }], agents: [{ name: "scout" }], delivery: "queue" })
    expect(owned.calls.find((call) => call.route.endsWith("/command"))?.body).toEqual({ id: "msg_cmd", command: "review", arguments: text, agent: "build", model: { id: "gpt", providerID: "openai", variant: "high" }, files: [{ uri: "file:///synthetic/repo/notes.md", mention }], agents: [{ name: "scout" }], delivery: "queue" })
    await owned.controller.command({ sessionID: id, promptID: "msg_plain", command: "review" })
    expect(owned.calls.filter((call) => call.route.endsWith("/command")).at(-1)?.body).toEqual({ id: "msg_plain", command: "review" })
    const commands = () => owned.calls.filter((call) => call.route.endsWith("/command")).length
    for (const extra of [{ agent: "scout" }, { agent: "missing" }, { model: { id: "gpt", providerID: "anthropic" } }, { model: { id: "gpt", providerID: "openai", variant: "max" } }, { delivery: "now" }, { files: [{ uri: "https://example.test/a" }] }])
      await expect(owned.controller.command({ sessionID: id, promptID: "msg_bad", command: "review", ...extra })).rejects.toThrow()
    expect(commands()).toBe(2)
  } finally { await owned.close() }
})

test("shell output carries the shell summary and finds family shells in another location", async () => {
  const shellRow = (shellID: string, owner: string, cwd: string) => ({ id: shellID, status: "exited", command: "make", cwd, shell: "sh", file: "output", exit: 0, pid: 7, time: { started: 1, completed: 2 }, metadata: { sessionID: owner, secret: "x" } })
  const owned = await syntheticDesktop((call) => {
    if (call.method === "GET" && call.route === `/api/session/${id}`) return { data: info(id) }
    if (call.method === "GET" && call.route === "/api/session/ses_wt") return { data: info("ses_wt", { parentID: id, location: { directory: "/synthetic/wt" } }) }
    if (call.method === "GET" && call.route === "/api/session") return { data: call.query.get("parentID") === id ? [info("ses_wt", { parentID: id, location: { directory: "/synthetic/wt" } })] : [], cursor: {} }
    if (call.method === "GET" && call.route === "/api/shell") {
      const directory = call.query.get("location[directory]")!
      return { location: { directory }, data: directory === "/synthetic/wt" ? [shellRow("sh_wt", "ses_wt", directory)] : [shellRow("sh_here", id, directory)] }
    }
    if (call.route.endsWith("/output")) return { location: { directory: call.query.get("location[directory]") }, data: { output: "ok", cursor: 2, size: 2, truncated: false } }
    return undefined
  })
  try {
    expect(await owned.controller.shellOutput({ sessionID: id, shellID: "sh_here" })).toEqual({ revision: owned.revision, sessionID: id, shellID: "sh_here", shell: { status: "exited", command: "make", cwd: "/synthetic/repo", pid: 7, exit: 0, time: { started: 1, completed: 2 } }, output: "ok", cursor: 2, size: 2, truncated: false })
    expect(await owned.controller.shellOutput({ sessionID: id, shellID: "sh_wt" })).toMatchObject({ shellID: "sh_wt", shell: { cwd: "/synthetic/wt" } })
    expect(owned.calls.filter((call) => call.route.endsWith("/output")).map((call) => call.query.get("location[directory]"))).toEqual(["/synthetic/repo", "/synthetic/wt"])
    await owned.controller.manageSession({ kind: "kill-shell", revision: owned.revision, sessionID: id, shellID: "sh_wt" })
    expect(owned.calls.filter((call) => call.method === "DELETE").map((call) => [call.route, call.query.get("location[directory]")])).toEqual([["/api/shell/sh_wt", "/synthetic/wt"]])
    await expect(owned.controller.shellOutput({ sessionID: id, shellID: "sh_missing" })).rejects.toThrow("not attributed")
  } finally { await owned.close() }
})

test("telemetry consent is read alone under the current revision and malformed consent is refused", async () => {
  let consent: unknown = { noticeVersion: 1 }
  const owned = await syntheticDesktop((call) => call.route === "/api/server/telemetry/consent" ? consent : undefined)
  try {
    expect(await owned.controller.telemetryConsent()).toEqual({ revision: owned.revision, state: { noticeVersion: 1 } })
    consent = { consent: { enabled: true, noticeVersion: 1, decidedAt: 5, extra: "dropped" }, noticeVersion: 1 }
    expect(await owned.controller.telemetryConsent()).toEqual({ revision: owned.revision, state: { consent: { enabled: true, noticeVersion: 1, decidedAt: 5 }, noticeVersion: 1 } })
    expect(owned.calls.map((call) => `${call.method} ${call.route}`)).toEqual(["GET /api/server/telemetry/consent", "GET /api/server/telemetry/consent"])
    for (const value of [{ noticeVersion: 2 }, { consent: { enabled: "yes", noticeVersion: 1, decidedAt: 5 }, noticeVersion: 1 }, { consent: { enabled: true, noticeVersion: 1, decidedAt: -1 }, noticeVersion: 1 }]) {
      consent = value
      await expect(owned.controller.telemetryConsent()).rejects.toThrow()
    }
  } finally { await owned.close() }
})

test("client telemetry batches are schema-checked and forwarded once", async () => {
  const owned = await syntheticDesktop((call) => call.route === "/api/server/web-latency" ? { accepted: Array.isArray(call.body.samples) ? call.body.samples.length : 0 } : undefined)
  try {
    const sample = { kind: "client", at: "2026-11-15T00:00:00.000Z", surface: "web", metric: "prompt.admit", durationMs: 12 }
    expect(await owned.controller.appendTelemetry({ samples: [sample] })).toEqual({ accepted: 1 })
    expect(owned.calls.map((call) => call.body)).toEqual([{ samples: [sample] }])
    for (const input of [{ samples: [] }, { samples: [{ ...sample, surface: "desktop" }] }, { samples: [{ ...sample, extra: 1 }] }, { samples: Array(21).fill(sample) }, {}])
      await expect(owned.controller.appendTelemetry(input)).rejects.toThrow()
    expect(owned.calls).toHaveLength(1)
  } finally { await owned.close() }
})
