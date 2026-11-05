import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { BackendController } from "../src/backend-controller"
import type { ConnectionState } from "../src/contract"
import { pinRequest, projectSessionRecord, projectSessions, sessionsQuery, sessionTarget } from "../src/sessions"
import { env, launch, message, peer, revision, syntheticBundle } from "./synthetic-backend"

const hidden = "synthetic-hidden-value"
const sessionID = "ses_synthetic"
const pinPath = `/api/session/${sessionID}/pin`
const retry = "Refresh Sessions and try again."
const tooLong = "Use a Session search of at most 256 bytes."
const invalidList = "The backend returned an invalid Session list. Refresh to retry."
const unpaged = "The backend connection changed before more Sessions were read. Refresh Sessions."
const unknownPage = "Load more Sessions only from the current list. Refresh Sessions and try again."
const unpinned = "The backend connection changed before the pin was changed. Refresh Sessions and try again."
const unconfirmed = "The pin change was not confirmed. Refresh Sessions to see whether it changed."
const different = "The backend returned a different Session. Refresh and choose again."
const invalidSession = "The backend returned an invalid Session. Refresh to retry."

type Backend = { list: (query: URLSearchParams) => unknown; get: () => Promise<Response>; pin: () => Promise<Response> }
type Observed = { routes: string[]; lists: Record<string, string>[]; pins: string[] }
type Connection = { readonly pid?: () => number; readonly firstStreamEnds?: Promise<void>; readonly onState?: (state: ConnectionState) => void }

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: sessionID,
    parentID: "ses_parent",
    fork: { sessionID: "ses_parent", messageID: hidden },
    projectID: "prj_synthetic",
    scope: "bound",
    agent: "build",
    model: { id: "synthetic-model", providerID: "synthetic-provider", variant: "fast", profile: hidden },
    daybreak: [hidden],
    permissionCeiling: [{ action: "edit", effect: "allow", resource: hidden }],
    cost: 0.25,
    tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 }, total: 42 },
    time: { created: 1, updated: 2, active: 3, archived: 4, pinned: 5 },
    title: "Synthetic",
    location: { directory: "/synthetic/repo", workspaceID: hidden },
    subpath: hidden,
    revert: { messageID: hidden },
    origin: { type: hidden },
    ...overrides,
  }
}

function backend(): Backend {
  return {
    list: (query) => query.has("cursor")
      ? { data: [record({ id: "ses_older", time: { created: 1, updated: 1 } })], cursor: {} }
      : { data: [record()], cursor: { previous: "synthetic-previous", next: "synthetic-next" } },
    get: () => Promise.resolve(Response.json({ data: record() })),
    pin: () => Promise.resolve(new Response(null, { status: 204 })),
  }
}

async function connected(state: Backend, run: (controller: BackendController, observed: Observed, current: number) => Promise<void>, connection: Connection = {}) {
  const resources = await syntheticBundle()
  const observed: Observed = { routes: [], lists: [], pins: [] }
  using server = peer(observed.routes, connection.pid ?? (() => 101), async (route, request) => {
    if (route === "/api/session" && request.method === "GET") {
      const query = new URL(request.url).searchParams
      observed.lists.push(Object.fromEntries(query))
      return Response.json(await state.list(query))
    }
    if (route === `/api/session/${sessionID}` && request.method === "GET") return state.get()
    if (route !== pinPath) return undefined
    observed.pins.push(request.method)
    return state.pin()
  }, connection.firstStreamEnds)
  const controller = new BackendController(resources, { env, launch, onState: connection.onState })
  try {
    await run(controller, observed, revision(await controller.connect({ mode: "shared", server: server.url.href })))
  } finally {
    await controller.disconnect()
    await fs.rm(resources, { recursive: true, force: true })
  }
}

