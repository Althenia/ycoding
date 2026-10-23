import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { CoordinationSettings } from "../src/coordination-settings"
import { AbsolutePath } from "../src/schema"

test("user policy ignores project overrides and rereads central revocation and malformed configuration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-coordination-policy-"))
  const global = path.join(directory, "global")
  const project = path.join(directory, "project")
  await Promise.all([mkdir(global), mkdir(project)])
  await writeFile(path.join(project, "ycoding.json"), JSON.stringify({ coordination: { delegated_decisions: { enabled: false } } }))
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const settings = yield* CoordinationSettings.Service
      expect((yield* settings.read()).enabled).toBe(true)
      yield* Effect.promise(() => writeFile(path.join(global, "ycoding.json"), JSON.stringify({ coordination: { delegated_decisions: { enabled: false } } })))
      expect((yield* settings.read()).enabled).toBe(false)
      yield* Effect.promise(() => writeFile(path.join(global, "ycoding.jsonc"), JSON.stringify({ coordination: { delegated_decisions: { categories: ["question"] } } })))
      expect(yield* settings.read()).toMatchObject({ enabled: false, categories: ["question"] })
      yield* Effect.promise(() => writeFile(path.join(project, "ycoding.json"), JSON.stringify({ coordination: { delegated_decisions: { enabled: true } } })))
      expect((yield* settings.read()).enabled).toBe(false)
      yield* Effect.promise(() => writeFile(path.join(global, "ycoding.json"), JSON.stringify({ coordination: { delegated_decisions: { enabled: "yes" } } })))
      expect((yield* settings.read()).enabled).toBe(false)
      yield* Effect.promise(() => writeFile(path.join(global, "ycoding.json"), "{"))
      expect((yield* settings.read()).enabled).toBe(false)
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([CoordinationSettings.node]), [
      [Global.node, Global.layerWith({ home: directory, config: global, data: path.join(directory, "data") })],
      [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))],
    ])), Effect.scoped))
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30_000)
