import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, DateTime, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { CatalogModel } from "@ycoding-ai/core/model"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { createRoutes } from "../src/routes"

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-session-search-"))
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
  return {
    sessions,
    create: (title: string) => Effect.runPromise(sessions.create({
      title,
      model: CatalogModel.Ref.parse("synthetic/model"),
      location: { directory: AbsolutePath.make(directory) },
    })),
    request: (query: Record<string, string>) => runtime.handler(new Request(`http://localhost/api/session?${new URLSearchParams(query)}`)),
    async [Symbol.asyncDispose]() {
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

for (const [name, marks, title] of [
  ["apostrophes", ["'", "’", "‘", "‛", "′"], (mark: string) => `Inspect sample${mark}s connection`],
  ["double quotes", ['"', "“", "”", "″"], (mark: string) => `Inspect ${mark}sample${mark} connection`],
  ["dashes", ["-", "–", "—"], (mark: string) => `Inspect sample${mark}connection`],
] as const) {
  test(`Session.list matches ASCII and typographic ${name} in both directions without changing titles`, async () => {
    await using f = await fixture()
    const created = await Promise.all(marks.map((mark) => f.create(title(mark))))
    await f.create("Unrelated title")
    for (const mark of marks) {
      const result = await Effect.runPromise(f.sessions.list({ search: title(mark) }))
      expect(result.data.map((item) => item.id).sort()).toEqual(created.map((item) => item.id).sort())
      expect(result.data.map((item) => item.title).sort()).toEqual(created.map((item) => item.title).sort())
    }
  }, 30_000)
}

for (const [search, matching, nonmatching] of [
  ["50%", "Progress 50% complete", "Progress 500 complete"],
  ["task_", "Inspect task_one", "Inspect taskXone"],
  ["folder\\", "Inspect folder\\notes", "Inspect foldernotes"],
  ["path\\_%", "Inspect path\\_% literal", "Inspect path\\XYZ wildcard"],
] as const) {
  test(`Session.list treats ${JSON.stringify(search)} as literal search text`, async () => {
    await using f = await fixture()
    const expected = await f.create(matching)
    await f.create(nonmatching)
    const result = await Effect.runPromise(f.sessions.list({ search }))
    expect(result.data.map((item) => item.id)).toEqual([expected.id])
  }, 30_000)
}

test("Session.list retains case-insensitive substring matching and empty search behavior", async () => {
  await using f = await fixture()
  const expected = await f.create("Inspect SaMpLe Connection")
  const other = await f.create("Unrelated title")
  for (const search of ["sample connection", "SAMPLE CONNECTION"]) {
    const result = await Effect.runPromise(f.sessions.list({ search }))
    expect(result.data.map((item) => item.id)).toEqual([expected.id])
  }
  expect((await Effect.runPromise(f.sessions.list({ search: "" }))).data.map((item) => item.id).sort())
    .toEqual([expected.id, other.id].sort())
  expect((await Effect.runPromise(f.sessions.list({ search: "absent" }))).data).toEqual([])
}, 30_000)

test("Session.list filters normalized titles before limiting and preserves next and previous anchors", async () => {
  await using f = await fixture()
  await f.create("Unrelated oldest title")
  await f.create("Inspect sample’s connection one")
  await f.create("Unrelated middle title")
  await f.create("Inspect sample's connection two")
  await f.create("Unrelated newest title")
  for (const order of ["asc", "desc"] as const) {
    const query = { search: "sample's", order }
    const all = await Effect.runPromise(f.sessions.list(query))
    expect(all.data).toHaveLength(2)
    const first = await Effect.runPromise(f.sessions.list({ ...query, limit: 1 }))
    expect(first.data.map((item) => item.id)).toEqual([all.data[0]!.id])
    const second = await Effect.runPromise(f.sessions.list({ ...query, limit: 1, anchor: {
      id: first.data[0]!.id, time: DateTime.toEpochMillis(first.data[0]!.time.updated), direction: "next",
    } }))
    expect(second.data.map((item) => item.id)).toEqual([all.data[1]!.id])
    const previous = await Effect.runPromise(f.sessions.list({ ...query, limit: 1, anchor: {
      id: second.data[0]!.id, time: DateTime.toEpochMillis(second.data[0]!.time.updated), direction: "previous",
    } }))
    expect(previous.data.map((item) => item.id)).toEqual([all.data[0]!.id])
  }
}, 30_000)

test("session.list HTTP finds a typographic title through an ASCII search", async () => {
  await using f = await fixture()
  const expected = await f.create("Inspect sample’s ChatGPT.app-style Dots connection")
  await f.create("Unrelated title")
  const response = await f.request({ search: "INSPECT SAMPLE'S", limit: "1" })
  expect(response.status).toBe(200)
  expect((await response.json()).data.map((item: { id: string }) => item.id)).toEqual([expected.id])
}, 30_000)