test("Session items keep only the rail's fields, including the pinned time", () => {
  const page = projectSessions({ data: [record()], cursor: { previous: "synthetic-previous", next: "synthetic-next" } }, 7)
  expect(page).toEqual({
    revision: 7,
    next: "synthetic-next",
    items: [{
      id: sessionID,
      parentID: "ses_parent",
      title: "Synthetic",
      location: { directory: "/synthetic/repo" },
      time: { updated: 2, active: 3, archived: 4, pinned: 5 },
      agent: "build",
      model: { id: "synthetic-model", providerID: "synthetic-provider" },
      tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
      cost: 0.25,
    }],
  })
  expect(Object.keys(page.items[0] ?? {})).toEqual(["id", "parentID", "title", "location", "time", "agent", "model", "tokens", "cost"])
  const serialized = JSON.stringify(page)
  for (const field of [hidden, "fork", "projectID", "scope", "daybreak", "permissionCeiling", "created", "workspaceID", "subpath", "revert", "origin", "variant", "profile", "total", "previous"])
    expect(serialized).not.toContain(field)
  const [minimal] = projectSessions({ data: [record({ parentID: undefined, agent: undefined, model: undefined, time: { created: 1, updated: 2, pinned: undefined } })] }, 7).items
  expect(Object.keys(minimal ?? {})).toEqual(["id", "title", "location", "time", "tokens", "cost"])
  expect(Object.keys(minimal?.time ?? {})).toEqual(["updated"])
  expect(Object.keys(projectSessions({ data: [], cursor: { next: null } }, 7))).toEqual(["revision", "items"])
})

test("malformed backend Session entries are dropped whole, and a malformed list or cursor is refused", () => {
  const malformed = [
    record({ id: { value: hidden } }),
    record({ id: "not-a-session" }),
    record({ parentID: { value: hidden } }),
    record({ title: { value: hidden } }),
    record({ location: { directory: 1 } }),
    record({ location: null }),
    record({ time: { updated: -1 } }),
    record({ time: { updated: "2" } }),
    record({ time: { updated: 2, pinned: "5" } }),
    record({ time: { updated: 2, archived: Number.NaN } }),
    record({ agent: { value: hidden } }),
    record({ model: { id: { value: hidden }, providerID: "synthetic-provider" } }),
    record({ model: { id: "x".repeat(1025), providerID: "synthetic-provider" } }),
    record({ model: null }),
    record({ tokens: { input: 1, output: 1, reasoning: 1 } }),
    record({ cost: "0.25" }),
    null,
    sessionID,
  ]
  const page = projectSessions({ data: [...malformed, record({ id: "ses_kept" })], cursor: {} }, 3)
  expect(page.items.map((item) => item.id)).toEqual(["ses_kept"])
  expect(JSON.stringify(page)).not.toContain(hidden)
  for (const value of [undefined, null, [], { data: {} }, { data: [], cursor: { next: 4 } }, { data: [], cursor: { next: "" } }, { data: [], cursor: { next: "x".repeat(4097) } }])
    expect(() => projectSessions(value, 3)).toThrow(invalidList)
  expect(projectSessions({ data: [], cursor: { next: "x".repeat(4096) } }, 3).next?.length).toBe(4096)
})

test("a Session list query is empty, a trimmed search of at most 256 bytes, or a cursor with its revision", () => {
  expect(sessionsQuery({})).toEqual({})
  expect(sessionsQuery({ search: "  synthetic  " })).toEqual({ search: "synthetic" })
  expect(sessionsQuery({ search: " \n " })).toEqual({})
  const search = "é".repeat(128)
  expect(new TextEncoder().encode(search).length).toBe(256)
  expect(sessionsQuery({ search })).toEqual({ search })
  for (const value of [`${search}é`, "x".repeat(257), `synthetic${" ".repeat(250)}`, 4, null]) expect(() => sessionsQuery({ search: value })).toThrow(tooLong)
  const cursor = "c".repeat(4096)
  expect(sessionsQuery({ revision: 3, cursor })).toEqual({ revision: 3, cursor })
  for (const value of [
    null,
    [],
    "synthetic",
    { revision: 3 },
    { cursor },
    { revision: 3, cursor: "" },
    { revision: 3, cursor: `${cursor}c` },
    { revision: 3, cursor: 4 },
    { revision: -1, cursor },
    { revision: 1.5, cursor },
    { revision: "3", cursor },
    { search: "synthetic", revision: 3, cursor },
    { limit: 200 },
    { background: "exclude" },
    JSON.parse('{"__proto__":{"search":"synthetic"}}'),
  ]) expect(() => sessionsQuery(value)).toThrow(retry)
})

