import { expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber, Schema } from "effect"
import { Flock } from "@ycoding-ai/core/util/flock"
import { MemoryTool } from "@ycoding-ai/core/tool/memory"
import { memoryFixture, note } from "./lib/memory"

function requireMaintenance() {
  expect(Schema.is(MemoryTool.Input)({ action: "delete", id: "entry", expectedDigest: "a".repeat(64) })).toBe(true)
}

test("R8 deletes into recoverable trash, removes active visibility, and restores exact bytes", async () => {
  requireMaintenance()
  await using f = await memoryFixture()
  const content = `\uFEFF${note("Lifecycle sentinel café\nSecond line", "type: Decision\ncustom: retained")}`
  const saved = await f.run(f.store.write({ id: "notes/entry", content }))
  const before = await f.run(f.store.graph())
  const removed = await f.run(f.store.delete({ id: "notes/entry", expectedDigest: saved.digest }))
  expect(removed).toMatchObject({ id: "notes/entry", digest: saved.digest, warnings: [] })
  expect(removed.trashID).toBeString()
  await expect(f.run(f.store.read({ id: "notes/entry" }))).rejects.toThrow()
  expect((await f.run(f.store.list({}))).total).toBe(0)
  expect((await f.run(f.store.search({ query: "sentinel" }))).hits).toEqual([])
  const staleGraph = await fs.readFile(before.path, "utf8").catch(() => "")
  expect(staleGraph).not.toContain("Lifecycle sentinel")
  expect((await f.run(f.store.graph())).nodes).toBe(0)
  expect((await f.run(f.store.trash({}))).entries).toEqual([
    expect.objectContaining({ id: "notes/entry", trashID: removed.trashID, digest: saved.digest }),
  ])
  await f.run(f.store.restore({ trashID: removed.trashID, expectedDigest: saved.digest }))
  expect((await f.run(f.store.read({ id: "notes/entry" }))).content).toBe(content)
  expect((await f.run(f.store.trash({}))).total).toBe(0)
  expect((await f.run(f.store.graph())).nodes).toBe(1)
})

test("R8 rejects stale deletion, occupied restoration, and stale purge without losing either version", async () => {
  requireMaintenance()
  await using f = await memoryFixture()
  const first = await f.run(f.store.write({ id: "entry", content: note("Original") }))
  await expect(f.run(f.store.delete({ id: "entry", expectedDigest: "0".repeat(64) }))).rejects.toThrow()
  expect((await f.run(f.store.read({ id: "entry" }))).digest).toBe(first.digest)
  const removed = await f.run(f.store.delete({ id: "entry", expectedDigest: first.digest }))
  const replacement = await f.run(f.store.write({ id: "entry", content: note("Replacement") }))
  await expect(f.run(f.store.restore({ trashID: removed.trashID, expectedDigest: first.digest }))).rejects.toThrow()
  expect((await f.run(f.store.read({ id: "entry" }))).digest).toBe(replacement.digest)
  await expect(f.run(f.store.purge({ trashID: removed.trashID, expectedDigest: replacement.digest }))).rejects.toThrow()
  expect((await f.run(f.store.trash({}))).total).toBe(1)
  expect(await f.run(f.store.purge({ trashID: removed.trashID, expectedDigest: first.digest }))).toMatchObject({ trashID: removed.trashID, purged: true })
  expect((await f.run(f.store.trash({}))).total).toBe(0)
  await expect(f.run(f.store.restore({ trashID: removed.trashID, expectedDigest: first.digest }))).rejects.toThrow()
  expect((await f.run(f.store.read({ id: "entry" }))).content).toBe(note("Replacement"))
})

test("R8 concurrent deletes retain one recoverable copy and stale writers cannot overwrite it", async () => {
  requireMaintenance()
  await using f = await memoryFixture()
  const saved = await f.run(f.store.write({ id: "entry", content: note() }))
  const outcomes = await Promise.allSettled([
    f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest })),
    f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest })),
  ])
  expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1)
  expect((await f.run(f.store.trash({}))).total).toBe(1)
  await expect(f.run(f.store.write({ id: "entry", content: note("Late update"), expectedDigest: saved.digest }))).rejects.toThrow()
  const entry = (await f.run(f.store.trash({}))).entries[0]!
  await f.run(f.store.restore({ trashID: entry.trashID, expectedDigest: entry.digest }))
  expect((await f.run(f.store.read({ id: "entry" }))).content).toBe(note())
})

