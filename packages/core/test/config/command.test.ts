import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, PubSub, Schema, Stream } from "effect"
import { Config as ConfigSchema } from "@ycoding-ai/schema/config"
import { Command } from "@ycoding-ai/core/command"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCommandPlugin } from "@ycoding-ai/core/config/plugin/command"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { emptyConfigLayer, emptyMcpLayer, testLocationLayer } from "../fixture/mcp"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Command.node, EventRuntime.node, FSUtil.node]), [
    [MCP.node, emptyMcpLayer],
    [Config.node, emptyConfigLayer],
    [Location.node, testLocationLayer],
  ]),
)
const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigCommandPlugin.Plugin", () => {
  it.live("loads inline and file-based commands in config order", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "commands", "nested"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "commands", "review.md"),
              `---
description: File review
agent: reviewer
model:
  providerID: anthropic
  model: claude
  variant: high
  profile: Work
subtask: true
---
Review files`,
            )
            await fs.writeFile(path.join(tmp.path, "commands", "nested", "docs.md"), "Write docs")
            await fs.writeFile(path.join(tmp.path, "commands", "empty.md"), "")
          })

          const command = yield* Command.Service
          const events = yield* EventRuntime.Service
          const update = yield* events.publish(ConfigSchema.Event.Updated, {})
          const updates = yield* PubSub.unbounded<typeof update>({ replay: 1 })
          yield* ConfigCommandPlugin.Plugin.effect(
            host({
              command: {
                list: () => Effect.die("unused command.list"),
                transform: command.transform,
                reload: command.reload,
              },
              event: { subscribe: () => Stream.fromPubSub(updates) },
            }),
          ).pipe(
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                reload: () => Effect.void,
                entries: () =>
                  Effect.succeed([
                    new Config.Document({
                      type: "document",
                      info: decode({ commands: { review: { template: "Inline review" } } }),
                    }),
                    new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path) }),
                  ]),
              }),
            ),
          )

          expect(yield* command.list()).toEqual([
            Command.Info.make({
              name: "review",
              template: "Review files",
              description: "File review",
              agent: Agent.ID.make("reviewer"),
              model: {
                providerID: Provider.ID.make("anthropic"),
                id: CatalogModel.ID.make("claude"),
                variant: CatalogModel.VariantID.make("high"),
                profile: "Work",
              },
              subtask: true,
              locations: [AbsolutePath.make(path.join(tmp.path, "commands", "review.md"))],
            }),
            Command.Info.make({
              name: "empty",
              template: "",
              locations: [AbsolutePath.make(path.join(tmp.path, "commands", "empty.md"))],
            }),
            Command.Info.make({
              name: "nested/docs",
              template: "Write docs",
              locations: [AbsolutePath.make(path.join(tmp.path, "commands", "nested", "docs.md"))],
            }),
          ])

          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "commands", "review.md"), "Review again"))
          yield* PubSub.publish(updates, update)
          for (let attempt = 0; attempt < 100; attempt++) {
            if ((yield* command.get("review"))?.template === "Review again") break
            yield* Effect.sleep("10 millis")
          }
          expect((yield* command.get("review"))?.template).toBe("Review again")
          expect((yield* command.get("review"))?.locations).toEqual([
            AbsolutePath.make(path.join(tmp.path, "commands", "review.md")),
          ])
        }),
      ),
    ),
  )
})
