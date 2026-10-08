import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import { requireSession, type RemoteRequest } from "@ycoding-ai/remote"
import { LocalFailure, type LocalServer } from "../src/remote-local"
import { createOperationCache, createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"

const scratch = join(import.meta.dir, "../../../.cache/tmp")
await mkdir(scratch, { recursive: true })

type Call = { readonly method: string; readonly args: readonly unknown[] }

function info(id: string, table: { parentID?: string; directory?: string } = {}): SessionInfo {
  return {
    id,
    ...(table.parentID === undefined ? {} : { parentID: table.parentID }),
    projectID: "prj_1",
    model: { providerID: "test", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    title: id,
    location: { directory: table.directory ?? "/work", workspaceID: undefined },
  }
}

function fixture(infos: SessionInfo[], results: Partial<Record<keyof LocalServer, unknown>> = {}, pageSize = 4) {
  results.outstandingSessions ??= { data: [], running: [], failed: [], lost: [] }
  results.projectList ??= []
  results.listPage ??= async (page: { cursor?: string }) => {
    const start = page.cursor === undefined ? 0 : Number(page.cursor)
    const end = start + pageSize
    return { data: infos.slice(start, end), next: end < infos.length ? String(end) : undefined }
  }
  results.getSession ??= async (sessionID: string) => infos.find((item) => item.id === sessionID)
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
  const changes: string[] = []
  const registry = createSessionRegistry({ local, onChange: () => changes.push("changed") })
  const count = (method: string) => calls.filter((call) => call.method === method).length
  const run = (operation: RemoteRequest["operation"], sessionID = "ses_1", input?: Record<string, unknown>, cache?: ReturnType<typeof createOperationCache>) =>
    executeRemoteOperation({
      request: { type: "request", id: "req_1", operation, ...(requireSession(operation) ? { sessionID } : {}), ...(input === undefined ? {} : { input }) },
      local, sessions: registry, subscriptions: createSubscriptions(), ...(cache === undefined ? {} : { cache }),
    })
  return { local, calls, registry, changes, count, run, infos }
}

function valueOf(frames: readonly { ok: boolean }[]) {
  expect(frames).toHaveLength(1)
  const frame = frames[0] as { ok: true; value: unknown }
  expect(frame.ok).toBe(true)
  return frame.value
}

function errorOf(frames: readonly { ok: boolean }[]) {
  expect(frames).toHaveLength(1)
  const frame = frames[0] as { ok: false; error: { code: string } }
  expect(frame.ok).toBe(false)
  return frame.error
}

const scopedFanOut = [
  "session.autonomy.get", "session.todo.list", "session.permission.list", "session.form.list", "session.pending.list",
  "session.guardrail.request.list", "session.snapshot", "session.subagent.list",
] as const

test("a Session-scoped read resolves its Location from the verified inventory with one local read", async () => {
  const sessions = Array.from({ length: 40 }, (_, index) => info(`ses_${index + 1}`))
  const test = fixture(sessions, {
    autonomyGet: { mode: "normal" }, todoList: [], permissionList: [], formList: [], pendingList: [], guardrailRequestList: [],
    snapshot: { sourceEpoch: "epoch_1", messages: [], watermark: { seq: 1 } }, subagentPage: { data: [] },
  })
  await test.registry.refresh()
  expect(test.count("listPage")).toBe(10)
  test.calls.length = 0

  valueOf(await test.run("session.autonomy.get", "ses_40"))
  expect(test.calls.map((call) => call.method)).toEqual(["getSession", "autonomyGet"])
  expect(test.calls[0]?.args).toEqual(["ses_40", { directory: "/work" }])

  test.calls.length = 0
  for (const operation of scopedFanOut) valueOf(await test.run(operation, "ses_40"))
  expect(test.count("listPage")).toBe(0)
  expect(test.count("getSession")).toBe(scopedFanOut.length)
})

test("a Session unknown to the inventory is located once, joins the inventory, and is then served directly", async () => {
  const sessions = Array.from({ length: 12 }, (_, index) => info(`ses_${index + 1}`))
  const test = fixture(sessions, { autonomyGet: { mode: "normal" } })
  await test.registry.refresh()
  test.infos.push(info("ses_new"))
  test.calls.length = 0
  test.changes.length = 0

  valueOf(await test.run("session.autonomy.get", "ses_new"))
  expect(test.count("listPage")).toBe(4)
  expect(test.count("getSession")).toBe(1)
  expect(test.registry.ids()).toContain("ses_new")
  expect(test.changes).toHaveLength(1)

  test.calls.length = 0
  valueOf(await test.run("session.autonomy.get", "ses_new"))
  expect(test.calls.map((call) => call.method)).toEqual(["getSession", "autonomyGet"])

  test.calls.length = 0
  expect(errorOf(await test.run("session.autonomy.get", "ses_missing")).code).toBe("session_not_allowed")
  expect(test.count("getSession")).toBe(0)
})

test("a Session that moved or was deleted fails closed on its single verification and leaves the inventory", async () => {
  const sessions = [info("ses_1"), info("ses_2")]
  let gone = false
  const test = fixture(sessions, {
    autonomyGet: { mode: "normal" },
    getSession: async (sessionID: string) => {
      if (gone && sessionID === "ses_1") throw new LocalFailure("not_found", "Session is not available at the recorded location")
      return sessions.find((item) => item.id === sessionID)
    },
  })
  await test.registry.refresh()
  valueOf(await test.run("session.autonomy.get", "ses_1"))
  gone = true
  test.calls.length = 0
  test.changes.length = 0

  expect(errorOf(await test.run("session.autonomy.get", "ses_1")).code).toBe("session_not_allowed")
  expect(test.calls.map((call) => call.method)).toEqual(["getSession"])
  expect(test.registry.ids()).toEqual(["ses_2"])
  expect(test.changes).toHaveLength(1)
})

test("an inventory refresh cannot overwrite a newer scoped verification", async () => {
  let current = info("ses_1")
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let hold = false
  const test = fixture([current], {
    listPage: async () => {
      const data = [current]
      if (hold) { started.resolve(); await release.promise }
      return { data }
    },
    getSession: async () => current,
  })
  await test.registry.refresh()
  hold = true
  const refreshing = test.registry.refresh()
  await started.promise
  current = { ...current, title: "Fresh title", time: { ...current.time, updated: 2 } }
  await test.registry.verify(current.id)
  release.resolve()
  await refreshing
  expect(test.registry.snapshot()).toEqual([current])
})

test("an inventory refresh cannot resurrect a Session rejected during the refresh", async () => {
  const original = info("ses_1")
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let hold = false
  const test = fixture([original], {
    autonomyGet: { mode: "normal" },
    listPage: async () => {
      if (hold) { started.resolve(); await release.promise }
      return { data: [original] }
    },
    getSession: async () => {
      if (hold) throw new LocalFailure("not_found", "Session moved")
      return original
    },
  })
  await test.registry.refresh()
  hold = true
  const refreshing = test.registry.refresh()
  await started.promise
  expect(errorOf(await test.run("session.autonomy.get")).code).toBe("session_not_allowed")
  release.resolve()
  await refreshing
  expect(test.registry.ids()).toEqual([])
})

test("a stale scoped lookup cannot overwrite or authorize placement changed by a concurrent refresh", async () => {
  let current = info("ses_1")
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const test = fixture([current], {
    autonomyGet: { mode: "normal" },
    listPage: async () => ({ data: [current] }),
    getSession: async () => {
      const observed = current
      started.resolve()
      await release.promise
      return observed
    },
  })
  await test.registry.refresh()
  const reading = test.run("session.autonomy.get")
  await started.promise
  current = { ...current, location: { directory: "/moved" } }
  await test.registry.refresh()
  release.resolve()
  expect(errorOf(await reading).code).toBe("session_not_allowed")
  expect(test.registry.snapshot()).toEqual([current])
  expect(test.count("autonomyGet")).toBe(0)
})

test("a failed later inventory page leaves the complete verified inventory intact", async () => {
  const infos = Array.from({ length: 6 }, (_, index) => info(`ses_${index + 1}`))
  let fail = false
  const test = fixture(infos, { listPage: async (page: { cursor?: string }) => {
    if (page.cursor === undefined) return { data: infos.slice(0, 4), next: "4" }
    if (fail) throw new LocalFailure("transport", "Inventory page failed")
    return { data: infos.slice(4) }
  } })
  await test.registry.refresh()
  fail = true
  const failure = await test.registry.refresh().then(() => undefined, (cause: unknown) => cause)
  expect(failure).toBeInstanceOf(LocalFailure)
  expect(test.registry.snapshot()).toEqual(infos)
})

const capturedPatch = (file: string) => `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new`
const capturedEdit = (file: string) => ({ type: "tool", id: `call_${file}`, name: "edit",
  state: { status: "completed", structured: { files: [{ file, patch: capturedPatch(file), additions: 1, deletions: 1 }] } } })
const reply = (id: string, content: unknown[]) => ({ id, type: "assistant", time: { created: 2, completed: 3 }, content })
const launch = (childID: string) => ({ type: "tool", id: `call_${childID}`, name: "subagent", state: { status: "completed", structured: { sessionID: childID } } })

function capturedFixture(childCount: number) {
  const children = Array.from({ length: childCount }, (_, index) => `ses_child_${index + 1}`)
  const infos = [info("ses_1"), ...children.map((id) => info(id, { parentID: "ses_1", directory: "/child" }))]
  const seqs = new Map(infos.map((item) => [item.id, 1]))
  const epochs = new Map(infos.map((item) => [item.id, "epoch_1"]))
  const files = new Map<string, string[]>([["ses_1", ["src/parent.ts"]], ...children.map((id): [string, string[]] => [id, [`src/${id}.ts`]])])
  const messageReads = { inFlight: 0, peak: 0 }
  const missing = new Set<string>()
  const messages = async (sessionID: string) => {
    messageReads.inFlight++
    messageReads.peak = Math.max(messageReads.peak, messageReads.inFlight)
    await Promise.resolve()
    messageReads.inFlight--
    const edits = (files.get(sessionID) ?? []).map(capturedEdit)
    return sessionID === "ses_1"
      ? [{ id: "msg_user", type: "user" }, reply("msg_reply", [...children.map(launch), ...edits])]
      : [{ id: `msg_task_${sessionID}`, type: "user" }, reply(`msg_${sessionID}`, edits)]
  }
  const test = fixture(infos, {
    messages,
    snapshot: async (sessionID: string) => ({ sourceEpoch: epochs.get(sessionID), messages: [], watermark: { seq: seqs.get(sessionID) } }),
    getSession: async (sessionID: string) => {
      if (missing.has(sessionID)) throw new LocalFailure("not_found", "Session is not available at the recorded location")
      return infos.find((item) => item.id === sessionID)
    },
  })
  const read = async (cache?: ReturnType<typeof createOperationCache>, cursor?: string) =>
    valueOf(await test.run("session.capturedChanges.list", "ses_1", cursor === undefined ? undefined : { cursor }, cache)) as { data: { path: string }[]; cursor?: { next: string } }
  return { ...test, seqs, epochs, files, messageReads, missing, read, children }
}

test("captured changes reuse the computed groups until the Session or an involved child records a new durable event", async () => {
  const test = capturedFixture(1)
  const cache = createOperationCache()
  await test.registry.refresh()
  test.calls.length = 0

  const first = await test.read(cache)
  expect(first.data.map((group) => group.path).sort()).toEqual(["src/parent.ts", "src/ses_child_1.ts"])
  expect(test.count("messages")).toBe(2)

  test.calls.length = 0
  expect(await test.read(cache)).toEqual(first)
  expect(test.count("messages")).toBe(0)
  expect(test.count("getSession")).toBe(2)

  test.files.set("ses_child_1", ["src/ses_child_1.ts", "src/later.ts"])
  test.seqs.set("ses_child_1", 2)
  test.calls.length = 0
  expect((await test.read(cache)).data.map((group) => group.path).sort()).toEqual(["src/later.ts", "src/parent.ts", "src/ses_child_1.ts"])
  expect(test.count("messages")).toBe(2)

  test.files.set("ses_1", ["src/parent.ts", "src/parent-two.ts"])
  test.seqs.set("ses_1", 2)
  test.calls.length = 0
  expect((await test.read(cache)).data.map((group) => group.path)).toContain("src/parent-two.ts")
  expect(test.count("messages")).toBe(2)
})

test("captured changes without a cache load the transcripts on every call", async () => {
  const test = capturedFixture(1)
  await test.registry.refresh()
  test.calls.length = 0
  await test.read()
  await test.read()
  expect(test.count("messages")).toBe(4)
  expect(test.count("snapshot")).toBe(0)
})

test("a cached summary invalidates on an epoch reset even when the durable sequence is reused", async () => {
  const test = capturedFixture(1)
  await test.registry.refresh()
  const cache = createOperationCache()
  await test.read(cache)
  test.files.set("ses_child_1", ["src/replayed.ts"])
  test.epochs.set("ses_child_1", "epoch_2")
  test.calls.length = 0
  expect((await test.read(cache)).data.map((file) => file.path).sort()).toEqual(["src/parent.ts", "src/replayed.ts"])
  expect(test.count("messages")).toBe(2)
  test.calls.length = 0
  await test.read(cache)
  expect(test.count("messages")).toBe(0)
})

test("parent transcript pruning and dispatch reordering rebuild captured membership in transcript order", async () => {
  const test = capturedFixture(2)
  await test.registry.refresh()
  const cache = createOperationCache()
  await test.read(cache)
  test.children.reverse()
  test.seqs.set("ses_1", 2)
  expect((await test.read(cache)).data.map((file) => file.path)).toEqual(["src/parent.ts", "src/ses_child_2.ts", "src/ses_child_1.ts"])
  test.children.pop()
  test.seqs.set("ses_1", 3)
  expect((await test.read(cache)).data.map((file) => file.path)).toEqual(["src/parent.ts", "src/ses_child_2.ts"])
  test.calls.length = 0
  await test.read(cache)
  expect(test.calls.filter((call) => call.method === "getSession").map((call) => call.args[0])).toEqual(["ses_1", "ses_child_2"])
  expect(test.count("messages")).toBe(0)
})

test("a cached captured page still drops a child that was deleted or moved even though its event position is unchanged", async () => {
  const test = capturedFixture(1)
  const cache = createOperationCache()
  await test.registry.refresh()
  expect((await test.read(cache)).data).toHaveLength(2)
  test.missing.add("ses_child_1")
  test.calls.length = 0
  expect((await test.read(cache)).data.map((group) => group.path)).toEqual(["src/parent.ts"])
})

test("a moved child rejected by cache validation is not rediscovered during the same captured read", async () => {
  const parent = info("ses_1")
  let child = info("ses_child", { parentID: parent.id, directory: "/child" })
  const test = fixture([parent, child], {
    listPage: async () => ({ data: [parent, child] }),
    getSession: async (id: string, location: { directory: string }) => {
      if (id === parent.id) return parent
      if (location.directory !== child.location.directory) throw new LocalFailure("not_found", "Session moved")
      return child
    },
    snapshot: { sourceEpoch: "epoch_1", watermark: { seq: 1 } },
    messages: async (id: string) => [{ id: "msg_user", type: "user" }, reply(`msg_${id}`, id === parent.id
      ? [launch(child.id), capturedEdit("parent.ts")] : [capturedEdit("child.ts")])],
  })
  await test.registry.refresh()
  const cache = createOperationCache()
  const read = async () => valueOf(await test.run("session.capturedChanges.list", parent.id, undefined, cache)) as { data: { path: string }[] }
  expect((await read()).data.map((file) => file.path).sort()).toEqual(["child.ts", "parent.ts"])
  child = { ...child, location: { directory: "/moved" } }
  test.calls.length = 0
  expect((await read()).data.map((file) => file.path)).toEqual(["parent.ts"])
  expect(test.count("listPage")).toBe(0)
  expect(test.calls.filter((call) => call.method === "messages").map((call) => call.args[0])).toEqual([parent.id])
})

test.each(["event", "epoch"])("a transcript spanning a durable %s change is not retained in the cache", async (change) => {
  let epoch = "epoch_1"
  let seq = 1
  let changed = false
  const test = fixture([info("ses_1")], {
    snapshot: async () => ({ sourceEpoch: epoch, watermark: { seq } }),
    messages: async () => {
      if (!changed) {
        changed = true
        if (change === "epoch") epoch = "epoch_2"
        else seq++
      }
      return [{ id: "msg_user", type: "user" }, reply("msg_reply", [capturedEdit("fresh.ts")])]
    },
  })
  await test.registry.refresh()
  const cache = createOperationCache()
  valueOf(await test.run("session.capturedChanges.list", "ses_1", undefined, cache))
  expect(cache.capturedChanges.size).toBe(0)
  test.calls.length = 0
  expect(valueOf(await test.run("session.capturedChanges.list", "ses_1", undefined, cache))).toMatchObject({ data: [{ path: "fresh.ts" }] })
  expect(test.count("messages")).toBe(1)
  test.calls.length = 0
  valueOf(await test.run("session.capturedChanges.list", "ses_1", undefined, cache))
  expect(test.count("messages")).toBe(0)
})

test("an older in-flight transcript cannot replace a newer captured cache entry", async () => {
  let seq = 1
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const test = fixture([info("ses_1")], {
    snapshot: async () => ({ sourceEpoch: "epoch_1", watermark: { seq } }),
    messages: async () => {
      const observed = seq
      if (observed === 1) { started.resolve(); await release.promise }
      return [{ id: "msg_user", type: "user" }, reply("msg_reply", [capturedEdit(observed === 1 ? "old.ts" : "fresh.ts")])]
    },
  })
  await test.registry.refresh()
  const cache = createOperationCache()
  const older = test.run("session.capturedChanges.list", "ses_1", undefined, cache)
  await started.promise
  seq = 2
  expect(valueOf(await test.run("session.capturedChanges.list", "ses_1", undefined, cache))).toMatchObject({ data: [{ path: "fresh.ts" }] })
  release.resolve()
  valueOf(await older)
  test.calls.length = 0
  expect(valueOf(await test.run("session.capturedChanges.list", "ses_1", undefined, cache))).toMatchObject({ data: [{ path: "fresh.ts" }] })
  expect(test.count("messages")).toBe(0)
})

test("a captured page cursor survives a cache hit and goes stale when the groups change", async () => {
  const test = capturedFixture(0)
  const many = Array.from({ length: 130 }, (_, index) => `src/file-${String(index).padStart(3, "0")}.ts`)
  test.files.set("ses_1", many)
  const cache = createOperationCache()
  await test.registry.refresh()
  const first = await test.read(cache)
  expect(first.cursor).toBeDefined()
  test.calls.length = 0
  const second = await test.read(cache, first.cursor!.next)
  expect(test.count("messages")).toBe(0)
  expect(first.data.length + second.data.length).toBe(130)
  test.files.set("ses_1", [...many, "src/extra.ts"])
  test.seqs.set("ses_1", 2)
  expect(errorOf(await test.run("session.capturedChanges.list", "ses_1", { cursor: first.cursor!.next }, cache)).code).toBe("invalid_message")
})

test("captured changes load child transcripts concurrently within a bound of four", async () => {
  const test = capturedFixture(9)
  await test.registry.refresh()
  const page = await test.read()
  expect(page.data).toHaveLength(10)
  expect(test.messageReads.peak).toBeGreaterThan(1)
  expect(test.messageReads.peak).toBeLessThanOrEqual(4)
})

test("the captured-change cache is bounded and evicts the least recently used Session", async () => {
  const infos = Array.from({ length: 34 }, (_, index) => info(`ses_${index + 1}`))
  let reads = 0
  const test = fixture(infos, {
    messages: async (sessionID: string) => { reads++; return [{ id: "msg_user", type: "user" }, reply(`msg_${sessionID}`, [capturedEdit(`src/${sessionID}.ts`)])] },
    snapshot: async () => ({ sourceEpoch: "epoch_1", messages: [], watermark: { seq: 1 } }),
  })
  await test.registry.refresh()
  const cache = createOperationCache()
  for (const item of infos) valueOf(await test.run("session.capturedChanges.list", item.id, undefined, cache))
  expect(reads).toBe(34)
  valueOf(await test.run("session.capturedChanges.list", "ses_34", undefined, cache))
  expect(reads).toBe(34)
  valueOf(await test.run("session.capturedChanges.list", "ses_1", undefined, cache))
  expect(reads).toBe(35)
})

test("session workspaces reuse a directory permission result until its lifetime elapses and keep denying temporary directories", async () => {
  const kept = await mkdtemp(join(scratch, "ycoding-remote-reads-"))
  const temporary = await mkdtemp(join(tmpdir(), "ycoding-remote-reads-"))
  try {
    let now = 1_000
    const cache = createOperationCache(() => now)
    const test = fixture([info("ses_1", { directory: kept }), info("ses_2", { directory: temporary })])
    await test.registry.refresh()
    const directories = async () => (valueOf(await test.run("workspace.list", "ses_1", { sessionsOnly: true }, cache)) as { data: { directory: string }[] }).data.map((item) => item.directory)

    expect(await directories()).toEqual([kept])
    await rm(kept, { recursive: true, force: true })
    now += 29_000
    expect(await directories()).toEqual([kept])
    now += 2_000
    expect(await directories()).toEqual([])
  } finally {
    await rm(kept, { recursive: true, force: true })
    await rm(temporary, { recursive: true, force: true })
  }
})

test("a warmed directory display cache cannot authorize creation or catalog reads after a symlink policy change", async () => {
  const kept = await mkdtemp(join(scratch, "ycoding-remote-policy-"))
  const temporary = await mkdtemp(join(tmpdir(), "ycoding-remote-policy-"))
  try {
    const test = fixture([info("ses_1", { directory: kept })], { projectCurrent: { id: "prj_1" } })
    await test.registry.refresh()
    const cache = createOperationCache()
    const workspaces = valueOf(await test.run("workspace.list", "ses_1", { sessionsOnly: true }, cache)) as { data: { id: string }[] }
    const workspace = workspaces.data[0]?.id
    expect(workspace).toBeDefined()
    await rm(kept, { recursive: true, force: true })
    await symlink(temporary, kept)
    test.calls.length = 0
    expect(errorOf(await test.run("workspace.catalog", "ses_1", { workspace }, cache)).code).toBe("invalid_message")
    expect(errorOf(await test.run("session.create", "ses_1", { id: "ses_new", workspace }, cache)).code).toBe("invalid_message")
    expect(test.count("projectCurrent")).toBe(0)
    expect(test.count("createSession")).toBe(0)
    expect(test.count("listPage")).toBe(0)
  } finally {
    await rm(kept, { recursive: true, force: true })
    await rm(temporary, { recursive: true, force: true })
  }
})