test("R8 worktrees share maintenance while repositories and knowledge trash stay isolated", async () => {
  requireMaintenance()
  await using f = await memoryFixture()
  await $`git -C ${f.workspace} -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -qm fixture`.quiet()
  const linkedPath = path.join(f.directory, "linked")
  await $`git -C ${f.workspace} worktree add --detach ${linkedPath}`.quiet()
  const linked = f.make(linkedPath)
  const otherPath = path.join(f.directory, "other")
  await fs.mkdir(otherPath)
  await $`git init -q ${otherPath}`.quiet()
  const other = f.make(otherPath)
  const local = await f.run(f.store.write({ id: "mem_entry", content: note("Local") }))
  const shared = await f.run(f.store.write({ scope: "knowledge", id: "entry", content: note("Shared") }))
  const removed = await f.run(linked.delete({ id: "mem_entry", expectedDigest: local.digest }))
  expect((await f.run(f.store.list({}))).total).toBe(0)
  expect((await f.run(f.store.trash({}))).total).toBe(1)
  expect((await f.run(other.trash({}))).total).toBe(0)
  await expect(f.run(other.restore({ trashID: removed.trashID, expectedDigest: removed.digest }))).rejects.toThrow()
  const knowledge = await f.run(other.delete({ scope: "knowledge", id: "entry", expectedDigest: shared.digest }))
  expect((await f.run(linked.trash({ scope: "knowledge" }))).entries[0]?.trashID).toBe(knowledge.trashID)
  await expect(f.run(f.store.purge({ trashID: knowledge.trashID, expectedDigest: shared.digest }))).rejects.toThrow()
  expect((await f.run(f.store.trash({ scope: "knowledge" }))).total).toBe(1)
})

test("R8 vacuum previews without writes and only removes recognized obsolete derived output", async () => {
  requireMaintenance()
  await using f = await memoryFixture()
  const root = (await f.run(f.store.status())).root
  const empty = await f.run(f.store.vacuum({}))
  expect(empty.dryRun).toBe(true)
  expect(await fs.stat(root).then(() => true, () => false)).toBe(false)
  const live = await f.run(f.store.write({ id: "live", content: note("Keep this") }))
  await f.run(f.store.write({ id: "old/entry", content: note("Removed externally") }))
  await fs.unlink(path.join(root, "old/entry.md"))
  await fs.writeFile(path.join(root, "keep.txt"), "Unrelated data")
  await fs.mkdir(path.join(root, "manual"))
  await fs.writeFile(path.join(root, "manual/index.md"), "Handwritten index; preserve")
  await fs.writeFile(path.join(root, ".unowned.tmp"), "Unowned temporary data")
  const before = await snapshot(root)
  const preview = await f.run(f.store.vacuum({}))
  expect(preview.dryRun).toBe(true)
  expect(preview.removed).toContain("old/index.md")
  expect(await snapshot(root)).toEqual(before)
  const cleaned = await f.run(f.store.vacuum({ dryRun: false, expectedDigest: preview.digest }))
  expect(cleaned.dryRun).toBe(false)
  expect(cleaned.removed).toContain("old/index.md")
  expect(await fs.stat(path.join(root, "old/index.md")).then(() => true, () => false)).toBe(false)
  expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("Unrelated data")
  expect(await fs.readFile(path.join(root, "manual/index.md"), "utf8")).toBe("Handwritten index; preserve")
  expect(await fs.readFile(path.join(root, ".unowned.tmp"), "utf8")).toBe("Unowned temporary data")
  expect((await f.run(f.store.read({ id: "live" }))).digest).toBe(live.digest)
})

test("R8 vacuum rejects stale or missing preview digests and preserves active edits and trash", async () => {
  requireMaintenance()
  await using f = await memoryFixture()
  const saved = await f.run(f.store.write({ id: "entry", content: note() }))
  await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
  const preview = await f.run(f.store.vacuum({}))
  const live = await f.run(f.store.write({ id: "new", content: note("New facts") }))
  const root = (await f.run(f.store.status())).root
  const before = await snapshot(root)
  await expect(f.run(f.store.vacuum({ dryRun: false, expectedDigest: preview.digest }))).rejects.toThrow()
  await expect(f.run(f.store.vacuum({ dryRun: false }))).rejects.toThrow()
  expect(await snapshot(root)).toEqual(before)
  expect((await f.run(f.store.read({ id: "new" }))).digest).toBe(live.digest)
  expect((await f.run(f.store.trash({}))).total).toBe(1)
})

