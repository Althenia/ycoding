import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { CatalogModel } from "@ycoding-ai/core/model"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { createRoutes } from "../src/routes"

type Row = { readonly id: string; readonly title: string; readonly origin?: string }
type Page = { readonly data: readonly Row[]; readonly cursor: { readonly next?: string; readonly previous?: string } }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-session-background-"))
  const state: { sessions?: Session.Interface } = {}
  const runtime = HttpRouter.toWebHandler(createRoutes({
    database: { path: join(directory, "session.db") },
    config: { directory: join(directory, "config"), project: false },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
  }).pipe(
    Layer.provide(HttpServer.layerServices),
    Layer.tap((context) => Effect.sync(() => { state.sessions = Context.get(context, Session.Service) })),
  ))
  await runtime.handler(new Request("http://localhost/api/health"))
  if (!state.sessions) throw new Error("Fixture Session service was not initialized")
  const sessions = state.sessions
  const create = (title: string, origin?: "dots-executor") => Effect.runPromise(sessions.create({
    title,
    ...(origin === undefined ? {} : { origin }),
    model: CatalogModel.Ref.parse("synthetic/model"),
    location: { directory: AbsolutePath.make(directory) },
  }))
  const get = (path: string, query: Record<string, string> = {}) =>
    runtime.handler(new Request(`http://localhost${path}?${new URLSearchParams(query)}`))
  const post = (path: string, payload: unknown) =>
    runtime.handler(new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }))
  const page = async (query: Record<string, string>) => {
    const response = await get("/api/session", query)
    expect(response.status).toBe(200)
    return (await response.json()) as Page
  }
  return {
    sessions,
    create,
    get,
    post,
    page,
    directory: AbsolutePath.make(directory),
    async [Symbol.asyncDispose]() {
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

const ids = (rows: readonly Row[]) => rows.map((row) => row.id)

test("session.list includes background Sessions by default and reports their origin", async () => {
  await using f = await fixture()
  const background = await f.create("Dots · unattributed", "dots-executor")
  const ordinary = await f.create("Dots · unattributed")
  const queries: readonly Record<string, string>[] = [{}, { background: "include" }]
  for (const query of queries) {
    const result = await f.page(query)
    expect(ids(result.data).sort()).toEqual([background.id, ordinary.id].sort())
    expect(result.data.find((row) => row.id === background.id)?.origin).toBe("dots-executor")
    expect(Object.keys(result.data.find((row) => row.id === ordinary.id)!)).not.toContain("origin")
  }
}, 30_000)

test("session.list background=exclude hides only origin-marked Sessions whatever their title", async () => {
  await using f = await fixture()
  const background = await f.create("Plain looking title", "dots-executor")
  const lookalike = await f.create("Dots · unattributed")
  const ordinary = await f.create("Ordinary")
  await Effect.runPromise(f.sessions.rename({ sessionID: background.id, title: "Renamed arbitrarily" }))
  const result = await f.page({ background: "exclude" })
  expect(ids(result.data).sort()).toEqual([lookalike.id, ordinary.id].sort())
  expect((await f.page({ background: "exclude", search: "Renamed" })).data).toEqual([])
  expect(ids((await f.page({ background: "exclude", search: "Dots" })).data)).toEqual([lookalike.id])
}, 30_000)

test("background=exclude filters before the page limit and survives next and previous cursors", async () => {
  await using f = await fixture()
  const ordinary = [await f.create("first ordinary"), await f.create("second ordinary")]
  for (const title of ["a", "b", "c", "d"]) await f.create(title, "dots-executor")
  const first = await f.page({ background: "exclude", limit: "1", order: "desc" })
  expect(first.data).toHaveLength(1)
  const second = await f.page({ cursor: first.cursor.next! })
  expect(second.data).toHaveLength(1)
  expect([first.data[0]!.id, second.data[0]!.id].sort()).toEqual(ordinary.map((item) => item.id).sort())
  expect(second.data.every((row) => row.origin === undefined)).toBe(true)
  expect(ids((await f.page({ cursor: second.cursor.previous! })).data)).toEqual(ids(first.data))
}, 30_000)

for (const scope of ["directory", "project"] as const)
  test(`background=exclude with limit 1 persists through ${scope}-scoped cursors followed without the original query`, async () => {
    await using f = await fixture()
    const ordinary = [await f.create("first ordinary"), await f.create("second ordinary")]
    for (const title of ["a", "b", "c"]) await f.create(title, "dots-executor")
    const scoped: Record<string, string> = scope === "directory"
      ? { directory: f.directory }
      : { project: ordinary[0]!.projectID }
    const seen: string[] = []
    let result = await f.page({ ...scoped, background: "exclude", limit: "1", order: "desc" })
    for (let pages = 0; pages < 4; pages++) {
      expect(result.data.every((row) => row.origin === undefined)).toBe(true)
      seen.push(...ids(result.data))
      if (result.cursor.next === undefined) break
      const cursor = result.cursor.next
      result = await f.page({ cursor })
      if (result.data.length === 0) break
    }
    expect(seen.sort()).toEqual(ordinary.map((item) => item.id).sort())
  }, 30_000)

test("a cursor owns the background mode over a conflicting query parameter in both directions", async () => {
  await using f = await fixture()
  for (const title of ["first ordinary", "second ordinary"]) await f.create(title)
  for (const title of ["a", "b", "c"]) await f.create(title, "dots-executor")
  const excluded = await f.page({ background: "exclude", limit: "1" })
  const followedExcluded = await f.page({ cursor: excluded.cursor.next!, background: "include" })
  expect(followedExcluded.data.length).toBeGreaterThan(0)
  expect(followedExcluded.data.every((row) => row.origin === undefined)).toBe(true)
  const included = await f.page({ limit: "1" })
  const followedIncluded = await f.page({ cursor: included.cursor.next!, background: "exclude" })
  expect([...included.data, ...followedIncluded.data].some((row) => row.origin === "dots-executor")).toBe(true)
  expect(followedIncluded.data.some((row) => row.origin === "dots-executor")).toBe(true)
}, 30_000)

test("session.list rejects an unknown background mode", async () => {
  await using f = await fixture()
  expect((await f.get("/api/session", { background: "hidden" })).status).toBe(400)
}, 30_000)

test("a background Session stays addressable and the public create route cannot mark one", async () => {
  await using f = await fixture()
  const background = await f.create("Executor", "dots-executor")
  const direct = await f.get(`/api/session/${background.id}`)
  expect(direct.status).toBe(200)
  expect((await direct.json()).data.origin).toBe("dots-executor")
  const snapshot = await f.get(`/api/session/${background.id}/snapshot`)
  expect(snapshot.status).toBe(200)
  expect(await snapshot.json()).toMatchObject({ session: { id: background.id, origin: "dots-executor" }, messages: [] })
  const response = await f.post("/api/session", {
    title: "Caller supplied",
    origin: "dots-executor",
    model: { providerID: "synthetic", id: "model" },
    location: { directory: f.directory },
  })
  expect(response.status).toBe(200)
  const posted = (await response.json()).data as Row
  expect(posted.origin).toBeUndefined()
  expect(ids((await f.page({ background: "exclude" })).data)).toEqual([posted.id])
}, 30_000)