test("a single Session record is projected like a rail item, and a different or malformed record is refused", () => {
  const item = projectSessionRecord(sessionID, record())
  expect(projectSessions({ data: [record()] }, 1).items).toEqual([item])
  expect(Object.keys(item)).toEqual(["id", "parentID", "title", "location", "time", "agent", "model", "tokens", "cost"])
  expect(item.time.pinned).toBe(5)
  expect(JSON.stringify(item)).not.toContain(hidden)
  for (const value of [record({ id: "ses_other" }), record({ id: { value: hidden } }), null, undefined, sessionID])
    expect(() => projectSessionRecord(sessionID, value)).toThrow(different)
  for (const value of [record({ title: { value: hidden } }), record({ cost: "0.25" }), record({ time: { updated: -1 } }), record({ tokens: {} }),
    record({ model: { id: { value: hidden }, providerID: "synthetic-provider" } }), record({ parentID: "not-a-session" })])
    expect(() => projectSessionRecord(sessionID, value)).toThrow(invalidSession)
})

test("a single Session read names exactly one Session ID", () => {
  expect(sessionTarget({ sessionID })).toBe(sessionID)
  for (const value of [null, sessionID, [], {}, { sessionID: "other" }, { sessionID, directory: "/synthetic/repo" }, JSON.parse('{"__proto__":{},"sessionID":"ses_synthetic"}')])
    expect(() => sessionTarget(value)).toThrow("Choose a Session.")
})

test("a pin change names exactly the Session, the connection revision and the pinned state", () => {
  expect(pinRequest({ sessionID, revision: 3, pinned: true })).toEqual({ sessionID, revision: 3, pinned: true })
  expect(pinRequest({ sessionID, revision: 0, pinned: false })).toEqual({ sessionID, revision: 0, pinned: false })
  for (const value of [null, { sessionID, revision: 3 }, { sessionID, revision: 3, pinned: "true" }, { sessionID, pinned: true }, { sessionID, revision: -1, pinned: true },
    { sessionID, revision: 3, pinned: true, title: "synthetic" }]) expect(() => pinRequest(value)).toThrow(retry)
  expect(() => pinRequest({ sessionID: "other", revision: 3, pinned: true })).toThrow("Choose a Session.")
})

test("Session list and pin requests validate first and then require a connected backend", async () => {
  const controller = new BackendController("/nonexistent-desktop-resources")
  expect(await message(controller.sessions({ limit: 200 }))).toBe(retry)
  expect(await message(controller.pin({ sessionID, revision: 1, pinned: "yes" }))).toBe(retry)
  expect(await message(controller.session({ sessionID, directory: "/synthetic/repo" }))).toBe("Choose a Session.")
  for (const pending of [controller.sessions({}), controller.sessions({ revision: 1, cursor: "synthetic-next" }), controller.session({ sessionID }), controller.pin({ sessionID, revision: 1, pinned: true })])
    expect(await message(pending)).toBe("Connect to a backend before using Sessions.")
})

test("pages read 40 Sessions with only the trimmed search and the backend's default background setting", async () => {
  await connected(backend(), async (controller, observed, current) => {
    const page = await controller.sessions({})
    expect(page).toMatchObject({ revision: current, next: "synthetic-next" })
    expect(page.items.map((item) => item.id)).toEqual([sessionID])
    expect(JSON.stringify(page)).not.toContain(hidden)
    await controller.sessions({ search: "  synthetic  " })
    await controller.sessions({ search: "   " })
    const search = "é".repeat(128)
    await controller.sessions({ search })
    expect(observed.lists).toEqual([{ limit: "40" }, { limit: "40", search: "synthetic" }, { limit: "40" }, { limit: "40", search }])
    expect(await message(controller.sessions({ search: `${search}é` }))).toBe(tooLong)
    expect(observed.lists).toHaveLength(4)
  })
}, 30_000)

