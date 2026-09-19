import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { MemoryTool } from "@ycoding-ai/core/tool/memory"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Memory } from "@ycoding-ai/core/memory"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionV2 } from "@ycoding-ai/core/session"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { Image } from "@ycoding-ai/core/image"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
import { imagePassthrough } from "./lib/image"
import { memoryFixture, note } from "./lib/memory"

interface GuardrailCall {
  readonly action: string
  readonly operation?: string
  readonly memoryAction?: string
  readonly resources: readonly string[]
}

interface State {
  readonly denyActions: string[]
  readonly denyResources: string[]
  guardDenied: boolean
  readonly actions: string[]
  readonly resources: string[]
  readonly guardrails: GuardrailCall[]
  reservations: number
  releases: number
}

function harness(f: Awaited<ReturnType<typeof memoryFixture>>, state: State) {
  const permissions = Layer.mock(PermissionV2.Service, {
    evaluateEffective: () => Effect.succeed("ask" as const),
    assert: (input) =>
      Effect.gen(function* () {
        state.actions.push(input.action)
        state.resources.push(...input.resources)
        if (state.denyActions.includes(input.action))
          return yield* new PermissionV2.BlockedError({
            rules: [],
            permission: input.action,
            resources: input.resources,
          })
        if (input.resources.some((resource) => state.denyResources.some((denied) => resource.includes(denied))))
          return yield* new PermissionV2.BlockedError({
            rules: [],
            permission: input.action,
            resources: input.resources,
          })
      }),
  })
  const guardrails = Layer.mock(SessionGuardrail.Service, {
    assert: (input) =>
      Effect.gen(function* () {
        const metadata = (input.metadata ?? {}) as Record<string, unknown>
        state.guardrails.push({
          action: input.action,
          ...(typeof metadata.operation === "string" ? { operation: metadata.operation } : {}),
          ...(typeof metadata.memoryAction === "string" ? { memoryAction: metadata.memoryAction } : {}),
          resources: input.resources,
        })
        if (state.guardDenied)
          return yield* new SessionGuardrail.DeclinedError({
            requestID: Guardrail.RequestID.make("grq_memory_safety"),
          })
        state.reservations++
        return { release: Effect.sync(() => void state.releases++) }
      }),
  })
  const plugin = makeLocationNode({
    name: "test/memory-safety-plugin",
    layer: Layer.effectDiscard(registerToolPlugin(MemoryTool.Plugin)),
    deps: [Memory.node, ToolRegistry.toolsNode, PermissionV2.node, SessionGuardrail.node],
  })
  return AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, plugin]), [
    [Memory.node, Layer.succeed(Memory.Service, f.store)],
    [PermissionV2.node, permissions],
    [SessionGuardrail.node, guardrails],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Image.node, imagePassthrough],
  ])
}

