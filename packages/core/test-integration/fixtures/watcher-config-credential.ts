import { closeSync, writeSync } from "node:fs"
import { Context, Effect, Layer, Logger } from "effect"
import { Config } from "@ycoding-ai/core/config"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Integration } from "@ycoding-ai/core/integration"

function record(event: string, fields: Record<string, unknown> = {}) {
  const bytes = Buffer.from(JSON.stringify({ event, ...fields }) + "\n")
  let offset = 0
  while (offset < bytes.length) offset += writeSync(3, bytes, offset)
}

const counts = { started: 0, stopped: 0, fallback: 0 }
const logger = Logger.layer([
  Logger.make((options) => {
    const message = Array.isArray(options.message) ? options.message[0] : options.message
    if (message === "watcher started") counts.started++
    if (message === "watcher stopped") counts.stopped++
    if (message === "native watcher failed; using recursive fallback") counts.fallback++
  }),
])
const overrides = [[Database.node, Database.configured({ path: process.env.YCODING_DB })]] as const

process.once("beforeExit", () => {
  record("before-exit", counts)
  closeSync(3)
})

await Effect.runPromise(
  Effect.gen(function* () {
    const seeded = yield* Layer.build(AppNodeBuilder.build(LayerNode.group([Credential.node]), overrides))
    yield* Context.get(seeded, Credential.Service).create({
      integrationID: Integration.ID.make("synthetic-watcher"),
      label: "synthetic-watcher-profile",
      value: { type: "key", key: "synthetic-watcher-key" },
    })
  }).pipe(Effect.scoped, Effect.provide(logger)),
)
record("seeded")

await Effect.runPromise(
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AppNodeBuilder.build(LayerNode.group([Config.globalNode, Credential.node]), overrides),
    )
    const snapshot = yield* Context.get(context, Config.GlobalService).snapshot()
    const stored = yield* Context.get(context, Credential.Service).all()
    record("credential-resolved", {
      documents: snapshot.entries.length,
      diagnostics: snapshot.diagnostics.length,
      defaultAgent: snapshot.entries[0]?.info.default_agent,
      profiles: stored.map((item) => item.label),
    })
  }).pipe(Effect.scoped, Effect.provide(logger)),
)
record("scope-closed", counts)
