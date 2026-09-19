import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber } from "effect"
import { Flock } from "@ycoding-ai/core/util/flock"
import { memoryFixture, note } from "./lib/memory"

test("R5-B preserves open metadata, reconciles exact retries, and rejects conflicting updates", async () => {
  await using f = await memoryFixture()
  const content = note("Evidence.[^spec]", "type: NovelType\ncustom:\n  preserved: true\nsources:\n  - id: spec\n    resource: repo:///README.md")
  const first = await f.run(f.store.write({ id: "decision", content }))
  expect(first.created).toBe(true)
  expect((await f.run(f.store.read({ id: "decision" }))).content).toBe(content)
  expect(await f.run(f.store.write({ id: "decision", content }))).toMatchObject({ created: false, digest: first.digest })
  await expect(f.run(f.store.write({ id: "decision", content: note("Changed") }))).rejects.toThrow("changed")
  const results = await Promise.allSettled([
    f.run(f.store.write({ id: "decision", content: note("One"), expectedDigest: first.digest })),
    f.run(f.store.write({ id: "decision", content: note("Two"), expectedDigest: first.digest })),
  ])
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1)
  expect(results.filter((x) => x.status === "rejected")).toHaveLength(1)
  const current = await f.run(f.store.read({ id: "decision" }))
  expect([note("One"), note("Two")]).toContain(current.content)
  expect((await fs.readdir((await f.run(f.store.status())).root)).some((name) => name.endsWith(".tmp"))).toBe(false)
})

test("R5-B preserves a UTF-8 BOM in human-authored concepts", async () => {
  await using f = await memoryFixture()
  const content = `\uFEFF${note("Unicode café")}`
  await f.run(f.store.write({ id: "unicode", content }))
  expect((await f.run(f.store.read({ id: "unicode" }))).content).toBe(content)
})

test("R5-B rejects text that cannot round-trip as UTF-8 without creating storage", async () => {
  await using f = await memoryFixture()
  await expect(f.run(f.store.write({ id: "invalid", content: note("Unpaired surrogate: \uD800") }))).rejects.toThrow("UTF-8")
  expect(await fs.stat((await f.run(f.store.status())).root).then(() => true, () => false)).toBe(false)
})

test("R5-B/C enforce UTF-8 byte boundaries and aggregate capacity separately", async () => {
  const content = note("café")
  const bytes = Buffer.byteLength(content)
  await using f = await memoryFixture({ max_concept_bytes: bytes, max_bundle_bytes: bytes * 2 - 1 })
  await f.run(f.store.write({ id: "a", content }))
  await expect(f.run(f.store.write({ id: "b", content: content + "x" }))).rejects.toThrow()
  await expect(f.run(f.store.write({ id: "b", content }))).rejects.toThrow()
  expect((await f.run(f.store.list({}))).concepts.map((item) => item.id)).toEqual(["a"])
})

test("R5-B rejects malformed, oversized, reserved, and escaping writes with no concept effects", async () => {
  await using f = await memoryFixture({ max_concept_bytes: 128 })
  for (const id of ["../escape", "/absolute", "notes/../escape", "index", "notes/log", "a.md", "_meta"]) {
    await expect(f.run(f.store.write({ id, content: note() }))).rejects.toThrow()
  }
  for (const content of ["No frontmatter", "---\ntype: ''\n---\nEmpty type", note("Missing.[^absent]"), note("x".repeat(129))]) {
    await expect(f.run(f.store.write({ id: "invalid", content }))).rejects.toThrow()
  }
  expect((await f.run(f.store.list({}))).total).toBe(0)
  const status = await f.run(f.store.status())
  await fs.mkdir(status.root, { recursive: true })
  await fs.symlink(f.workspace, path.join(status.root, "outside"))
  await expect(f.run(f.store.write({ id: "outside/escape", content: note() }))).rejects.toThrow()
  expect(await fs.stat(path.join(f.workspace, "escape.md")).then(() => true, () => false)).toBe(false)
})

test("R5-B reports a committed concept when derived indexes fail and repairs only on explicit mutation", async () => {
  await using f = await memoryFixture()
  const status = await f.run(f.store.status())
  await fs.mkdir(path.join(status.root, "index.md"), { recursive: true })
  const result = await f.run(f.store.write({ id: "saved", content: note() }))
  expect(result.warnings).toContainEqual({ id: "saved", code: "index-out-of-date" })
  expect((await f.run(f.store.read({ id: "saved" }))).digest).toBe(result.digest)
  await fs.rmdir(path.join(status.root, "index.md"))
  await f.run(f.store.list({}))
  expect(await fs.stat(path.join(status.root, "index.md")).then(() => true, () => false)).toBe(false)
  await f.run(f.store.graph())
  expect(await fs.readFile(path.join(status.root, "index.md"), "utf8")).toContain("saved.md")
})

test("R5-B cancels a blocked write without committing or stranding later writers", async () => {
  await using f = await memoryFixture()
  const status = await f.run(f.store.status())
  await fs.mkdir(status.root, { recursive: true })
  const lease = await Flock.acquire(status.root, { dir: path.join(status.root, ".locks") })
  try {
    const fiber = Effect.runFork(f.store.write({ id: "cancelled", content: note() }))
    await f.run(Effect.yieldNow)
    await f.run(Fiber.interrupt(fiber))
  } finally { await lease.release() }
  await f.run(f.store.write({ id: "later", content: note() }))
  expect((await f.run(f.store.list({}))).concepts.map((x) => x.id)).toEqual(["later"])
})
