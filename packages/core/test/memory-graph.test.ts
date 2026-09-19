import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { memoryFixture, note } from "./lib/memory"

test("R5-D exports deterministic offline graph edges without executing or fetching concept content", async () => {
  await using f = await memoryFixture()
  const repository = (await f.run(f.store.status())).repository!.id
  const content = note(`[Related](../b.md) [Root][r]\n\n[r]: /repository/${repository}/b.md\n\n\`[Code](../ghost.md)\`\n\n\`\`\`md\n[Fenced](../ghost.md)\n\`\`\`\n\n[Dangling](missing.md)\n<script>globalThis.injected=true</script>`, 'type: Guide\ntitle: "</script><img src=x onerror=alert(1)>"')
  await f.run(f.store.write({ id: "notes/a", content }))
  await f.run(f.store.write({ id: "b", content: note() }))
  const before = await f.run(f.store.read({ id: "notes/a" }))
  const graph = await f.run(f.store.graph())
  expect(graph.nodes).toBe(2)
  expect(graph.edges).toBe(1)
  expect(graph.warnings).toEqual([{ id: "notes/a", code: "dangling-link" }])
  const html = await fs.readFile(graph.path, "utf8")
  expect(html).not.toContain("<img src=x")
  expect(html).not.toContain("<script>globalThis.injected")
  expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=["']https?:/)
  expect((await f.run(f.store.graph())).digest).toBe(graph.digest)
  expect(await f.run(f.store.read({ id: "notes/a" }))).toEqual(before)
})

test("R5-D knowledge-only exports keep memory-root link identities consistent with repository exports", async () => {
  await using f = await memoryFixture()
  await f.run(f.store.write({ scope: "knowledge", id: "a", content: note("[Shared target](/knowledge/b.md)") }))
  await f.run(f.store.write({ scope: "knowledge", id: "b", content: note() }))
  const graph = await f.run(f.store.graph({ scope: "knowledge" }))
  expect(graph.nodes).toBe(2)
  expect(graph.edges).toBe(1)
  expect(graph.warnings).toEqual([])
  expect(await fs.readFile(graph.path, "utf8")).toContain('"id":"knowledge/b"')
})

test("R5-D exports an explicit empty graph", async () => {
  await using f = await memoryFixture()
  const graph = await f.run(f.store.graph())
  expect(graph).toMatchObject({ nodes: 0, edges: 0, warnings: [] })
  expect(await fs.readFile(graph.path, "utf8")).toContain("No knowledge saved yet")
})
