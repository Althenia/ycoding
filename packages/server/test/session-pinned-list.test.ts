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

type Row = { readonly id: string; readonly time: { readonly pinned?: number } }
type Page = { readonly data: readonly Row[]; readonly cursor: { readonly next?: string; readonly previous?: string } }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-session-pinned-"))
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
  const get = (path: string, query: Record<string, string> = {}) =>
    runtime.handler(new Request(`http://localhost${path}?${new URLSearchParams(query)}`))
  const page = async (query: Record<string, string>) => {
    const response = await get("/api/session", query)
    expect(response.status).toBe(200)
    return (await response.json()) as Page
  }
  const created: string[] = []
  for (const title of ["first", "second", "third", "fourth", "fifth"]) {
    const session = await Effect.runPromise(sessions.create({
      title, model: CatalogModel.Ref.parse("synthetic/model"), location: { directory: AbsolutePath.make(directory) },
    }))
    created.push(session.id)
  }
  const pinned = [created[0]!, created[2]!, created[3]!]
  for (const id of pinned) await Effect.runPromise(sessions.pin(Session.ID.make(id)))
  return {
    get, page, created, pinned, directory,
    async [Symbol.asyncDispose]() {
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

const ids = (rows: readonly Row[]) => rows.map((row) => row.id)

async function walk(f: Awaited<ReturnType<typeof fixture>>, query: Record<string, string>) {
  const pages: Page[] = [await f.page({ ...query, limit: "1" })]
  while (pages.at(-1)!.cursor.next !== undefined && pages.length < 8) {
    const next = await f.page({ cursor: pages.at(-1)!.cursor.next! })
    if (next.data.length === 0) break
    pages.push(next)
  }
  return pages
}

test("session.list pinned=true and pinned=false partition the absent-filter order", async () => {
  await using f = await fixture()
  const all = ids((await f.page({})).data)
  expect(all.toSorted()).toEqual(f.created.toSorted())
  const pinned = await f.page({ pinned: "true" })
  expect(ids(pinned.data)).toEqual(all.filter((id) => f.pinned.includes(id)))
  expect(pinned.data.every((row) => typeof row.time.pinned === "number")).toBe(true)
  const unpinned = await f.page({ pinned: "false" })
  expect(ids(unpinned.data)).toEqual(all.filter((id) => !f.pinned.includes(id)))
  expect(unpinned.data.every((row) => row.time.pinned === undefined)).toBe(true)
  expect(ids((await f.page({ pinned: "true", order: "asc" })).data)).toEqual(ids(pinned.data).toReversed())
}, 30_000)

test("the pinned filter applies before limits and persists through next and previous cursors", async () => {
  await using f = await fixture()
  const all = ids((await f.page({})).data)
  for (const [value, expected] of [["true", all.filter((id) => f.pinned.includes(id))], ["false", all.filter((id) => !f.pinned.includes(id))]] as const) {
    const pages = await walk(f, { pinned: value })
    expect(pages.flatMap((page) => ids(page.data))).toEqual(expected)
    const last = pages.at(-1)!
    const back = await f.page({ cursor: last.cursor.previous! })
    expect(ids(back.data)).toEqual(ids(pages.at(-2)!.data))
  }
}, 30_000)

test("a cursor owns the pinned filter over a conflicting query parameter", async () => {
  await using f = await fixture()
  const first = await f.page({ pinned: "true", limit: "1" })
  const followed = await f.page({ cursor: first.cursor.next!, pinned: "false" })
  expect(followed.data.length).toBeGreaterThan(0)
  expect(followed.data.every((row) => f.pinned.includes(row.id))).toBe(true)
  const unfiltered = await f.page({ limit: "1" })
  const followedUnfiltered = await f.page({ cursor: unfiltered.cursor.next!, pinned: "true" })
  expect(ids(followedUnfiltered.data)).toEqual(ids((await f.page({})).data).slice(1))
}, 30_000)

test("session.list rejects a non-boolean pinned value", async () => {
  await using f = await fixture()
  for (const pinned of ["yes", "1", ""]) expect((await f.get("/api/session", { pinned })).status).toBe(400)
}, 30_000)

test("session.outstanding reports an additive waiting list", async () => {
  await using f = await fixture()
  const response = await f.get("/api/session/outstanding")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ data: [], running: [], failed: [], lost: [], waiting: [] })
}, 30_000)
