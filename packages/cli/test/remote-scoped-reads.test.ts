import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import { requireSession, type RemoteCapturedChangesPage, type RemoteRequest } from "@ycoding-ai/remote"
import { LocalFailure, type LocalServer } from "../src/remote-local"
import {
  createOperationCache,
  markSessionActivity,
  createSessionRegistry,
  createSubscriptions,
  executeRemoteOperation,
} from "../src/remote-operations"

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
  results.snapshot ??= (id: string) => ({
    sourceEpoch: "epoch_1",
    watermark: { type: "log.synced", aggregateID: id, seq: 1 },
  })
  results.projectList ??= []
  results.listPage ??= async (page: { cursor?: string }) => {
    const start = page.cursor === undefined ? 0 : Number(page.cursor)
    const end = start + pageSize
    return { data: infos.slice(start, end), next: end < infos.length ? String(end) : undefined }
  }
  results.getSession ??= async (sessionID: string) => infos.find((item) => item.id === sessionID)
  const calls: Call[] = []
  const local = new Proxy({} as LocalServer, {
    get:
      (_target, property: PropertyKey) =>
      (...args: unknown[]) => {
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
  const run = (
    operation: RemoteRequest["operation"],
    sessionID = "ses_1",
    input?: Record<string, unknown>,
    cache?: ReturnType<typeof createOperationCache>,
  ) =>
    executeRemoteOperation({
      request: {
        type: "request",
        id: "req_1",
        operation,
        ...(requireSession(operation) ? { sessionID } : {}),
        ...(input === undefined ? {} : { input }),
      },
      local,
      sessions: registry,
      subscriptions: createSubscriptions(),
      ...(cache === undefined ? {} : { cache }),
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
  "session.autonomy.get",
  "session.todo.list",
  "session.permission.list",
  "session.form.list",
  "session.pending.list",
  "session.guardrail.request.list",
  "session.snapshot",
  "session.subagent.list",
] as const

test("a Session-scoped read resolves its Location from the verified inventory with one local read", async () => {
  const sessions = Array.from({ length: 40 }, (_, index) => info(`ses_${index + 1}`))
  const test = fixture(sessions, {
    autonomyGet: { mode: "normal" },
    todoList: [],
    permissionList: [],
    formList: [],
    pendingList: [],
    guardrailRequestList: [],
    snapshot: { sourceEpoch: "epoch_1", messages: [], watermark: { seq: 1 } },
    subagentPage: { data: [] },
  })
  await test.registry.refresh()
  expect(test.count("listPage")).toBe(10)
  test.calls.length = 0

  valueOf(await test.run("session.autonomy.get", "ses_40"))
  expect(test.calls.map((call) => call.method)).toEqual(["getSession", "autonomyGet"])
  expect(test.calls[0]?.args.slice(0, 2)).toEqual(["ses_40", { directory: "/work" }])

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
      if (gone && sessionID === "ses_1")
        throw new LocalFailure("not_found", "Session is not available at the recorded location")
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
      if (hold) {
        started.resolve()
        await release.promise
      }
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
      if (hold) {
        started.resolve()
        await release.promise
      }
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
  const test = fixture(infos, {
    listPage: async (page: { cursor?: string }) => {
      if (page.cursor === undefined) return { data: infos.slice(0, 4), next: "4" }
      if (fail) throw new LocalFailure("transport", "Inventory page failed")
      return { data: infos.slice(4) }
    },
  })
  await test.registry.refresh()
  fail = true
  const failure = await test.registry.refresh().then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(failure).toBeInstanceOf(LocalFailure)
  expect(test.registry.snapshot()).toEqual(infos)
})

const capturedPatch = (file: string) => `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new`
const capturedEdit = (file: string) => ({
  type: "tool",
  id: `call_${file}`,
  name: "edit",
  state: {
    status: "completed",
    structured: { files: [{ file, patch: capturedPatch(file), additions: 1, deletions: 1 }] },
  },
})
const reply = (id: string, content: unknown[]) => ({
  id,
  type: "assistant",
  time: { created: 2, completed: 3 },
  content,
})
const launch = (childID: string) => ({
  type: "tool",
  id: `call_${childID}`,
  name: "subagent",
  state: { status: "completed", structured: { sessionID: childID } },
})

test("captured summary reads only selective attribution inputs for the root and verified child", async () => {
  const test = fixture([info("ses_1"), info("ses_child", { parentID: "ses_1", directory: "/child" })], {
    messages: () => {
      throw new Error("Complete transcript fetch is prohibited for captured summary")
    },
    capturedInputs: (id: string) =>
      id === "ses_1"
        ? [{ id: "msg_user", type: "user" }, reply("msg_reply", [launch("ses_child"), capturedEdit("parent.ts")])]
        : [{ id: "msg_child_user", type: "user" }, reply("msg_child_reply", [capturedEdit("child.ts")])],
  })
  await test.registry.refresh()
  expect(valueOf(await test.run("session.capturedChanges.list"))).toMatchObject({
    data: [{ path: "parent.ts" }, { path: "child.ts" }],
  })
  expect(test.count("messages")).toBe(0)
  expect(test.calls.filter((call) => call.method === "capturedInputs").map((call) => call.args.slice(0, 2))).toEqual([
    ["ses_1", { directory: "/work" }],
    ["ses_child", { directory: "/child" }],
  ])
})

function capturedFixture(childCount: number) {
  const children = Array.from({ length: childCount }, (_, index) => `ses_child_${index + 1}`)
  const infos = [info("ses_1"), ...children.map((id) => info(id, { parentID: "ses_1", directory: "/child" }))]
  const seqs = new Map(infos.map((item) => [item.id, 1]))
  const epochs = new Map(infos.map((item) => [item.id, "epoch_1"]))
  const files = new Map<string, string[]>([
    ["ses_1", ["src/parent.ts"]],
    ...children.map((id): [string, string[]] => [id, [`src/${id}.ts`]]),
  ])
  const messageReads = { inFlight: 0, peak: 0 }
  const missing = new Set<string>()
  const capturedInputs = async (sessionID: string) => {
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
    capturedInputs,
    snapshot: async (sessionID: string) => ({
      sourceEpoch: epochs.get(sessionID),
      messages: [],
      watermark: { seq: seqs.get(sessionID) },
    }),
    getSession: async (sessionID: string) => {
      if (missing.has(sessionID))
        throw new LocalFailure("not_found", "Session is not available at the recorded location")
      return infos.find((item) => item.id === sessionID)
    },
  })
  const read = async (cache?: ReturnType<typeof createOperationCache>, cursor?: string) =>
    valueOf(
      await test.run("session.capturedChanges.list", "ses_1", cursor === undefined ? undefined : { cursor }, cache),
    ) as { data: { path: string }[]; cursor?: { next: string } }
  return { ...test, seqs, epochs, files, messageReads, missing, read, children }
}

test("captured changes reuse the computed groups until the Session moves or a step ends in an involved child", async () => {
  const test = capturedFixture(1)
  const cache = createOperationCache()
  await test.registry.refresh()
  test.calls.length = 0

  const first = await test.read(cache)
  expect(first.data.map((group) => group.path).sort()).toEqual(["src/parent.ts", "src/ses_child_1.ts"])
  expect(test.count("capturedInputs")).toBe(2)

  test.calls.length = 0
  expect(await test.read(cache)).toEqual(first)
  expect(test.count("capturedInputs")).toBe(0)
  expect(test.count("getSession")).toBe(1)
  expect(test.count("snapshot")).toBe(1)

  test.files.set("ses_child_1", ["src/ses_child_1.ts", "src/later.ts"])
  test.seqs.set("ses_child_1", 2)
  test.calls.length = 0
  expect((await test.read(cache)).data.map((group) => group.path).sort()).toEqual(["src/parent.ts", "src/ses_child_1.ts"])
  expect(test.count("capturedInputs")).toBe(0)

  markSessionActivity(cache, "ses_child_1")
  test.calls.length = 0
  expect((await test.read(cache)).data.map((group) => group.path).sort()).toEqual([
    "src/later.ts",
    "src/parent.ts",
    "src/ses_child_1.ts",
  ])
  expect(test.count("capturedInputs")).toBe(2)

  test.files.set("ses_1", ["src/parent.ts", "src/parent-two.ts"])
  test.seqs.set("ses_1", 2)
  test.calls.length = 0
  expect((await test.read(cache)).data.map((group) => group.path)).toContain("src/parent-two.ts")
  expect(test.count("capturedInputs")).toBe(2)
})

test("captured changes without a cache load selective inputs and fence every call", async () => {
  const test = capturedFixture(1)
  await test.registry.refresh()
  test.calls.length = 0
  await test.read()
  await test.read()
  expect(test.count("capturedInputs")).toBe(4)
  expect(test.count("snapshot")).toBe(6)
})

test("a cached summary invalidates on an epoch reset even when the durable sequence is reused", async () => {
  const test = capturedFixture(1)
  await test.registry.refresh()
  const cache = createOperationCache()
  await test.read(cache)
  test.files.set("ses_child_1", ["src/replayed.ts"])
  test.epochs.set("ses_child_1", "epoch_2")
  markSessionActivity(cache, "ses_child_1")
  test.calls.length = 0
  expect((await test.read(cache)).data.map((file) => file.path).sort()).toEqual(["src/parent.ts", "src/replayed.ts"])
  expect(test.count("capturedInputs")).toBe(2)
  test.calls.length = 0
  await test.read(cache)
  expect(test.count("capturedInputs")).toBe(0)
})

test("parent transcript pruning and dispatch reordering rebuild captured membership in transcript order", async () => {
  const test = capturedFixture(2)
  await test.registry.refresh()
  const cache = createOperationCache()
  await test.read(cache)
  test.children.reverse()
  test.seqs.set("ses_1", 2)
  expect((await test.read(cache)).data.map((file) => file.path)).toEqual([
    "src/parent.ts",
    "src/ses_child_2.ts",
    "src/ses_child_1.ts",
  ])
  test.children.pop()
  test.seqs.set("ses_1", 3)
  expect((await test.read(cache)).data.map((file) => file.path)).toEqual(["src/parent.ts", "src/ses_child_2.ts"])
  test.calls.length = 0
  await test.read(cache)
  expect(test.calls.filter((call) => call.method === "getSession").map((call) => call.args[0])).toEqual(["ses_1"])
  expect(test.count("capturedInputs")).toBe(0)
})

test("a cached captured page drops a child whose inventory event was observed even though its event position is unchanged", async () => {
  const test = capturedFixture(1)
  const cache = createOperationCache()
  await test.registry.refresh()
  expect((await test.read(cache)).data).toHaveLength(2)
  test.missing.add("ses_child_1")
  markSessionActivity(cache, "ses_child_1")
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
    capturedInputs: async (id: string) => [
      { id: "msg_user", type: "user" },
      reply(`msg_${id}`, id === parent.id ? [launch(child.id), capturedEdit("parent.ts")] : [capturedEdit("child.ts")]),
    ],
  })
  await test.registry.refresh()
  const cache = createOperationCache()
  const read = async () =>
    valueOf(await test.run("session.capturedChanges.list", parent.id, undefined, cache)) as { data: { path: string }[] }
  expect((await read()).data.map((file) => file.path).sort()).toEqual(["child.ts", "parent.ts"])
  child = { ...child, location: { directory: "/moved" } }
  markSessionActivity(cache, child.id)
  test.calls.length = 0
  expect((await read()).data.map((file) => file.path)).toEqual(["parent.ts"])
  expect(test.count("listPage")).toBe(0)
  expect(test.calls.filter((call) => call.method === "capturedInputs").map((call) => call.args[0])).toEqual([parent.id])
})

test.each(["event", "epoch"])(
  "a transcript spanning a durable %s change fails without publishing mixed groups",
  async (change) => {
    let epoch = "epoch_1"
    let seq = 1
    let changed = false
    const test = fixture([info("ses_1")], {
      snapshot: async () => ({ sourceEpoch: epoch, watermark: { seq } }),
      capturedInputs: async () => {
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
    expect(errorOf(await test.run("session.capturedChanges.list", "ses_1", undefined, cache)).code).toBe(
      "internal_error",
    )
    expect(cache.capturedChanges.size).toBe(0)
    test.calls.length = 0
    expect(valueOf(await test.run("session.capturedChanges.list", "ses_1", undefined, cache))).toMatchObject({
      data: [{ path: "fresh.ts" }],
    })
    expect(test.count("capturedInputs")).toBe(1)
    test.calls.length = 0
    valueOf(await test.run("session.capturedChanges.list", "ses_1", undefined, cache))
    expect(test.count("capturedInputs")).toBe(0)
  },
)

test("concurrent captured reads of one Session share a single read and its torn outcome", async () => {
  let seq = 1
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const test = fixture([info("ses_1")], {
    snapshot: async () => ({ sourceEpoch: "epoch_1", watermark: { seq } }),
    capturedInputs: async () => {
      const observed = seq
      if (observed === 1) {
        started.resolve()
        await release.promise
      }
      return [
        { id: "msg_user", type: "user" },
        reply("msg_reply", [capturedEdit(observed === 1 ? "old.ts" : "fresh.ts")]),
      ]
    },
  })
  await test.registry.refresh()
  const cache = createOperationCache()
  const older = test.run("session.capturedChanges.list", "ses_1", undefined, cache)
  await started.promise
  const joined = test.run("session.capturedChanges.list", "ses_1", undefined, cache)
  seq = 2
  release.resolve()
  expect(errorOf(await older).code).toBe("internal_error")
  expect(errorOf(await joined).code).toBe("internal_error")
  expect(test.count("capturedInputs")).toBe(1)
  expect(cache.capturedChanges.size).toBe(0)
  expect(valueOf(await test.run("session.capturedChanges.list", "ses_1", undefined, cache))).toMatchObject({
    data: [{ path: "fresh.ts" }],
  })
})

test("no-cache captured reads reject a projection mutation between selective pages", async () => {
  let seq = 1
  let moved = false
  let mutate = true
  const test = fixture([info("ses_1"), info("ses_child", { parentID: "ses_1", directory: "/child" })], {
    snapshot: (id: string) => ({
      sourceEpoch: "epoch_1",
      watermark: { type: "log.synced", aggregateID: id, seq },
    }),
    getSession: (id: string) =>
      id === "ses_1" ? info(id) : info(id, { parentID: "ses_1", directory: moved ? "/moved" : "/child" }),
    capturedInputs: async (id: string) => {
      if (id === "ses_1") {
        const firstPage = [
          { id: "msg_user", type: "user" },
          reply("msg_step", [capturedEdit("old.ts"), launch("ses_child")]),
        ]
        await Promise.resolve()
        if (mutate) seq++
        return [...firstPage, reply("msg_reply", [capturedEdit("new.ts")])]
      }
      await Promise.resolve()
      if (mutate) moved = true
      return [{ id: "msg_child_user", type: "user" }, reply("msg_child", [capturedEdit("child.ts")])]
    },
  })
  await test.registry.refresh()
  expect(errorOf(await test.run("session.capturedChanges.list")).code).toBe("internal_error")
  mutate = false
  moved = false
  expect(valueOf(await test.run("session.capturedChanges.list"))).toMatchObject({
    data: [{ path: "old.ts" }, { path: "new.ts" }, { path: "child.ts" }],
  })
})

test("captured reads accept an empty aggregate watermark but fail closed on missing or invalid fences", async () => {
  const test = fixture([info("ses_1")], {
    capturedInputs: [],
    snapshot: { sourceEpoch: "epoch_1", watermark: { type: "log.synced", aggregateID: "ses_1" } },
  })
  await test.registry.refresh()
  expect(valueOf(await test.run("session.capturedChanges.list"))).toEqual({ data: [] })
  for (const snapshot of [
    undefined,
    { watermark: { seq: 1 } },
    { sourceEpoch: "epoch_1" },
    { sourceEpoch: "epoch_1", watermark: {} },
    { sourceEpoch: "epoch_1", watermark: { seq: -1 } },
  ]) {
    const invalid = fixture([info("ses_1")], { snapshot: () => snapshot, capturedInputs: [] })
    await invalid.registry.refresh()
    expect(errorOf(await invalid.run("session.capturedChanges.list")).code).toBe("internal_error")
    expect(invalid.count("capturedInputs")).toBe(0)
  }
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
  expect(test.count("capturedInputs")).toBe(0)
  expect(first.data.length + second.data.length).toBe(130)
  test.files.set("ses_1", [...many, "src/extra.ts"])
  test.seqs.set("ses_1", 2)
  expect(
    errorOf(await test.run("session.capturedChanges.list", "ses_1", { cursor: first.cursor!.next }, cache)).code,
  ).toBe("invalid_message")
})

test("oversized validated groups retain only their returned unavailable form and cursors track visible changes", async () => {
  let seq = 1
  let hugeLine = "x".repeat(600_000)
  let visibleLine = "new"
  const edit = (file: string, patch: string) => ({
    ...capturedEdit(file),
    state: { status: "completed", structured: { files: [{ file, patch }] } },
  })
  const test = fixture([info("ses_1")], {
    snapshot: () => ({ sourceEpoch: "epoch_1", watermark: { seq } }),
    capturedInputs: () => [
      { id: "msg_user", type: "user" },
      reply("msg_reply", [
        edit("large.ts", `--- /dev/null\n+++ b/large.ts\n@@ -0,0 +1 @@\n+${hugeLine}`),
        edit("large.ts", "--- a/large.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old"),
        edit("invalid.ts", `@@ -1,2 +1,2 @@\n-${hugeLine}\n+new`),
        ...Array.from({ length: 129 }, (_, index) =>
          edit(`src/${index}.ts`, capturedPatch(`src/${index}.ts`).replace("+new", `+${visibleLine}`)),
        ),
        edit("src/0.ts", capturedPatch("src/0.ts")),
      ]),
    ],
  })
  await test.registry.refresh()
  const cache = createOperationCache()
  const first = valueOf(
    await test.run("session.capturedChanges.list", "ses_1", undefined, cache),
  ) as RemoteCapturedChangesPage
  expect(first.data[0]).toEqual({
    placementMessageID: "msg_reply",
    path: "large.ts",
    additions: 0,
    deletions: 0,
    status: "modified",
    files: [{ path: "large.ts", diff: "", additions: 0, deletions: 0, status: "modified", unavailable: true }],
  })
  expect(first.data.find((group) => group.path === "src/0.ts")).toMatchObject({ additions: 2, deletions: 2 })
  expect(first.data.find((group) => group.path === "src/0.ts")?.files).toHaveLength(2)
  expect(first.cursor).toBeDefined()
  const cursor = first.cursor?.next
  if (cursor === undefined) throw new Error("Captured changes must expose a next-page cursor")
  const retained = cache.capturedChanges.get("ses_1")!
  expect(retained.groups).toHaveLength(130)
  expect(retained.groups.some((group) => group.path === "invalid.ts")).toBe(false)
  expect(JSON.stringify(retained.groups).length).toBeLessThan(100_000)
  expect(retained.groups[0]).toEqual(first.data[0])
  hugeLine = "y".repeat(600_000)
  seq++
  expect(valueOf(await test.run("session.capturedChanges.list", "ses_1", { cursor }, cache))).toMatchObject({
    data: Array.from({ length: 30 }, (_, index) => ({ path: `src/${index + 99}.ts` })),
  })
  expect(cache.capturedChanges.get("ses_1")?.digest).toBe(retained.digest)
  visibleLine = "changed"
  seq++
  expect(errorOf(await test.run("session.capturedChanges.list", "ses_1", { cursor }, cache)).code).toBe(
    "invalid_message",
  )
})

test("captured changes load child inputs concurrently within a bound of four", async () => {
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
    capturedInputs: async (sessionID: string) => {
      reads++
      return [{ id: "msg_user", type: "user" }, reply(`msg_${sessionID}`, [capturedEdit(`src/${sessionID}.ts`)])]
    },
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
    const directories = async () =>
      (
        valueOf(await test.run("workspace.list", "ses_1", { sessionsOnly: true }, cache)) as {
          data: { directory: string }[]
        }
      ).data.map((item) => item.directory)

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
    const workspaces = valueOf(await test.run("workspace.list", "ses_1", { sessionsOnly: true }, cache)) as {
      data: { id: string }[]
    }
    const workspace = workspaces.data[0]?.id
    expect(workspace).toBeDefined()
    await rm(kept, { recursive: true, force: true })
    await symlink(temporary, kept)
    test.calls.length = 0
    expect(errorOf(await test.run("workspace.catalog", "ses_1", { workspace }, cache)).code).toBe("invalid_message")
    expect(errorOf(await test.run("session.create", "ses_1", { id: "ses_new", workspace }, cache)).code).toBe(
      "invalid_message",
    )
    expect(test.count("projectCurrent")).toBe(0)
    expect(test.count("createSession")).toBe(0)
    expect(test.count("listPage")).toBe(0)
  } finally {
    await rm(kept, { recursive: true, force: true })
    await rm(temporary, { recursive: true, force: true })
  }
})