function tool(f: Awaited<ReturnType<typeof memoryFixture>>) {
  const state: State = {
    denyActions: [],
    denyResources: [],
    guardDenied: false,
    actions: [],
    resources: [],
    guardrails: [],
    reservations: 0,
    releases: 0,
  }
  const layer = harness(f, state)
  const call = (input: Record<string, unknown>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        return yield* executeTool(registry, {
          sessionID: SessionV2.ID.make("ses_memory_safety"),
          ...toolIdentity,
          call: { type: "tool-call", id: `call-${state.actions.length}`, name: "memory", input },
        })
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  return { state, call }
}

/** Writes one concept and removes its Markdown, leaving a generated index with no live concept. */
async function obsoleteIndex(f: Awaited<ReturnType<typeof memoryFixture>>) {
  const root = (await f.run(f.store.status())).root
  await f.run(f.store.write({ id: "old/entry", content: note() }))
  await fs.unlink(path.join(root, "old/entry.md"))
  return path.join(root, "old/index.md")
}

test("R8-F blocks vacuum apply without write authority and without a guardrail reservation", async () => {
  await using f = await memoryFixture()
  const obsolete = await obsoleteIndex(f)
  const preview = await f.run(f.store.vacuum({}))
  const { state, call } = tool(f)
  state.denyActions.push("memory_write")
  expect((await call({ action: "vacuum", dryRun: false, expectedDigest: preview.digest })).type).toBe("error")
  expect(await fs.stat(obsolete).then(() => true, () => false)).toBe(true)
  expect(state.actions).toContain("memory_write")
  state.denyActions.length = 0
  state.guardDenied = true
  expect((await call({ action: "vacuum", dryRun: false, expectedDigest: preview.digest })).type).toBe("error")
  expect(await fs.stat(obsolete).then(() => true, () => false)).toBe(true)
  expect(state.guardrails.some((entry) => entry.memoryAction === "vacuum" && entry.operation === "remove")).toBe(true)
})

test("R8-F keeps vacuum preview read-only and unguarded", async () => {
  await using f = await memoryFixture()
  const obsolete = await obsoleteIndex(f)
  const { state, call } = tool(f)
  expect((await call({ action: "vacuum" })).type).toBe("text")
  expect(state.guardrails).toEqual([])
  expect(state.actions).toContain("memory_read")
  expect(state.actions).not.toContain("memory_write")
  expect(await fs.stat(obsolete).then(() => true, () => false)).toBe(true)
})

test("R8-F uses remove semantics for destructive memory mutations", async () => {
  await using f = await memoryFixture()
  const saved = await f.run(f.store.write({ id: "entry", content: note() }))
  const { state, call } = tool(f)
  expect((await call({ action: "write", id: "second", content: note("Second") })).type).toBe("text")
  const second = await f.run(f.store.read({ id: "second" }))
  expect((await call({ action: "delete", id: "second", expectedDigest: second.digest })).type).toBe("text")
  const entry = (await f.run(f.store.trash({}))).entries[0]!
  expect((await call({ action: "restore", trashID: entry.trashID, expectedDigest: entry.digest })).type).toBe("text")
  expect((await call({ action: "purge", trashID: `trash_${"0".repeat(64)}`, expectedDigest: "0".repeat(64) })).type).toBe("error")
  expect((await call({ action: "vacuum", dryRun: false, expectedDigest: "0".repeat(64) })).type).toBe("error")
  const operation = (memoryAction: string) =>
    state.guardrails.find((entry) => entry.memoryAction === memoryAction)?.operation
  expect(operation("write")).toBe("write")
  expect(operation("delete")).toBe("remove")
  expect(operation("restore")).toBe("write")
  expect(operation("purge")).toBe("remove")
  expect(operation("vacuum")).toBe("remove")
  expect(state.releases).toBe(state.reservations)
  expect((await f.run(f.store.read({ id: "entry" }))).digest).toBe(saved.digest)
})

test("R8-F blocks denied writes and declined mutations with zero memory effects", async () => {
  await using f = await memoryFixture()
  const { state, call } = tool(f)
  state.denyActions.push("memory_write")
  expect((await call({ action: "write", id: "denied", content: note() })).type).toBe("error")
  expect((await f.run(f.store.list({}))).total).toBe(0)
  state.denyActions.length = 0
  state.guardDenied = true
  expect((await call({ action: "write", id: "declined", content: note() })).type).toBe("error")
  expect((await f.run(f.store.list({}))).total).toBe(0)
  expect(state.guardrails.length).toBe(1)
  state.guardDenied = false
  expect((await call({ action: "write", id: "allowed", content: note() })).type).toBe("text")
  expect((await f.run(f.store.list({}))).concepts.map((concept) => concept.id)).toEqual(["allowed"])
  expect(state.releases).toBe(state.reservations)
})

test("R8-F requires knowledge read authority only for repository graph export", async () => {
  await using f = await memoryFixture()
  const { state, call } = tool(f)
  const knowledgeRoot = (await f.run(f.store.status())).knowledgeRoot
  state.denyResources.push(knowledgeRoot)
  expect((await call({ action: "write", id: "guide", content: note() })).type).toBe("text")
  expect((await call({ action: "read", id: "guide" })).type).toBe("text")
  expect(state.resources.filter((resource) => resource === knowledgeRoot)).toEqual([])
  expect((await call({ action: "graph" })).type).toBe("error")
  expect(state.resources).toContain(knowledgeRoot)
  expect((await f.run(f.store.status())).scope).toBe("repository")
  expect((await f.run(f.store.read({ id: "guide" }))).content).toBe(note())
})

test("R8-F refuses a repository trash ID in a knowledge-scoped restore", async () => {
  await using f = await memoryFixture()
  const saved = await f.run(f.store.write({ id: "entry", content: note() }))
  const removed = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
  const { call } = tool(f)
  expect(
    (await call({ action: "restore", scope: "knowledge", trashID: removed.trashID, expectedDigest: removed.digest }))
      .type,
  ).toBe("error")
  expect((await f.run(f.store.trash({}))).total).toBe(1)
  expect(await f.run(f.store.restore({ trashID: removed.trashID, expectedDigest: removed.digest }))).toMatchObject({
    id: "entry",
  })
})

test("R8-F bounds malformed trash receipts instead of growing diagnostics without limit", async () => {
  await using f = await memoryFixture({ max_concepts: 4 })
  const root = (await f.run(f.store.status())).root
  await fs.mkdir(path.join(root, "trash"), { recursive: true })
  for (let index = 0; index < 40; index++)
    await fs.writeFile(
      path.join(root, "trash", `trash_${index.toString(16).padStart(64, "0")}.json`),
      "{ malformed receipt",
    )
  const listing = await f.run(f.store.trash({}))
  expect(listing.entries).toEqual([])
  expect(listing.warnings.length).toBeLessThanOrEqual(f.settings.max_concepts)
  expect(listing.warnings).toContainEqual(expect.objectContaining({ code: "trash-limit" }))
  const remaining = (await fs.readdir(path.join(root, "trash"))).filter((name) => name.endsWith(".json"))
  expect(remaining).toHaveLength(40)
})

test("R8-F lists valid trash alongside bounded malformed receipts and preserves their bytes", async () => {
  await using f = await memoryFixture({ max_concepts: 16 })
  const saved = await f.run(f.store.write({ id: "entry", content: note() }))
  const removed = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
  const directory = path.join((await f.run(f.store.status())).root, "trash")
  for (let index = 0; index < 3; index++)
    await fs.writeFile(
      path.join(directory, `trash_${index.toString(16).padStart(64, "0")}.json`),
      "{ malformed receipt",
    )
  const listing = await f.run(f.store.trash({}))
  expect(listing.entries).toEqual([expect.objectContaining({ id: "entry", trashID: removed.trashID })])
  expect(listing.total).toBe(1)
  expect(listing.warnings).toHaveLength(3)
  expect(listing.warnings.every((warning) => warning.code === "unreadable-trash")).toBe(true)
  // One valid receipt (.md + .json) plus three preserved malformed receipts.
  expect(await fs.readdir(directory)).toHaveLength(5)
  expect(await fs.readFile(path.join(directory, `${removed.trashID}.md`), "utf8")).toBe(note())
})

test("R8-F does not charge trash capacity for an identical repeated deletion", async () => {
  await using f = await memoryFixture({ max_concepts: 1 })
  const saved = await f.run(f.store.write({ id: "entry", content: note() }))
  const first = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
  const recreated = await f.run(f.store.write({ id: "entry", content: note() }))
  const second = await f.run(f.store.delete({ id: "entry", expectedDigest: recreated.digest }))
  expect(second).toMatchObject({ id: "entry", trashID: first.trashID, digest: recreated.digest })
  expect((await f.run(f.store.list({}))).total).toBe(0)
  const listing = await f.run(f.store.trash({}))
  expect(listing.total).toBe(1)
  expect(listing.entries[0]).toMatchObject({ trashID: first.trashID })
  await f.run(f.store.restore({ trashID: second.trashID, expectedDigest: second.digest }))
  expect((await f.run(f.store.read({ id: "entry" }))).content).toBe(note())
})

test("R8-F still refuses a new distinct deletion when the bounded trash inventory is at capacity", async () => {
  await using f = await memoryFixture({ max_concepts: 1 })
  const first = await f.run(f.store.write({ id: "first", content: note() }))
  const removed = await f.run(f.store.delete({ id: "first", expectedDigest: first.digest }))
  const next = await f.run(f.store.write({ id: "next", content: note("Distinct next entry") }))
  await expect(f.run(f.store.delete({ id: "next", expectedDigest: next.digest }))).rejects.toThrow()
  expect((await f.run(f.store.read({ id: "next" }))).digest).toBe(next.digest)
  expect((await f.run(f.store.trash({}))).total).toBe(1)
  await f.run(f.store.purge({ trashID: removed.trashID, expectedDigest: removed.digest }))
  await f.run(f.store.delete({ id: "next", expectedDigest: next.digest }))
  expect((await f.run(f.store.trash({}))).total).toBe(1)
})

test("R8-F refuses a new deletion when a truncated diagnostic hides the full trash inventory", async () => {
  await using f = await memoryFixture({ max_concepts: 1 })
  const root = (await f.run(f.store.status())).root
  const first = await f.run(f.store.write({ id: "first", content: note("Archive first") }))
  await f.run(f.store.delete({ id: "first", expectedDigest: first.digest }))
  const directory = path.join(root, "trash")
  // Sorts before every real receipt, so an unreadable one exhausts the diagnostic budget first.
  await fs.writeFile(
    path.join(directory, `trash_${"0".repeat(64)}.json`),
    "{ malformed receipt",
  )
  const listing = await f.run(f.store.trash({}))
  expect(listing.entries).toEqual([])
  expect(listing.warnings).toContainEqual(expect.objectContaining({ code: "trash-limit" }))
  const next = await f.run(f.store.write({ id: "next", content: note("Archive next") }))
  await expect(f.run(f.store.delete({ id: "next", expectedDigest: next.digest }))).rejects.toThrow()
  expect((await f.run(f.store.read({ id: "next" }))).digest).toBe(next.digest)
  const archives = (await fs.readdir(directory)).filter((name) => name.endsWith(".md"))
  expect(archives).toHaveLength(1)
})

test("R8-F refuses a new deletion when a lowered byte limit truncates the trash inventory", async () => {
  await using f = await memoryFixture({ max_bundle_bytes: 4000 })
  const root = (await f.run(f.store.status())).root
  const archived = await f.run(f.store.write({ id: "archived", content: note("Archive body ".repeat(4)) }))
  const removed = await f.run(f.store.delete({ id: "archived", expectedDigest: archived.digest }))
  const archivedBytes = (await fs.stat(path.join(root, "trash", `${removed.trashID}.md`))).size
  const small = "---\ntype: T\ntitle: Small\n---\nB\n"
  // A limit below the existing archive but above the next concept truncates the inventory.
  f.settings.max_bundle_bytes = 50
  expect(archivedBytes).toBeGreaterThan(f.settings.max_bundle_bytes)
  expect(Buffer.byteLength(small)).toBeLessThan(f.settings.max_bundle_bytes)
  const listing = await f.run(f.store.trash({}))
  expect(listing.entries).toEqual([])
  expect(listing.warnings).toContainEqual(expect.objectContaining({ code: "trash-limit" }))
  const next = await f.run(f.store.write({ id: "next", content: small }))
  await expect(f.run(f.store.delete({ id: "next", expectedDigest: next.digest }))).rejects.toThrow()
  expect((await f.run(f.store.read({ id: "next" }))).digest).toBe(next.digest)
  expect((await fs.readdir(path.join(root, "trash"))).filter((name) => name.endsWith(".md"))).toHaveLength(1)
})

test("R8-F refuses to archive over a receipt whose metadata no longer identifies the original concept", async () => {
  await using f = await memoryFixture()
  const root = (await f.run(f.store.status())).root
  const saved = await f.run(f.store.write({ id: "entry", content: note() }))
  const removed = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
  const metadata = path.join(root, "trash", `${removed.trashID}.json`)
  await fs.rm(metadata)
  const recreated = await f.run(f.store.write({ id: "entry", content: note() }))
  await expect(f.run(f.store.delete({ id: "entry", expectedDigest: recreated.digest }))).rejects.toThrow()
  // The live concept survives, and its identical archived bytes remain on disk.
  expect((await f.run(f.store.read({ id: "entry" }))).content).toBe(note())
  expect(await fs.readFile(path.join(root, "trash", `${removed.trashID}.md`), "utf8")).toBe(note())
  // Restoring the receipt is the only remaining recovery path once the identity is repaired.
  await fs.writeFile(metadata, JSON.stringify({ version: 1, id: "entry" }) + "\n")
  await expect(f.run(f.store.restore({ trashID: removed.trashID, expectedDigest: removed.digest }))).rejects.toThrow()
  await f.run(f.store.delete({ id: "entry", expectedDigest: recreated.digest }))
  await f.run(f.store.restore({ trashID: removed.trashID, expectedDigest: removed.digest }))
  expect((await f.run(f.store.read({ id: "entry" }))).content).toBe(note())
})

test("R8-F refuses to archive over a receipt whose metadata names a different concept", async () => {
  await using f = await memoryFixture()
  const root = (await f.run(f.store.status())).root
  const saved = await f.run(f.store.write({ id: "entry", content: note() }))
  const removed = await f.run(f.store.delete({ id: "entry", expectedDigest: saved.digest }))
  const metadata = path.join(root, "trash", `${removed.trashID}.json`)
  await fs.writeFile(metadata, JSON.stringify({ version: 1, id: "different" }) + "\n")
  const recreated = await f.run(f.store.write({ id: "entry", content: note() }))
  await expect(f.run(f.store.delete({ id: "entry", expectedDigest: recreated.digest }))).rejects.toThrow()
  expect((await f.run(f.store.read({ id: "entry" }))).content).toBe(note())
  expect(await fs.readFile(path.join(root, "trash", `${removed.trashID}.md`), "utf8")).toBe(note())
})
