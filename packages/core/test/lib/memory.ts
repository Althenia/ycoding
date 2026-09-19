import { expect } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, ManagedRuntime, Schema } from "effect"
import { Config } from "@ycoding-ai/core/config"
import { Git } from "@ycoding-ai/core/git"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"

export const note = (body = "Use the local build command.", metadata = "type: Decision\ntitle: Build guide") =>
  `---\n${metadata}\n---\n${body}\n`

export async function memoryFixture(settings: Record<string, unknown> = {}) {
  const decoded = Schema.decodeUnknownSync(Config.Info)({ memory: settings })
  // Observe the missing public configuration boundary before importing the new implementation.
  expect(decoded).toHaveProperty("memory")
  const { ConfigMemory } = await import("@ycoding-ai/core/config/memory")
  const { Memory } = await import("@ycoding-ai/core/memory")
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-memory-"))
  const workspace = path.join(directory, "workspace")
  await fs.mkdir(workspace)
  await $`git init -q ${workspace}`.quiet()
  const runtime = ManagedRuntime.make(LayerNode.compile(Git.node))
  const git = await runtime.runPromise(Git.Service)
  const resolved = ConfigMemory.resolve([Schema.decodeUnknownSync(ConfigMemory.Info)(settings)])
  const make = (selected = workspace) => Memory.make({
    directory: selected,
    home: directory,
    data: path.join(directory, "data"),
    git,
    settings: () => Effect.succeed(resolved),
  })
  return {
    directory, workspace, settings: resolved, make, store: make(), run: Effect.runPromise,
    async [Symbol.asyncDispose]() { await runtime.dispose(); await fs.rm(directory, { recursive: true, force: true }) },
  }
}
