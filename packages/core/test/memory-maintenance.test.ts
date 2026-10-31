import { expect, spyOn, test } from "bun:test"
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
  expect(await f.run(f.store.purge({ trashID: removed.trashID, expectedDigest: first.digest }))).toMatchObject({
    trashID: removed.trashID,
    purged: true,
  })
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
  expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1)
  expect((await f.run(f.store.trash({}))).total).toBe(1)
  await expect(
    f.run(f.store.write({ id: "entry", content: note("Late update"), expectedDigest: saved.digest })),
  ).rejects.toThrow()
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
  expect(
    await fs.stat(root).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
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
  expect(
    await fs.stat(path.join(root, "old/index.md")).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
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
  async (settings) => {
    await using f = await memoryFixture(settings)
    const content = note("Capacity candidate")
    const saved = await f.run(f.store.write({ id: "original", content }))
    const removed = await f.run(f.store.delete({ id: "original", expectedDigest: saved.digest }))
    await f.run(f.store.write({ id: "replacement", content }))
    await expect(f.run(f.store.restore({ trashID: removed.trashID, expectedDigest: removed.digest }))).rejects.toThrow()
    const root = (await f.run(f.store.status())).root
    expect(
      await fs.stat(path.join(root, "original.md")).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect((await f.run(f.store.trash({}))).total).toBe(1)
    expect((await f.run(f.store.read({ id: "replacement" }))).content).toBe(content)
  },
)

test.each(["restore", "purge"] as const)(
  "R8 %s validates the actual archived bytes, not only metadata",
  async (action) => {
    await using f = await memoryFixture()
    const saved = await f.run(f.store.write({ id: "entry", content: note() }))
    const removed = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
    const root = (await f.run(f.store.status())).root
    const archived = path.join(root, "trash", `${removed.trashID}.md`)
    const changed = note("Externally changed archived bytes")
    await fs.writeFile(archived, changed)
    const request = { trashID: removed.trashID, expectedDigest: removed.digest }
    await expect(
      action === "restore" ? f.run(f.store.restore(request)) : f.run(f.store.purge(request)),
    ).rejects.toThrow()
    expect(await fs.readFile(archived, "utf8")).toBe(changed)
    expect(
      await fs.stat(path.join(root, "entry.md")).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  },
)

test("R8 reserves the trash namespace instead of accepting invisible live concepts", async () => {
  await using f = await memoryFixture()
  expect(Schema.is(MemoryTool.Input)({ action: "write", id: "trash/hidden", content: note() })).toBe(false)
  await expect(f.run(f.store.write({ id: "trash/hidden", content: note() }))).rejects.toThrow()
  expect(
    await fs.stat((await f.run(f.store.status())).root).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
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
  expect(
    await fs.stat(path.join(root, "different.md")).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
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
    (result) => ({ committed: true as const, result }),
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
  } finally {
    await lease.release()
  }
  expect((await f.run(f.store.read({ id: "entry" }))).digest).toBe(saved.digest)
  expect((await f.run(f.store.trash({}))).total).toBe(0)
  const removed = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
  await f.run(f.store.restore({ trashID: removed.trashID, expectedDigest: removed.digest }))
  expect((await f.run(f.store.read({ id: "entry" }))).content).toBe(note())
})

test("R9 vacuum repairs an orphan trash receipt only through preview and apply", async () => {
  await using f = await memoryFixture()
  const root = (await f.run(f.store.status())).root
  const knowledgeRoot = (await f.run(f.store.status("knowledge"))).root
  const kept = await f.run(f.store.write({ id: "kept", content: note("Kept") }))
  const first = await f.run(f.store.write({ id: "first", content: note("First") }))
  const second = await f.run(f.store.write({ id: "second", content: note("Second") }))
  const third = await f.run(f.store.write({ id: "third", content: note("Third") }))
  const shared = await f.run(f.store.write({ scope: "knowledge", id: "shared", content: note("Shared") }))
  const orphan = await f.run(f.store.delete({ id: "first", expectedDigest: first.digest }))
  const restorable = await f.run(f.store.delete({ id: "second", expectedDigest: second.digest }))
  const purgeable = await f.run(f.store.delete({ id: "third", expectedDigest: third.digest }))
  const sharedOrphan = await f.run(f.store.delete({ scope: "knowledge", id: "shared", expectedDigest: shared.digest }))
  await fs.rm(path.join(root, "trash", `${orphan.trashID}.md`))
  await fs.rm(path.join(knowledgeRoot, "trash", `${sharedOrphan.trashID}.md`))
  await expect(f.run(f.store.delete({ id: "kept", expectedDigest: kept.digest }))).rejects.toThrow()
  expect((await f.run(f.store.read({ id: "kept" }))).digest).toBe(kept.digest)
  await f.run(f.store.restore({ trashID: restorable.trashID, expectedDigest: restorable.digest }))
  expect((await f.run(f.store.read({ id: "second" }))).content).toBe(note("Second"))
  await f.run(f.store.purge({ trashID: purgeable.trashID, expectedDigest: purgeable.digest }))
  const metadata = `trash/${orphan.trashID}.json`
  const before = await snapshot(root)
  const preview = await f.run(f.store.vacuum({}))
  expect(preview.dryRun).toBe(true)
  expect(preview.removed).toEqual([metadata])
  expect(await snapshot(root)).toEqual(before)
  const applied = await f.run(f.store.vacuum({ dryRun: false, expectedDigest: preview.digest }))
  expect(applied.dryRun).toBe(false)
  expect(applied.removed).toEqual([metadata])
  expect(await exists(path.join(root, metadata))).toBe(false)
  expect(await fs.readFile(path.join(knowledgeRoot, "trash", `${sharedOrphan.trashID}.json`), "utf8")).toBe(
    receipt("shared"),
  )
  expect((await f.run(f.store.vacuum({ scope: "knowledge" }))).removed).toEqual([`trash/${sharedOrphan.trashID}.json`])
  expect(await f.run(f.store.trash({}))).toEqual({ entries: [], total: 0, warnings: [] })
  expect((await f.run(f.store.read({ id: "kept" }))).digest).toBe(kept.digest)
  await f.run(f.store.delete({ id: "kept", expectedDigest: kept.digest }))
  expect((await f.run(f.store.trash({}))).total).toBe(1)
})

test("R9 vacuum apply rejects an orphan receipt whose bytes changed after preview", async () => {
  await using f = await memoryFixture()
  const root = (await f.run(f.store.status())).root
  const saved = await f.run(f.store.write({ id: "entry", content: note() }))
  const removed = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
  await fs.rm(path.join(root, "trash", `${removed.trashID}.md`))
  const metadata = path.join(root, "trash", `${removed.trashID}.json`)
  const preview = await f.run(f.store.vacuum({}))
  expect(preview.removed).toEqual([`trash/${removed.trashID}.json`])
  const changed = JSON.stringify({ id: "entry", version: 1 }) + "\n"
  await fs.writeFile(metadata, changed)
  await expect(f.run(f.store.vacuum({ dryRun: false, expectedDigest: preview.digest }))).rejects.toThrow()
  expect(await fs.readFile(metadata, "utf8")).toBe(changed)
  const fresh = await f.run(f.store.vacuum({}))
  expect(fresh.digest).not.toBe(preview.digest)
  expect(fresh.removed).toEqual([`trash/${removed.trashID}.json`])
  await f.run(f.store.vacuum({ dryRun: false, expectedDigest: fresh.digest }))
  expect(await exists(metadata)).toBe(false)
})

test("R9 vacuum preserves unrecognized, oversized, symlinked, other-version, and archive-backed receipts", async () => {
  await using f = await memoryFixture()
  const root = (await f.run(f.store.status())).root
  const trash = path.join(root, "trash")
  const entry = await f.run(f.store.write({ id: "entry", content: note() }))
  const damaged = await f.run(f.store.write({ id: "damaged", content: note("Damaged") }))
  const orphan = await f.run(f.store.delete({ id: "entry", expectedDigest: entry.digest }))
  const damagedTrash = await f.run(f.store.delete({ id: "damaged", expectedDigest: damaged.digest }))
  await fs.rm(path.join(trash, `${orphan.trashID}.md`))
  await fs.writeFile(path.join(trash, `${damagedTrash.trashID}.md`), Buffer.from([0xff, 0xfe, 0xfd]))
  const named = (digit: string) => path.join(trash, `trash_${digit.repeat(64)}.json`)
  await fs.writeFile(named("1"), JSON.stringify({ version: 2, id: "entry" }) + "\n")
  await fs.writeFile(named("2"), JSON.stringify({ id: "entry" }) + "\n")
  await fs.writeFile(named("3"), "{ malformed receipt")
  await fs.writeFile(named("4"), receipt("Bad.ID"))
  await fs.writeFile(named("5"), JSON.stringify({ version: 1, id: "entry", padding: "x".repeat(5000) }) + "\n")
  const outside = path.join(f.directory, "outside-receipt.json")
  await fs.writeFile(outside, receipt("entry"))
  await fs.symlink(outside, named("6"))
  await fs.mkdir(named("7"))
  await fs.writeFile(named("8"), JSON.stringify({ version: 1, id: "entry", note: "x" }) + "\n")
  await fs.writeFile(path.join(trash, "notes.json"), receipt("entry"))
  await fs.writeFile(path.join(trash, `trash_${"A".repeat(64)}.json`), receipt("entry"))
  await fs.writeFile(path.join(trash, ".pending.tmp"), "Unknown temporary data")
  await fs.writeFile(path.join(root, ".leftover.tmp"), "Unknown temporary data")
  const metadata = `trash/${orphan.trashID}.json`
  const preserved = async () => (await snapshot(root)).filter((item) => item.path !== "index.md")
  const before = await preserved()
  const preview = await f.run(f.store.vacuum({}))
  expect(preview.removed).toEqual([metadata])
  expect(await preserved()).toEqual(before)
  const applied = await f.run(f.store.vacuum({ dryRun: false, expectedDigest: preview.digest }))
  expect(applied.removed).toEqual([metadata])
  expect(await preserved()).toEqual(before.filter((item) => item.path !== metadata))
  expect((await fs.lstat(named("6"))).isSymbolicLink()).toBe(true)
  expect(await fs.readFile(outside, "utf8")).toBe(receipt("entry"))
  expect((await fs.lstat(named("7"))).isDirectory()).toBe(true)
})

test("R9 reports unpaired trash archives as bounded diagnostics and never removes them", async () => {
  await using f = await memoryFixture()
  const root = (await f.run(f.store.status())).root
  const saved = await f.run(f.store.write({ id: "solo", content: note("Solo") }))
  const solo = await f.run(f.store.delete({ id: "solo", expectedDigest: saved.digest }))
  await fs.rm(path.join(root, "trash", `${solo.trashID}.json`))
  const archive = path.join(root, "trash", `${solo.trashID}.md`)
  const listing = await f.run(f.store.trash({}))
  expect(listing.entries).toEqual([])
  expect(listing.warnings).toContainEqual(expect.objectContaining({ id: solo.trashID }))
  const preview = await f.run(f.store.vacuum({}))
  expect(preview.removed).toEqual([])
  expect(preview.warnings).toContainEqual(expect.objectContaining({ id: solo.trashID }))
  await f.run(f.store.vacuum({ dryRun: false, expectedDigest: preview.digest }))
  expect(await fs.readFile(archive, "utf8")).toBe(note("Solo"))
  await using bounded = await memoryFixture({ max_concepts: 4 })
  const boundedTrash = path.join((await bounded.run(bounded.store.status())).root, "trash")
  await fs.mkdir(boundedTrash, { recursive: true })
  const archives = Array.from({ length: 12 }, (_, index) =>
    path.join(boundedTrash, `trash_${index.toString(16).padStart(64, "0")}.md`),
  )
  for (const target of archives) await fs.writeFile(target, note("Unpaired"))
  const boundedListing = await bounded.run(bounded.store.trash({}))
  expect(boundedListing.warnings.length).toBeGreaterThan(0)
  expect(boundedListing.warnings.length).toBeLessThanOrEqual(bounded.settings.max_concepts)
  expect((await bounded.run(bounded.store.vacuum({}))).removed).toEqual([])
  for (const target of archives) expect(await fs.readFile(target, "utf8")).toBe(note("Unpaired"))
})

test("R9 bounds orphan receipt recovery by the configured inventory limit", async () => {
  await using f = await memoryFixture({ max_concepts: 2 })
  const root = (await f.run(f.store.status())).root
  await fs.mkdir(path.join(root, "trash"), { recursive: true })
  const receipts = Array.from({ length: 5 }, (_, index) => `trash/trash_${index.toString(16).padStart(64, "0")}.json`)
  for (const [index, relative] of receipts.entries())
    await fs.writeFile(path.join(root, relative), receipt(`orphan-${index}`))
  const before = await snapshot(root)
  const preview = await f.run(f.store.vacuum({}))
  expect(await snapshot(root)).toEqual(before)
  expect(preview.removed.length).toBeGreaterThan(0)
  expect(preview.removed.length).toBeLessThanOrEqual(f.settings.max_concepts)
  expect(preview.removed.every((item) => receipts.includes(item))).toBe(true)
  expect(preview.warnings.length).toBeGreaterThan(0)
  const applied = await f.run(f.store.vacuum({ dryRun: false, expectedDigest: preview.digest }))
  expect(applied.removed).toEqual(preview.removed)
  for (const relative of receipts)
    expect(await exists(path.join(root, relative))).toBe(!preview.removed.includes(relative))
})

test("R9 vacuum reports committed removals with a warning when index rebuilding fails afterward", async () => {
  await using f = await memoryFixture()
  const live = await f.run(f.store.write({ id: "live", content: note("Live") }))
  await f.run(f.store.write({ id: "old/entry", content: note("Old") }))
  const root = (await f.run(f.store.status())).root
  await fs.unlink(path.join(root, "old/entry.md"))
  await fs.unlink(path.join(root, "index.md"))
  await fs.mkdir(path.join(root, "index.md"))
  const preview = await f.run(f.store.vacuum({}))
  expect(preview.removed).toEqual(["old/index.md"])
  const applied = await f.run(f.store.vacuum({ dryRun: false, expectedDigest: preview.digest }))
  expect(applied.removed).toEqual(["old/index.md"])
  expect(applied.warnings).toContainEqual(expect.objectContaining({ code: "index-out-of-date" }))
  expect(await exists(path.join(root, "old/index.md"))).toBe(false)
  expect((await f.run(f.store.read({ id: "live" }))).digest).toBe(live.digest)
})

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "R9 vacuum returns only actually removed paths with a warning when a later removal fails",
  async () => {
    await using f = await memoryFixture()
    await f.run(f.store.write({ id: "live", content: note("Live") }))
    await f.run(f.store.write({ id: "old/entry", content: note("Old") }))
    await f.run(f.store.write({ id: "zzz/entry", content: note("Locked") }))
    const root = (await f.run(f.store.status())).root
    await fs.unlink(path.join(root, "old/entry.md"))
    await fs.unlink(path.join(root, "zzz/entry.md"))
    const preview = await f.run(f.store.vacuum({}))
    expect(preview.removed).toEqual(["old/index.md", "zzz/index.md"])
    const locked = path.join(root, "zzz")
    await fs.chmod(locked, 0o500)
    try {
      const applied = await f.run(f.store.vacuum({ dryRun: false, expectedDigest: preview.digest }))
      expect(applied.removed).toEqual(["old/index.md"])
      expect(applied.warnings.length).toBeGreaterThan(0)
    } finally {
      await fs.chmod(locked, 0o700)
    }
    expect(await exists(path.join(root, "old/index.md"))).toBe(false)
    expect(await exists(path.join(root, "zzz/index.md"))).toBe(true)
  },
)

test.each(["restore", "purge"] as const)(
  "R9 %s returns its committed result with a warning when receipt cleanup fails afterward",
  async (action) => {
    await using f = await memoryFixture()
    const root = (await f.run(f.store.status())).root
    const saved = await f.run(f.store.write({ id: "entry", content: note() }))
    const removed = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
    const metadata = path.join(root, "trash", `${removed.trashID}.json`)
    const archive = path.join(root, "trash", `${removed.trashID}.md`)
    const request = { trashID: removed.trashID, expectedDigest: removed.digest }
    const rm = fs.rm
    const probe = spyOn(fs, "rm").mockImplementation((target, options) =>
      target === metadata ? Promise.reject(new Error("Synthetic receipt removal failure")) : rm(target, options),
    )
    const result = await (
      action === "restore" ? f.run(f.store.restore(request)) : f.run(f.store.purge(request))
    ).finally(() => probe.mockRestore())
    expect(result).toMatchObject(
      action === "restore" ? { id: "entry", digest: removed.digest } : { trashID: removed.trashID, purged: true },
    )
    expect(result.warnings).toContainEqual({ id: removed.trashID, code: "trash-metadata-out-of-date" })
    expect(await exists(archive)).toBe(false)
    expect(await fs.readFile(metadata, "utf8")).toBe(receipt("entry"))
    expect(await exists(path.join(root, "entry.md"))).toBe(action === "restore")
    if (action === "restore") expect((await f.run(f.store.read({ id: "entry" }))).content).toBe(note())
    const preview = await f.run(f.store.vacuum({}))
    expect(preview.removed).toEqual([`trash/${removed.trashID}.json`])
    await f.run(f.store.vacuum({ dryRun: false, expectedDigest: preview.digest }))
    expect(await exists(metadata)).toBe(false)
  },
)

test("R9 preserves delete admission with an unpaired archive at a one-entry limit", async () => {
  await using f = await memoryFixture({ max_concepts: 1 })
  const root = (await f.run(f.store.status())).root
  const saved = await f.run(f.store.write({ id: "entry", content: note() }))
  const archive = path.join(root, "trash", `trash_${"0".repeat(64)}.md`)
  await fs.mkdir(path.dirname(archive), { recursive: true })
  await fs.writeFile(archive, note("Unpaired"))
  const removed = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
  const listing = await f.run(f.store.trash({}))
  expect(listing.entries).toEqual([expect.objectContaining({ id: "entry", trashID: removed.trashID })])
  expect(listing.warnings.length).toBeLessThanOrEqual(f.settings.max_concepts)
  expect(listing.warnings.every((warning) => warning.code === "unpaired-trash")).toBe(true)
  expect(await fs.readFile(archive, "utf8")).toBe(note("Unpaired"))
})

test("R9 discovers valid receipts after capped unpaired archive diagnostics", async () => {
  await using f = await memoryFixture({ max_concepts: 4 })
  const root = (await f.run(f.store.status())).root
  const restorableSaved = await f.run(f.store.write({ id: "restorable", content: note("Restorable") }))
  const purgeableSaved = await f.run(f.store.write({ id: "purgeable", content: note("Purgeable") }))
  const restorable = await f.run(f.store.delete({ id: "restorable", expectedDigest: restorableSaved.digest }))
  const purgeable = await f.run(f.store.delete({ id: "purgeable", expectedDigest: purgeableSaved.digest }))
  const archives = Array.from({ length: 10 }, (_, index) =>
    path.join(root, "trash", `trash_${index.toString(16).padStart(64, "0")}.md`),
  )
  for (const target of archives) await fs.writeFile(target, note("Unpaired"))
  const listing = await f.run(f.store.trash({}))
  expect(listing.entries.map((entry) => entry.trashID).sort()).toEqual([restorable.trashID, purgeable.trashID].sort())
  expect(listing.total).toBe(2)
  expect(listing.warnings.length).toBeGreaterThan(0)
  expect(listing.warnings.length).toBeLessThanOrEqual(f.settings.max_concepts)
  expect(listing.warnings.every((warning) => warning.code === "unpaired-trash")).toBe(true)
  await f.run(f.store.restore({ trashID: restorable.trashID, expectedDigest: restorable.digest }))
  expect((await f.run(f.store.read({ id: "restorable" }))).content).toBe(note("Restorable"))
  await f.run(f.store.purge({ trashID: purgeable.trashID, expectedDigest: purgeable.digest }))
  expect((await f.run(f.store.trash({}))).entries).toEqual([])
  for (const target of archives) expect(await fs.readFile(target, "utf8")).toBe(note("Unpaired"))
})

function receipt(id: string) {
  return JSON.stringify({ version: 1, id }) + "\n"
}

function exists(target: string) {
  return fs.lstat(target).then(
    () => true,
    () => false,
  )
}

async function snapshot(root: string) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  const targets = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort()
  return Promise.all(
    targets.map(async (target) => {
      return {
        path: path.relative(root, target),
        bytes: (await fs.readFile(target)).toString("base64"),
        mtime: (await fs.stat(target)).mtimeMs,
      }
    }),
  )
}