test("R8 bounded trash refuses deletion without losing the live entry and still permits purge", async () => {
  requireMaintenance()
  await using f = await memoryFixture({ max_concepts: 1 })
  const first = await f.run(f.store.write({ id: "first", content: note() }))
  const trashed = await f.run(f.store.delete({ id: "first", expectedDigest: first.digest }))
  const next = await f.run(f.store.write({ id: "next", content: note("Next") }))
  await expect(f.run(f.store.delete({ id: "next", expectedDigest: next.digest }))).rejects.toThrow()
  expect((await f.run(f.store.read({ id: "next" }))).digest).toBe(next.digest)
  await f.run(f.store.purge({ trashID: trashed.trashID, expectedDigest: first.digest }))
  await f.run(f.store.delete({ id: "next", expectedDigest: next.digest }))
  expect((await f.run(f.store.trash({}))).total).toBe(1)
})

test("R8 reports committed deletion and restoration when derived index rebuilding fails", async () => {
  requireMaintenance()
  await using f = await memoryFixture()
  const content = note("Sensitive deleted sentinel")
  const saved = await f.run(f.store.write({ id: "entry", content }))
  const graph = await f.run(f.store.graph())
  const root = (await f.run(f.store.status())).root
  await fs.unlink(path.join(root, "index.md"))
  await fs.mkdir(path.join(root, "index.md"))
  const removed = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
  expect(removed.warnings).toContainEqual(expect.objectContaining({ code: "index-out-of-date" }))
  expect((await f.run(f.store.trash({}))).entries[0]?.trashID).toBe(removed.trashID)
  await expect(f.run(f.store.read({ id: "entry" }))).rejects.toThrow()
  expect(await fs.readFile(graph.path, "utf8").catch(() => "")).not.toContain("Sensitive deleted sentinel")
  const restored = await f.run(f.store.restore({ trashID: removed.trashID, expectedDigest: saved.digest }))
  expect(restored.warnings).toContainEqual(expect.objectContaining({ code: "index-out-of-date" }))
  expect((await f.run(f.store.read({ id: "entry" }))).content).toBe(content)
  expect((await f.run(f.store.trash({}))).total).toBe(0)
})

test.each([{ max_concepts: 1 }, { max_bundle_bytes: Buffer.byteLength(note("Capacity candidate")) }])(
  "R8 refuses restore before commit when active collection capacity would be exceeded: %j",
  async settings => {
    await using f = await memoryFixture(settings)
    const content = note("Capacity candidate")
    const saved = await f.run(f.store.write({ id: "original", content }))
    const removed = await f.run(f.store.delete({ id: "original", expectedDigest: saved.digest }))
    await f.run(f.store.write({ id: "replacement", content }))
    await expect(f.run(f.store.restore({ trashID: removed.trashID, expectedDigest: removed.digest }))).rejects.toThrow()
    const root = (await f.run(f.store.status())).root
    expect(await fs.stat(path.join(root, "original.md")).then(() => true, () => false)).toBe(false)
    expect((await f.run(f.store.trash({}))).total).toBe(1)
    expect((await f.run(f.store.read({ id: "replacement" }))).content).toBe(content)
  },
)

test.each(["restore", "purge"] as const)("R8 %s validates the actual archived bytes, not only metadata", async action => {
  await using f = await memoryFixture()
  const saved = await f.run(f.store.write({ id: "entry", content: note() }))
  const removed = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
  const root = (await f.run(f.store.status())).root
  const archived = path.join(root, "trash", `${removed.trashID}.md`)
  const changed = note("Externally changed archived bytes")
  await fs.writeFile(archived, changed)
  const request = { trashID: removed.trashID, expectedDigest: removed.digest }
  await expect(action === "restore" ? f.run(f.store.restore(request)) : f.run(f.store.purge(request))).rejects.toThrow()
  expect(await fs.readFile(archived, "utf8")).toBe(changed)
  expect(await fs.stat(path.join(root, "entry.md")).then(() => true, () => false)).toBe(false)
})

test("R8 reserves the trash namespace instead of accepting invisible live concepts", async () => {
  await using f = await memoryFixture()
  expect(Schema.is(MemoryTool.Input)({ action: "write", id: "trash/hidden", content: note() })).toBe(false)
  await expect(f.run(f.store.write({ id: "trash/hidden", content: note() }))).rejects.toThrow()
  expect(await fs.stat((await f.run(f.store.status())).root).then(() => true, () => false)).toBe(false)
})

test("R8 restore refuses tampered metadata rather than restoring to a different concept ID", async () => {
  await using f = await memoryFixture()
  const saved = await f.run(f.store.write({ id: "original", content: note() }))
  const removed = await f.run(f.store.delete({ id: "original", expectedDigest: saved.digest }))
  const root = (await f.run(f.store.status())).root
  const metadata = path.join(root, "trash", `${removed.trashID}.json`)
  const original = await Bun.file(metadata).json()
  await fs.writeFile(metadata, JSON.stringify({ ...original, id: "different" }))
  await expect(f.run(f.store.restore({ trashID: removed.trashID, expectedDigest: removed.digest }))).rejects.toThrow()
  expect(await fs.stat(path.join(root, "different.md")).then(() => true, () => false)).toBe(false)
  expect(await fs.readFile(path.join(root, "trash", `${removed.trashID}.md`), "utf8")).toBe(note())
})

