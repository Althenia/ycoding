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
  expect((await f.run(f.store.search({ query: "cache", tag: "runtime", limit: 1 }))).hits.map((x) => x.id)).toEqual([
    "a",
  ])
  expect((await f.run(f.store.search({ query: "CAFÉ" }))).hits.map((x) => x.id)).toEqual(["c"])
  expect((await f.run(f.store.search({ query: "absent" }))).hits).toEqual([])
  expect(await f.run(f.store.list({ offset: 1, limit: 1 }))).toMatchObject({ total: 3, concepts: [{ id: "b" }] })
  for (const input of [{ query: "" }, { query: "x", limit: 51 }])
    await expect(f.run(f.store.search(input))).rejects.toThrow()
  expect((await f.run(f.store.search({ query: "x".repeat(1024) }))).hits).toEqual([])
  for (const query of [" ".repeat(1024) + "x", "   "])
    await expect(f.run(f.store.search({ query }))).rejects.toThrow("Search query")
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
  expect((await malformed.run(malformed.store.search({ query: "none" }))).warnings).toContainEqual({
    id: "broken",
    code: "invalid-concept",
  })
})

test("R9 scores BM25 with fixed field boosts and whole-collection statistics before filters", async () => {
  await using f = await memoryFixture()
  await f.run(f.store.write({ id: "d1", content: note("x y", "type: T\ntitle: kappa") }))
  await f.run(f.store.write({ id: "d2", content: note("x y", "type: T\ntitle: Other\ndescription: kappa") }))
  await f.run(f.store.write({ id: "d3", content: note("kappa y", "type: G\ntitle: Other") }))
  const idf = Math.log(1 + (3 - 3 + 0.5) / (3 + 0.5))
  const titleScore = idf * 4 * (2.2 / (1 + 1.2 * (0.25 + (0.75 * 2) / 2)))
  const descriptionScore = idf * 2 * (2.2 / (1 + 1.2 * (0.25 + (0.75 * 2) / (4 / 3))))
  const bodyScore = idf * 1 * (2.2 / (1 + 1.2 * (0.25 + (0.75 * 2) / 2)))
  const result = await f.run(f.store.search({ query: "kappa" }))
  expect(result.hits.map((hit) => hit.id)).toEqual(["d1", "d2", "d3"])
  expect(result.hits[0]!.score).toBeCloseTo(titleScore, 10)
  expect(result.hits[1]!.score).toBeCloseTo(descriptionScore, 10)
  expect(result.hits[2]!.score).toBeCloseTo(bodyScore, 10)
  const filtered = await f.run(f.store.search({ query: "kappa", type: "G" }))
  expect(filtered.hits.map((hit) => hit.id)).toEqual(["d3"])
  expect(filtered.hits[0]!.score).toBeCloseTo(bodyScore, 10)
  expect((await f.run(f.store.search({ query: "kappa", type: "g" }))).hits).toEqual([])
  expect(await f.run(f.store.search({ query: "kappa KAPPA kappa" }))).toEqual(result)
})

test("R9 normalizes empty fields without NaN and includes them in field-length averages", async () => {
  await using empty = await memoryFixture()
  await empty.run(empty.store.write({ id: "e1", content: note("", "type: T\ntitle: kappa") }))
  await empty.run(empty.store.write({ id: "e2", content: note("", "type: T\ntitle: Other") }))
  const metadataHits = (await empty.run(empty.store.search({ query: "kappa" }))).hits
  expect(metadataHits.map((hit) => hit.id)).toEqual(["e1"])
  expect(Number.isFinite(metadataHits[0]!.score)).toBe(true)
  expect(metadataHits[0]!.score).toBeCloseTo(4 * Math.log(2), 10)
  expect(metadataHits[0]!.snippet).toBe("")
  await using mixed = await memoryFixture()
  await mixed.run(mixed.store.write({ id: "m1", content: note("kappa", "type: T") }))
  await mixed.run(mixed.store.write({ id: "m2", content: note("", "type: T") }))
  const bodyHits = (await mixed.run(mixed.store.search({ query: "kappa" }))).hits
  expect(bodyHits.map((hit) => hit.id)).toEqual(["m1"])
  expect(bodyHits[0]!.score).toBeCloseTo(Math.log(2) * (2.2 / (1 + 1.2 * (0.25 + (0.75 * 1) / 0.5))), 10)
})