test("a cursor is accepted only with the revision it was issued under, and an unissued cursor sends no request", async () => {
  await connected(backend(), async (controller, observed, current) => {
    const first = await controller.sessions({})
    const more = await controller.sessions({ revision: first.revision, cursor: "synthetic-next" })
    expect(more.items.map((item) => item.id)).toEqual(["ses_older"])
    expect(Object.keys(more)).toEqual(["revision", "items"])
    expect(observed.lists.at(-1)).toEqual({ limit: "40", cursor: "synthetic-next" })
    const reads = observed.lists.length
    expect(await message(controller.sessions({ revision: current + 1, cursor: "synthetic-next" }))).toBe(unpaged)
    expect(await message(controller.sessions({ revision: current, cursor: "synthetic-forged" }))).toBe(unknownPage)
    expect(observed.lists).toHaveLength(reads)
  })
}, 30_000)

test("re-reading the first page under the same revision keeps an earlier page-2 cursor accepted", async () => {
  const state: Backend = {
    ...backend(),
    list: (query) => {
      const cursor = query.get("cursor")
      return { data: [], cursor: cursor === null ? { next: "c1" } : cursor === "c1" ? { next: "c2" } : {} }
    },
  }
  await connected(state, async (controller, observed, current) => {
    expect((await controller.sessions({})).next).toBe("c1")
    expect((await controller.sessions({ revision: current, cursor: "c1" })).next).toBe("c2")
    expect((await controller.sessions({})).next).toBe("c1")
    expect(await controller.sessions({ revision: current, cursor: "c2" })).toEqual({ revision: current, items: [] })
    expect(observed.lists.at(-1)).toEqual({ limit: "40", cursor: "c2" })
  })
}, 30_000)

test("cursorless reads with another search or none keep the rail's cursors accepted", async () => {
  const state: Backend = {
    ...backend(),
    list: (query) => {
      const cursor = query.get("cursor")
      return { data: [], cursor: { next: cursor === null ? `first:${query.get("search") ?? ""}` : `${cursor}/2` } }
    },
  }
  await connected(state, async (controller, observed, current) => {
    expect((await controller.sessions({ search: "rail" })).next).toBe("first:rail")
    expect((await controller.sessions({ revision: current, cursor: "first:rail" })).next).toBe("first:rail/2")
    expect((await controller.sessions({})).next).toBe("first:")
    expect((await controller.sessions({ search: "other" })).next).toBe("first:other")
    expect((await controller.sessions({ revision: current, cursor: "first:rail/2" })).next).toBe("first:rail/2/2")
    expect(observed.lists.at(-1)).toEqual({ limit: "40", cursor: "first:rail/2" })
    for (const cursor of ["first:", "first:other"]) expect((await controller.sessions({ revision: current, cursor })).revision).toBe(current)
  })
}, 30_000)

test("a revision change clears the issued cursors", async () => {
  let pid = 101
  const endFirstStream = Promise.withResolvers<void>()
  const reconnected = Promise.withResolvers<ConnectionState>()
  try {
    await connected(backend(), async (controller, observed, current) => {
      expect((await controller.sessions({})).next).toBe("synthetic-next")
      pid = 202
      endFirstStream.resolve()
      const next = revision(await reconnected.promise)
      expect(next).toBeGreaterThan(current)
      const reads = observed.lists.length
      expect(await message(controller.sessions({ revision: next, cursor: "synthetic-next" }))).toBe(unknownPage)
      expect(await message(controller.sessions({ revision: current, cursor: "synthetic-next" }))).toBe(unpaged)
      expect(observed.lists).toHaveLength(reads)
    }, { pid: () => pid, firstStreamEnds: endFirstStream.promise, onState: (state) => { if (state.status === "connected" && state.backendPID === 202) reconnected.resolve(state) } })
  } finally {
    endFirstStream.resolve()
  }
}, 30_000)