test("R8 can delete a recreated identical concept while its earlier copy remains in trash", async () => {
  await using f = await memoryFixture()
  const saved = await f.run(f.store.write({ id: "entry", content: note() }))
  const first = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
  const recreated = await f.run(f.store.write({ id: "entry", content: note() }))
  const second = await f.run(f.store.delete({ id: "entry", expectedDigest: recreated.digest }))
  expect((await f.run(f.store.list({}))).total).toBe(0)
  expect((await f.run(f.store.trash({}))).entries).toContainEqual(expect.objectContaining({ trashID: first.trashID }))
  expect((await f.run(f.store.trash({}))).entries).toContainEqual(expect.objectContaining({ trashID: second.trashID }))
  await f.run(f.store.restore({ trashID: second.trashID, expectedDigest: second.digest }))
  expect((await f.run(f.store.read({ id: "entry" }))).content).toBe(note())
})

test("R8 a refused deletion cannot leave an unreported commit when another concept exceeds limits", async () => {
  await using f = await memoryFixture()
  const saved = await f.run(f.store.write({ id: "entry", content: note() }))
  const root = (await f.run(f.store.status())).root
  await fs.writeFile(path.join(root, "oversized.md"), note("x".repeat(f.settings.max_concept_bytes + 1)))
  const outcome = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest })).then(
    result => ({ committed: true as const, result }),
    () => ({ committed: false as const }),
  )
  if (!outcome.committed) {
    expect(await fs.readFile(path.join(root, "entry.md"), "utf8")).toBe(note())
    expect((await f.run(f.store.trash({}))).total).toBe(0)
    return
  }
  expect(outcome.result.warnings).toContainEqual(expect.objectContaining({ code: "index-out-of-date" }))
  expect((await f.run(f.store.trash({}))).entries[0]?.trashID).toBe(outcome.result.trashID)
})

test("R8 vacuum preview creates no lock files and apply preserves handwritten root indexes", async () => {
  await using f = await memoryFixture()
  const root = (await f.run(f.store.status())).root
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, "index.md"), "Handwritten root index")
  const before = await fs.readdir(root)
  const preview = await f.run(f.store.vacuum({}))
  expect(await fs.readdir(root)).toEqual(before)
  await f.run(f.store.vacuum({ dryRun: false, expectedDigest: preview.digest }))
  expect(await fs.readFile(path.join(root, "index.md"), "utf8")).toBe("Handwritten root index")
})

test("R8 vacuum rejects a preview after an obsolete generated file is edited", async () => {
  await using f = await memoryFixture()
  await f.run(f.store.write({ id: "old/entry", content: note() }))
  const root = (await f.run(f.store.status())).root
  await fs.unlink(path.join(root, "old/entry.md"))
  const preview = await f.run(f.store.vacuum({}))
  const index = path.join(root, "old/index.md")
  const changed = `${await fs.readFile(index, "utf8")}\nNew content added after preview\n`
  await fs.writeFile(index, changed)
  await expect(f.run(f.store.vacuum({ dryRun: false, expectedDigest: preview.digest }))).rejects.toThrow()
  expect(await fs.readFile(index, "utf8")).toBe(changed)
})

test("R8 cancellation before deletion commits preserves the entry and permits later operations", async () => {
  requireMaintenance()
  await using f = await memoryFixture()
  const saved = await f.run(f.store.write({ id: "entry", content: note() }))
  const root = (await f.run(f.store.status())).root
  const lease = await Flock.acquire(root, { dir: path.join(root, ".locks") })
  try {
    const fiber = Effect.runFork(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
    await f.run(Effect.yieldNow)
    await f.run(Fiber.interrupt(fiber))
  } finally { await lease.release() }
  expect((await f.run(f.store.read({ id: "entry" }))).digest).toBe(saved.digest)
  expect((await f.run(f.store.trash({}))).total).toBe(0)
  const removed = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
  await f.run(f.store.restore({ trashID: removed.trashID, expectedDigest: removed.digest }))
  expect((await f.run(f.store.read({ id: "entry" }))).content).toBe(note())
})

async function snapshot(root: string) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  const targets = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort()
  return Promise.all(targets.map(async target => {
    return { path: path.relative(root, target), bytes: (await fs.readFile(target)).toString("base64"), mtime: (await fs.stat(target)).mtimeMs }
  }))
}
