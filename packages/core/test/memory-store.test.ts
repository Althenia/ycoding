import { expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { memoryFixture, note } from "./lib/memory"

test("R5-A reads missing storage without creating it and reloads repository-isolated memories", async () => {
  await using f = await memoryFixture()
  const status = await f.run(f.store.status())
  expect(status.enabled).toBe(true)
  expect(status.repository?.id).toMatch(/^repo_[a-f0-9]{64}$/)
  expect(status.root).toBe(path.join(await fs.realpath(f.directory), "data", "memory", "repository", status.repository!.id))
  expect(await f.run(f.store.list({}))).toEqual({ concepts: [], total: 0, warnings: [] })
  expect(await fs.stat(path.join(f.directory, "data")).then(() => true, () => false)).toBe(false)
  await f.run(f.store.write({ id: "build/rules", content: note() }))
  expect((await f.run(f.make().read({ id: "build/rules" }))).content).toBe(note())
  const other = path.join(f.directory, "other")
  await fs.mkdir(other)
  await $`git init -q ${other}`.quiet()
  expect((await f.run(f.make(other).list({}))).total).toBe(0)
  const alias = path.join(f.directory, "alias")
  await fs.symlink(f.workspace, alias)
  expect((await f.run(f.make(alias).status())).repository?.id).toBe(status.repository!.id)
  if (process.platform !== "win32") {
    expect((await fs.stat(status.root)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(status.root, "build/rules.md"))).mode & 0o777).toBe(0o600)
  }
})

test("R5 repository index associates the main checkout and linked worktrees with shared entries and knowledge traversal", async () => {
  await using f = await memoryFixture()
  await $`git -C ${f.workspace} -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -qm fixture`.quiet()
  const worktree = path.join(f.directory, "linked")
  await $`git -C ${f.workspace} worktree add --detach ${worktree}`.quiet()
  const nested = path.join(worktree, "src")
  await fs.mkdir(nested)
  const primary = await f.run(f.store.status())
  const linked = f.make(nested)
  const selected = await f.run(linked.status())
  expect(selected.repository?.id).toBe(primary.repository?.id)
  expect(selected.root).toBe(primary.root)
  expect(selected.root).toContain(`${path.sep}repository${path.sep}repo_`)
  const saved = await f.run(linked.write({ id: "mem_build", content: note("See [shared build knowledge](../../knowledge/build.md).") }))
  expect((await f.run(f.store.read({ id: "mem_build" }))).digest).toBe(saved.digest)
  await f.run(f.store.write({ scope: "knowledge", id: "build", content: note("Shared build facts.", "type: Knowledge\ntitle: Build") }))
  const knowledge = await f.run(linked.status("knowledge"))
  expect(knowledge.root).toBe(path.join(primary.base, "knowledge"))
  expect((await f.run(linked.read({ scope: "knowledge", id: "build" }))).content).toContain("Shared build facts")
  const index = await fs.readFile(path.join(primary.root, "index.md"), "utf8")
  expect(index).toContain("type: Index")
  expect(index).toContain(await fs.realpath(f.workspace))
  expect(index).toContain(await fs.realpath(worktree))
  expect(index).toContain("mem_build.md")
  expect(index).toContain("../../knowledge/index.md")
  expect(await fs.readFile(path.join(knowledge.root, "index.md"), "utf8")).toContain("build.md")
  const graph = await f.run(linked.graph())
  expect(graph.nodes).toBe(2)
  expect(graph.edges).toBe(1)
  expect(await fs.readFile(graph.path, "utf8")).toContain(`repository/${primary.repository!.id}/mem_build`)
  expect(await fs.readFile(graph.path, "utf8")).toContain("knowledge/build")
  expect((await f.run(f.store.graph({ scope: "knowledge" }))).nodes).toBe(1)
})

test("R5 shares repository memory under relative base overrides and keeps shared knowledge available outside Git", async () => {
  await using f = await memoryFixture({ path: "notes" })
  await $`git -C ${f.workspace} -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -qm fixture`.quiet()
  const worktree = path.join(f.directory, "linked")
  await $`git -C ${f.workspace} worktree add --detach ${worktree}`.quiet()
  expect((await f.run(f.make(worktree).status())).root).toBe((await f.run(f.store.status())).root)
  const outside = path.join(f.directory, "outside")
  await fs.mkdir(outside)
  await expect(f.run(f.make(outside).list({}))).rejects.toThrow("repository")
  await f.run(f.make(outside).write({ scope: "knowledge", id: "general", content: note() }))
  expect((await f.run(f.make(outside).list({ scope: "knowledge" }))).concepts.map(concept => concept.id)).toEqual(["general"])
})

test("R5-A/E disabled memory and path overrides retain existing data without implicit writes", async () => {
  await using f = await memoryFixture({ enabled: false, path: "~/custom" })
  const status = await f.run(f.store.status())
  expect(status.enabled).toBe(false)
  expect(status.root).toStartWith(path.join(await fs.realpath(f.directory), "custom"))
  await expect(f.run(f.store.write({ id: "note", content: note() }))).rejects.toThrow("disabled")
  expect(await fs.stat(path.join(f.directory, "custom")).then(() => true, () => false)).toBe(false)
  await using relative = await memoryFixture({ path: "notes" })
  expect((await relative.run(relative.store.status())).root).toStartWith(path.join(await fs.realpath(relative.workspace), "notes"))
})

test("R5-A distinguishes unsafe or unavailable storage from an empty workspace", async () => {
  await using f = await memoryFixture()
  const status = await f.run(f.store.status())
  await fs.mkdir(path.dirname(status.root), { recursive: true })
  await fs.writeFile(status.root, "not a directory")
  await expect(f.run(f.store.list({}))).rejects.toThrow()
})

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("R5-A reports permission-denied storage instead of an empty bundle", async () => {
  await using f = await memoryFixture()
  await f.run(f.store.write({ id: "saved", content: note() }))
  const root = (await f.run(f.store.status())).root
  await fs.chmod(root, 0)
  try {
    const result = await f.run(f.store.list({}).pipe(Effect.flip))
    expect(result.code).toBe("Unavailable")
  } finally {
    await fs.chmod(root, 0o700)
  }
  expect((await f.run(f.store.read({ id: "saved" }))).content).toBe(note())
})