test("a page that settles after a revision change does not add its cursor", async () => {
  let pid = 101
  const listing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const endFirstStream = Promise.withResolvers<void>()
  const reconnected = Promise.withResolvers<ConnectionState>()
  const state: Backend = {
    ...backend(),
    list: async () => {
      listing.resolve()
      await release.promise
      return { data: [], cursor: { next: "late-next" } }
    },
  }
  try {
    await connected(state, async (controller, observed) => {
      const late = message(controller.sessions({}))
      await listing.promise
      pid = 202
      endFirstStream.resolve()
      const next = revision(await reconnected.promise)
      release.resolve()
      expect(await late).toBe("The backend connection changed.")
      const reads = observed.lists.length
      expect(await message(controller.sessions({ revision: next, cursor: "late-next" }))).toBe(unknownPage)
      expect(observed.lists).toHaveLength(reads)
    }, { pid: () => pid, firstStreamEnds: endFirstStream.promise, onState: (state) => { if (state.status === "connected" && state.backendPID === 202) reconnected.resolve(state) } })
  } finally {
    release.resolve()
    endFirstStream.resolve()
  }
}, 30_000)

function numbered(): Backend {
  return {
    ...backend(),
    list: (query) => {
      const cursor = query.get("cursor")
      return { data: [], cursor: { next: cursor === null ? "page-0" : `page-${Number(cursor.slice(5)) + 1}` } }
    },
  }
}

test("issued cursors are deduplicated and only the 64 newest are kept", async () => {
  await connected(numbered(), async (controller, observed, current) => {
    expect((await controller.sessions({})).next).toBe("page-0")
    for (let page = 0; page <= 64; page++)
      expect((await controller.sessions({ revision: current, cursor: `page-${page}` })).next).toBe(`page-${page + 1}`)
    expect((await controller.sessions({ revision: current, cursor: "page-63" })).next).toBe("page-64")
    const reads = observed.lists.length
    for (const cursor of ["page-0", "page-1"]) expect(await message(controller.sessions({ revision: current, cursor }))).toBe(unknownPage)
    expect(observed.lists).toHaveLength(reads)
    expect((await controller.sessions({ revision: current, cursor: "page-2" })).next).toBe("page-3")
    expect((await controller.sessions({ revision: current, cursor: "page-65" })).next).toBe("page-66")
    expect(await message(controller.sessions({ revision: current, cursor: "page-2" }))).toBe(unknownPage)
  })
}, 30_000)

test("a cursor returned again becomes the newest and survives the next eviction", async () => {
  await connected(numbered(), async (controller, observed, current) => {
    expect((await controller.sessions({})).next).toBe("page-0")
    for (let page = 0; page <= 62; page++)
      expect((await controller.sessions({ revision: current, cursor: `page-${page}` })).next).toBe(`page-${page + 1}`)
    expect((await controller.sessions({})).next).toBe("page-0")
    expect((await controller.sessions({ revision: current, cursor: "page-63" })).next).toBe("page-64")
    const reads = observed.lists.length
    expect(await message(controller.sessions({ revision: current, cursor: "page-1" }))).toBe(unknownPage)
    expect(observed.lists).toHaveLength(reads)
    expect((await controller.sessions({ revision: current, cursor: "page-0" })).next).toBe("page-1")
  })
}, 30_000)

test("a cursor from another backend is refused before any request", async () => {
  const resources = await syntheticBundle()
  const firstLists: string[] = []
  const secondLists: string[] = []
  const listing = (seen: string[]) => (route: string, request: Request) => {
    if (route !== "/api/session") return undefined
    const query = new URL(request.url)
    seen.push(query.search)
    return Promise.resolve(Response.json(backend().list(query.searchParams)))
  }
  using a = peer([], () => 101, listing(firstLists))
  using b = peer([], () => 202, listing(secondLists))
  const controller = new BackendController(resources, { env, launch })
  try {
    const old = revision(await controller.connect({ mode: "shared", server: a.url.href }))
    expect((await controller.sessions({})).next).toBe("synthetic-next")
    const current = revision(await controller.connect({ mode: "shared", server: b.url.href }))
    expect(await message(controller.sessions({ revision: old, cursor: "synthetic-next" }))).toBe(unpaged)
    expect(await message(controller.sessions({ revision: current, cursor: "synthetic-next" }))).toBe(unknownPage)
    expect([firstLists, secondLists]).toEqual([["?limit=40"], []])
  } finally {
    await controller.disconnect()
    await fs.rm(resources, { recursive: true, force: true })
  }
}, 30_000)