test("R9 ranks rarer terms, higher term frequency, and shorter fields first with stable ID ties", async () => {
  await using rarity = await memoryFixture()
  for (const [id, body] of [
    ["n1", "common pad"],
    ["n2", "rare pad"],
    ["n3", "common pad"],
    ["n4", "common pad"],
  ])
    await rarity.run(rarity.store.write({ id, content: note(body, "type: T") }))
  expect((await rarity.run(rarity.store.search({ query: "common rare" }))).hits.map((hit) => hit.id)).toEqual([
    "n2",
    "n1",
    "n3",
    "n4",
  ])
  const permuted = await Promise.all(
    ["common rare pad", "pad rare common", "rare pad common PAD"].map((query) =>
      rarity.run(rarity.store.search({ query })),
    ),
  )
  expect(permuted[1]).toEqual(permuted[0])
  expect(permuted[2]).toEqual(permuted[0])
  await using frequency = await memoryFixture()
  for (const [id, body] of [
    ["t1", "alpha beta"],
    ["t2", "alpha alpha"],
    ["l1", "alpha b c d e f g h"],
    ["l2", "alpha b"],
  ])
    await frequency.run(frequency.store.write({ id, content: note(body, "type: T") }))
  const hits = (await frequency.run(frequency.store.search({ query: "alpha" }))).hits
  expect(hits.map((hit) => hit.id)).toEqual(["t2", "l2", "t1", "l1"])
  expect(hits[1]!.score).toBe(hits[2]!.score)
})

test("R9 applies the title/id boost above the shared type, tag, and description boost without filter-scoped statistics", async () => {
  await using f = await memoryFixture()
  await f.run(f.store.write({ id: "kappa", content: note("x", "type: T\ntitle: Other") }))
  await f.run(f.store.write({ id: "q1", content: note("x", "type: T\ntitle: Kappa") }))
  await f.run(f.store.write({ id: "r-desc", content: note("x", "type: T\ntitle: Other\ndescription: kappa") }))
  await f.run(f.store.write({ id: "s-tag", content: note("x", "type: T\ntitle: Other\ntags: [kappa]") }))
  await f.run(f.store.write({ id: "t-type", content: note("x", "type: Kappa T\ntitle: Other") }))
  const hits = (await f.run(f.store.search({ query: "kappa" }))).hits
  expect(hits.map((hit) => hit.id)).toEqual(["kappa", "q1", "r-desc", "s-tag", "t-type"])
  expect(hits[1]!.score).toBeCloseTo(hits[0]!.score, 10)
  expect(hits[1]!.score).toBeGreaterThan(hits[2]!.score)
  expect(hits[3]!.score).toBeCloseTo(hits[2]!.score, 10)
  expect(hits[4]!.score).toBeCloseTo(hits[2]!.score, 10)
  const tagged = (await f.run(f.store.search({ query: "kappa", tag: "kappa" }))).hits
  expect(tagged.map((hit) => hit.id)).toEqual(["s-tag"])
  expect(tagged[0]!.score).toBeCloseTo(hits[3]!.score, 10)
  expect((await f.run(f.store.search({ query: "kappa", tag: "Kappa" }))).hits).toEqual([])
})

test("R9 matches distinct whole tokens with OR semantics and no prefix, phrase, or Boolean operators", async () => {
  await using f = await memoryFixture()
  await f.run(f.store.write({ id: "p1", content: note("build-cache don't snake_case end.", "type: T") }))
  await f.run(f.store.write({ id: "p2", content: note("cache", "type: T") }))
  const ids = async (query: string) => (await f.run(f.store.search({ query }))).hits.map((hit) => hit.id).sort()
  expect(await ids("cach")).toEqual([])
  expect(await ids("snake")).toEqual([])
  expect(await ids("snake_case")).toEqual(["p1"])
  expect(await ids("don")).toEqual(["p1"])
  expect(await ids("build-cache")).toEqual(["p1", "p2"])
  expect(await ids('"cache build"')).toEqual(["p1", "p2"])
  expect(await ids("cache AND absent")).toEqual(["p1", "p2"])
  expect(await ids("NOT cache")).toEqual(["p1", "p2"])
  expect(await ids("!!! ???")).toEqual([])
})

