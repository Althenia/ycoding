import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { memoryFixture, note } from "./lib/memory"

test("R5-C ranks lexical matches deterministically and bounds search/list results", async () => {
  await using f = await memoryFixture()
  await f.run(f.store.write({ id: "b", content: note("Same body", "type: Decision\ntitle: Cache\ntags: [runtime]") }))
  await f.run(f.store.write({ id: "a", content: note("Same body", "type: Decision\ntitle: Cache\ntags: [runtime]") }))
  await f.run(f.store.write({ id: "c", content: note("cache café", "type: Guide\ntitle: Other") }))
  expect((await f.run(f.store.search({ query: "cache" }))).hits.map((x) => x.id)).toEqual(["a", "b", "c"])
  expect((await f.run(f.store.search({ query: "cache", type: "Guide" }))).hits.map((x) => x.id)).toEqual(["c"])
  expect((await f.run(f.store.search({ query: "cache", tag: "runtime", limit: 1 }))).hits.map((x) => x.id)).toEqual(["a"])
  expect((await f.run(f.store.search({ query: "CAFÉ" }))).hits.map((x) => x.id)).toEqual(["c"])
  expect((await f.run(f.store.search({ query: "absent" }))).hits).toEqual([])
  expect(await f.run(f.store.list({ offset: 1, limit: 1 }))).toMatchObject({ total: 3, concepts: [{ id: "b" }] })
  for (const input of [{ query: "" }, { query: "x", limit: 51 }]) await expect(f.run(f.store.search(input))).rejects.toThrow()
  expect((await f.run(f.store.search({ query: "x".repeat(1024) }))).hits).toEqual([])
  for (const query of [" ".repeat(1024) + "x", "   "]) await expect(f.run(f.store.search({ query }))).rejects.toThrow("Search query")
  await expect(f.run(f.store.list({ limit: 101 }))).rejects.toThrow()
})

test("R5-C reports malformed knowledge and rejects capacity excess without overwriting concepts", async () => {
  await using f = await memoryFixture({ max_concepts: 1, max_bundle_bytes: 512 })
  await f.run(f.store.write({ id: "a", content: note() }))
  await expect(f.run(f.store.write({ id: "b", content: note() }))).rejects.toThrow()
  expect((await f.run(f.store.list({}))).total).toBe(1)
  await using malformed = await memoryFixture()
  const status = await malformed.run(malformed.store.status())
  await fs.mkdir(status.root, { recursive: true })
  await fs.writeFile(path.join(status.root, "broken.md"), "---\ntype: [\n---")
  expect((await malformed.run(malformed.store.search({ query: "none" }))).warnings).toContainEqual({ id: "broken", code: "invalid-concept" })
})