test("a single Session is read with session.get under the current revision and refused when the backend returns another or a malformed record", async () => {
  let served: unknown = record()
  await connected({ ...backend(), get: () => Promise.resolve(Response.json({ data: served })) }, async (controller, observed, current) => {
    const read = await controller.session({ sessionID })
    expect(Object.keys(read)).toEqual(["revision", "item"])
    expect(read).toEqual({ revision: current, item: projectSessionRecord(sessionID, record()) })
    expect(JSON.stringify(read)).not.toContain(hidden)
    served = record({ id: "ses_other" })
    expect(await message(controller.session({ sessionID }))).toBe(different)
    served = record({ title: { value: hidden } })
    expect(await message(controller.session({ sessionID }))).toBe(invalidSession)
    expect(observed.routes.filter((route) => route === `GET /api/session/${sessionID}`)).toHaveLength(3)
  })
}, 30_000)

test("a single Session read that settles after a connection change is refused", async () => {
  let pid = 101
  const reading = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const endFirstStream = Promise.withResolvers<void>()
  const reconnected = Promise.withResolvers<void>()
  const state: Backend = {
    ...backend(),
    get: async () => {
      reading.resolve()
      await release.promise
      return Response.json({ data: record() })
    },
  }
  try {
    await connected(state, async (controller) => {
      const inFlight = message(controller.session({ sessionID }))
      await reading.promise
      pid = 202
      endFirstStream.resolve()
      await reconnected.promise
      release.resolve()
      expect(await inFlight).toBe("The backend connection changed while the Session was read. Refresh to retry.")
    }, { pid: () => pid, firstStreamEnds: endFirstStream.promise, onState: (next) => { if (next.status === "connected" && next.backendPID === 202) reconnected.resolve() } })
  } finally {
    release.resolve()
    endFirstStream.resolve()
  }
}, 30_000)

test("pinning and unpinning send one request each, and a revision from an earlier connection sends nothing", async () => {
  await connected(backend(), async (controller, observed, current) => {
    expect(await controller.pin({ sessionID, revision: current, pinned: true })).toBeNull()
    expect(await controller.pin({ sessionID, revision: current, pinned: false })).toBeNull()
    expect(await message(controller.pin({ sessionID, revision: current + 1, pinned: true }))).toBe(unpinned)
    expect(observed.pins).toEqual(["POST", "DELETE"])
  })
}, 30_000)

test("a failed pin change is reported as not confirmed and is not retried", async () => {
  const statuses = [404, 500]
  await connected({ ...backend(), pin: () => Promise.resolve(new Response(null, { status: statuses.shift() ?? 500 })) }, async (controller, observed, current) => {
    expect(await message(controller.pin({ sessionID, revision: current, pinned: true }))).toBe(unconfirmed)
    expect(await message(controller.pin({ sessionID, revision: current, pinned: false }))).toBe(unconfirmed)
    expect(observed.pins).toEqual(["POST", "DELETE"])
  })
}, 30_000)

test("a pin change in flight when the connection changes is reported as not confirmed and is not sent again", async () => {
  let pid = 101
  const pinning = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const endFirstStream = Promise.withResolvers<void>()
  const reconnected = Promise.withResolvers<void>()
  const state: Backend = {
    ...backend(),
    pin: async () => {
      pinning.resolve()
      await release.promise
      return new Response(null, { status: 204 })
    },
  }
  try {
    await connected(state, async (controller, observed, current) => {
      const inFlight = message(controller.pin({ sessionID, revision: current, pinned: true }))
      await pinning.promise
      pid = 202
      endFirstStream.resolve()
      await reconnected.promise
      release.resolve()
      expect(await inFlight).toBe("The pin change was not confirmed before the connection changed. Refresh Sessions to see whether it changed.")
      expect(await message(controller.pin({ sessionID, revision: current, pinned: true }))).toBe(unpinned)
      expect(observed.pins).toEqual(["POST"])
    }, { pid: () => pid, firstStreamEnds: endFirstStream.promise, onState: (next) => { if (next.status === "connected" && next.backendPID === 202) reconnected.resolve() } })
  } finally {
    release.resolve()
    endFirstStream.resolve()
  }
}, 30_000)