test("R9 matches NFC-equivalent text without accent folding and keeps source bytes", async () => {
  await using f = await memoryFixture()
  const decomposed = note("cafe\u0301 dec", "type: T")
  await f.run(f.store.write({ id: "n-dec", content: decomposed }))
  await f.run(f.store.write({ id: "n-pre", content: note("caf\u00e9 pre", "type: T") }))
  await f.run(f.store.write({ id: "n-plain", content: note("cafe plain", "type: T") }))
  const search = (query: string) => f.run(f.store.search({ query }))
  expect((await search("caf\u00e9")).hits.map((hit) => hit.id).sort()).toEqual(["n-dec", "n-pre"])
  expect((await search("cafe\u0301")).hits.map((hit) => hit.id).sort()).toEqual(["n-dec", "n-pre"])
  expect((await search("cafe")).hits.map((hit) => hit.id)).toEqual(["n-plain"])
  expect((await search("CAF\u00c9")).hits.map((hit) => hit.id).sort()).toEqual(["n-dec", "n-pre"])
  expect((await search("caf\u00e9")).hits.find((hit) => hit.id === "n-dec")?.snippet).toContain("cafe\u0301")
  expect((await f.run(f.store.read({ id: "n-dec" }))).content).toBe(decomposed)
  await f.run(f.store.write({ id: "n-caron", content: note("J\u030C caron", "type: T") }))
  await f.run(f.store.write({ id: "n-greek", content: note("\u039F\u0394\u039F\u03A3 greek", "type: T") }))
  expect((await search("\u01F0")).hits.map((hit) => hit.id)).toEqual(["n-caron"])
  expect((await search("j\u030C")).hits.map((hit) => hit.id)).toEqual(["n-caron"])
  expect((await search("j")).hits).toEqual([])
  expect((await search("\u03BF\u03B4\u03BF\u03C2")).hits.map((hit) => hit.id)).toEqual(["n-greek"])
  expect((await search("\u039F\u0394\u039F\u03A3")).hits.map((hit) => hit.id)).toEqual(["n-greek"])
  expect((await search("\u03BF\u03B4\u03BF\u03C3")).hits).toEqual([])
  expect((await search("\u03BF\u03B4\u03BF\u03C2")).hits[0]?.snippet).toContain("\u039F\u0394\u039F\u03A3")
})

test("R9 aligns bounded snippets to whole-token matches in the original surrogate-safe text", async () => {
  await using f = await memoryFixture()
  const contents = {
    "s-cat": note(`concatenate ${"filler ".repeat(120)}cat end`, "type: T"),
    "s-dot": note(`${"\u0130".repeat(100)} pin tail`, "type: T"),
    "s-emoji": note(`${"\u{1F600}".repeat(200)} needle ${"\u{1F600}".repeat(200)}`, "type: T"),
  }
  for (const [id, content] of Object.entries(contents)) await f.run(f.store.write({ id, content }))
  const snippet = async (query: string, id: keyof typeof contents) => {
    const hit = (await f.run(f.store.search({ query }))).hits.find((item) => item.id === id)
    expect(hit).toBeDefined()
    expect(hit!.snippet.length).toBeLessThanOrEqual(320)
    expect(hit!.snippet.isWellFormed()).toBe(true)
    expect(contents[id]).toContain(hit!.snippet)
    return hit!.snippet
  }
  const cat = await snippet("cat", "s-cat")
  expect(cat).toMatch(/(?:^|[^\p{L}\p{N}_])cat(?:[^\p{L}\p{N}_]|$)/u)
  expect(cat).not.toContain("concatenate")
  expect(await snippet("pin", "s-dot")).toContain("pin")
  expect(await snippet("needle", "s-emoji")).toContain("needle")
})
