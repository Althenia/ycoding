import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { RemoteCapturedChangesPage } from "@ycoding-ai/remote"
import { deltaChunk, finishChunk, toolCallChunk } from "../../ai/test/lib/openai-chunks"
import { createLocalServer } from "../src/remote-local"
import { createOperationCache, createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"
import { createSession, password, startServer } from "./remote-harness"

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object")
  return Object.fromEntries(Object.entries(value))
}

async function until<Value>(read: () => Promise<Value | undefined>) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error("Isolated tool completion did not settle")
    await Bun.sleep(10)
  }
}

test("real durable edit completion advances the snapshot watermark and invalidates a warmed captured summary", async () => {
  const scratch = join(import.meta.dir, "../../../.cache/tmp")
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, "remote-captured-flow-"))
  await writeFile(join(directory, "sample.txt"), "old\n")
  await writeFile(join(directory, "ycoding.json"), JSON.stringify({ efficiency: { title: "off" }, permissions: [{ action: "edit", resource: "*", effect: "ask" }] }))
  let calls = 0
  const server = await startServer(directory, { provider: {
    text: "Edit completed",
    reply: (request) => {
      const tools = record(request).tools
      if (!Array.isArray(tools) || tools.length === 0) return [deltaChunk({ role: "assistant", content: "Edit sample" }), finishChunk("stop")]
      return ++calls === 1
        ? [toolCallChunk("call_captured_edit", "edit", JSON.stringify({ path: "sample.txt", oldString: "old", newString: "new" })), finishChunk("tool_calls")]
        : [deltaChunk({ role: "assistant", content: "Edit completed" }), finishChunk("stop")]
    },
  } })
  const sessionID = "ses_captured_flow"
  const location = { directory }
  let transcriptReads = 0
  let inventoryReads = 0
  const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
  const counted = {
    ...local,
    messages: (...args: Parameters<typeof local.messages>) => { transcriptReads++; return local.messages(...args) },
    listPage: (...args: Parameters<typeof local.listPage>) => { inventoryReads++; return local.listPage(...args) },
  }
  const sessions = createSessionRegistry({ local: counted })
  const cache = createOperationCache()
  const read = async () => {
    const frames = await executeRemoteOperation({
      request: { type: "request", id: "req_captured", operation: "session.capturedChanges.list", sessionID },
      local: counted, sessions, cache, subscriptions: createSubscriptions(),
    })
    expect(frames).toHaveLength(1)
    const frame = frames[0]
    if (!frame?.ok) throw new Error(JSON.stringify(frame))
    return frame.value as RemoteCapturedChangesPage
  }
  try {
    if (!server.provider) throw new Error("Missing isolated provider")
    await createSession(server, sessionID, directory, { providerID: server.provider.providerID, id: server.provider.modelID })
    await sessions.refresh()
    inventoryReads = 0
    await local.prompt(sessionID, location, { id: "msg_captured_input", text: "Edit sample.txt from old to new." })
    const permission = await until(async () => {
      const pending = await local.permissionList(sessionID, location)
      if (!Array.isArray(pending)) throw new Error("Expected pending permissions")
      return pending.map(record).find((item) => item.action === "edit")
    })
    const before = record(await local.snapshot(sessionID, location, { limit: 1 }))
    const beforeSeq = record(before.watermark).seq
    expect(typeof beforeSeq).toBe("number")
    expect(await read()).toEqual({ data: [] })
    expect(await read()).toEqual({ data: [] })
    expect(transcriptReads).toBe(1)
    expect(await readFile(join(directory, "sample.txt"), "utf8")).toBe("old\n")

    await local.permissionReply(sessionID, location, String(permission.id), "once")
    const success = await until(async () => (await local.log(sessionID, location, Number(beforeSeq))).map(record)
      .find((event) => event.type === "session.tool.success" && record(event.data).callID === "call_captured_edit"))
    const after = record(await local.snapshot(sessionID, location, { limit: 1 }))
    expect(after.sourceEpoch).toBe(before.sourceEpoch)
    expect(record(success.durable).seq).toBeGreaterThan(Number(beforeSeq))
    expect(record(after.watermark).seq).toBeGreaterThanOrEqual(Number(record(success.durable).seq))
    expect(record(record(after.session).time).updated).toBe(record(record(before.session).time).updated)
    expect(await readFile(join(directory, "sample.txt"), "utf8")).toBe("new\n")
    const captured = await read()
    expect(captured.data).toMatchObject([{ path: "sample.txt", additions: 1, deletions: 1, status: "modified" }])
    expect(captured.data[0]?.files[0]?.diff).toContain("-old\n+new")
    expect(transcriptReads).toBe(2)
    expect(inventoryReads).toBe(0)
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

test("real moved and deleted Sessions fail their recorded-placement verification without scanning the inventory", async () => {
  const scratch = join(import.meta.dir, "../../../.cache/tmp")
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, "remote-placement-flow-"))
  const destination = await mkdtemp(join(scratch, "remote-placement-destination-"))
  const server = await startServer(directory)
  const sessionID = "ses_recorded_placement"
  const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
  const calls: string[] = []
  const counted = {
    ...local,
    getSession: (...args: Parameters<typeof local.getSession>) => { calls.push("getSession"); return local.getSession(...args) },
    listPage: (...args: Parameters<typeof local.listPage>) => { calls.push("listPage"); return local.listPage(...args) },
    todoList: (...args: Parameters<typeof local.todoList>) => { calls.push("todoList"); return local.todoList(...args) },
  }
  const sessions = createSessionRegistry({ local: counted })
  const read = () => executeRemoteOperation({
    request: { type: "request", id: "req_placement", operation: "session.todo.list", sessionID },
    local: counted, sessions, subscriptions: createSubscriptions(),
  })
  try {
    await createSession(server, sessionID, directory)
    await sessions.refresh()
    calls.length = 0
    expect(await read()).toMatchObject([{ ok: true, value: { data: [] } }])
    expect(calls).toEqual(["getSession", "todoList"])
    const moved = await server.request(`/api/session/${sessionID}/move`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: destination }),
    })
    expect(moved.status, await moved.clone().text()).toBe(204)
    calls.length = 0
    expect(await read()).toMatchObject([{ ok: false, error: { code: "session_not_allowed" } }])
    expect(calls).toEqual(["getSession"])
    expect(sessions.ids()).toEqual([])
    await sessions.refresh()
    calls.length = 0
    expect(await read()).toMatchObject([{ ok: true }])
    expect(calls).toEqual(["getSession", "todoList"])
    expect(sessions.snapshot()[0]?.location.directory).toBe(destination)
    const deleted = await server.request(`/api/session/${sessionID}`, { method: "DELETE" })
    expect(deleted.status, await deleted.clone().text()).toBe(204)
    calls.length = 0
    expect(await read()).toMatchObject([{ ok: false, error: { code: "session_not_allowed" } }])
    expect(calls).toEqual(["getSession"])
    expect(sessions.ids()).toEqual([])
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
    await rm(destination, { recursive: true, force: true })
  }
}, 60_000)
