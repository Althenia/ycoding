import { join } from "node:path"
import { expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import { requireSession, type RemoteRequest } from "@ycoding-ai/remote"
import type { LocalServer } from "../src/remote-local"
import {
  createSubscriptions,
  createSessionRegistry,
  executeRemoteOperation,
  listPage,
  parseListQuery,
} from "../src/remote-operations"

const info = (id: string, updated: number, origin?: "dots-executor", title = id): SessionInfo => ({
  id,
  projectID: "prj_1",
  model: { providerID: "test", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: updated, updated },
  title,
  location: { directory: "/work" },
  ...(origin === undefined ? {} : { origin }),
}) as unknown as SessionInfo

const background = [info("ses_b4", 40, "dots-executor", "Dots · unattributed"), info("ses_b3", 30, "dots-executor"), info("ses_b2", 20, "dots-executor")]
const ordinary = [info("ses_o2", 10, undefined, "Dots · unattributed"), info("ses_o1", 5)]
const all = [...background, ...ordinary]
const ids = (page: { readonly data: readonly SessionInfo[] }) => page.data.map((session) => session.id)

test("the list query accepts include and exclude and rejects anything else", () => {
  expect(parseListQuery({}).background).toBeUndefined()
  expect(parseListQuery({ background: "include" }).background).toBe("include")
  expect(parseListQuery({ background: "exclude" }).background).toBe("exclude")
  expect(() => parseListQuery({ background: "hidden" })).toThrow()
})

test("listPage includes background Sessions by default and excludes them before the page limit", () => {
  expect(ids(listPage(all, parseListQuery({ limit: 10 })))).toEqual(["ses_b4", "ses_b3", "ses_b2", "ses_o2", "ses_o1"])
  const excluded = listPage(all, parseListQuery({ limit: 1, background: "exclude" }))
  expect(ids(excluded)).toEqual(["ses_o2"])
  expect(excluded.cursor.next).toBeDefined()
  const next = listPage(all, parseListQuery({ limit: 1, background: "exclude", cursor: excluded.cursor.next }))
  expect(ids(next)).toEqual(["ses_o1"])
  expect(next.cursor.next).toBeUndefined()
  expect(ids(listPage(all, parseListQuery({ limit: 1, background: "exclude", cursor: next.cursor.previous })))).toEqual(["ses_o2"])
})

test("excluded rows never starve search, pinned, active or window pages", () => {
  expect(ids(listPage(all, parseListQuery({ limit: 5, search: "Dots", background: "exclude" })))).toEqual(["ses_o2"])
  expect(ids(listPage(all, parseListQuery({ limit: 5, search: "Dots" })))).toEqual(["ses_b4", "ses_o2"])
  expect(ids(listPage(all, parseListQuery({ limit: 1, order: "pinned", background: "exclude" })))).toEqual(["ses_o2"])
  const active = listPage(all, parseListQuery({ limit: 1, order: "active", background: "exclude" }))
  expect(ids(active)).toEqual(["ses_o2"])
  const second = listPage(all, parseListQuery({ limit: 1, order: "active", background: "exclude", cursor: active.cursor.next }))
  expect(ids(second)).toEqual(["ses_o1"])
  expect(ids(listPage(all, parseListQuery({ limit: 5, order: "active", background: "exclude", around: "ses_o1", before: 1 })))).toEqual(["ses_o2", "ses_o1"])
})

test("the active cursor epoch is computed from the filtered rows", () => {
  const first = listPage(all, parseListQuery({ limit: 1, order: "active", background: "exclude" }))
  const changedBackground = listPage([...all, info("ses_b9", 90, "dots-executor")], parseListQuery({ limit: 1, order: "active", background: "exclude", cursor: first.cursor.next }))
  expect(ids(changedBackground)).toEqual(["ses_o1"])
  expect(changedBackground).not.toHaveProperty("stale")
})

test("the remote operation accepts background and the registry inventory stays unfiltered", async () => {
  const requested: unknown[] = []
  const local = new Proxy({}, {
    get: (_target, property) => {
      if (property === "listPage") return (input: unknown) => { requested.push(input); return Promise.resolve({ data: all }) }
      return () => Promise.reject(new Error(`unexpected ${String(property)}`))
    },
  }) as LocalServer
  const registry = createSessionRegistry({ local })
  await registry.refresh()
  expect(requested).toEqual([{ limit: expect.any(Number) }])
  expect(registry.snapshot().map((session) => session.id)).toEqual(all.map((session) => session.id))
  const run = async (input: Record<string, unknown>) => {
    const operation = "session.list" as const
    const request: RemoteRequest = { type: "request", id: "req_1", operation, ...(requireSession(operation) ? { sessionID: "ses_1" } : {}), input }
    const frames = await executeRemoteOperation({ request, local, sessions: registry, subscriptions: createSubscriptions() })
    return frames as readonly { ok: boolean; value?: { data: readonly { id: string }[] } }[]
  }
  const excluded = await run({ limit: 10, background: "exclude" })
  expect(excluded[0]?.ok).toBe(true)
  expect(excluded[0]?.value?.data.map((session) => session.id)).toEqual(["ses_o2", "ses_o1"])
  const included = await run({ limit: 10 })
  expect(included[0]?.value?.data.map((session) => session.id)).toEqual(all.map((session) => session.id))
  expect(registry.snapshot()).toHaveLength(all.length)
})

test("sidebar workspace groups come only from visible Sessions", async () => {
  const visible = process.cwd()
  const hidden = join(process.cwd(), "src")
  const at = (session: SessionInfo, directory: string) => ({ ...session, location: { directory } }) as SessionInfo
  const inventory = [at(info("ses_visible", 2), visible), at(info("ses_hidden", 3, "dots-executor"), hidden)]
  const local = new Proxy({}, {
    get: (_target, property) => {
      if (property === "listPage") return () => Promise.resolve({ data: inventory })
      if (property === "projectList") return () => Promise.resolve([])
      return () => Promise.reject(new Error(`unexpected ${String(property)}`))
    },
  }) as LocalServer
  const registry = createSessionRegistry({ local })
  await registry.refresh()
  const request: RemoteRequest = { type: "request", id: "req_1", operation: "workspace.list", input: { sessionsOnly: true } }
  const frames = await executeRemoteOperation({ request, local, sessions: registry, subscriptions: createSubscriptions() })
  const value = (frames[0] as { ok: boolean; value?: { data: readonly { directory: string }[] } }).value
  expect(value?.data.map((workspace) => workspace.directory)).toEqual([visible])
})
