import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Config } from "@ycoding-ai/core/config"
import { EventRuntime } from "@ycoding-ai/core/event"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { FileMutation } from "@ycoding-ai/core/file-mutation"
import { Global } from "@ycoding-ai/core/global"
import { Image } from "@ycoding-ai/core/image"
import { Location } from "@ycoding-ai/core/location"
import { LocationMutation } from "@ycoding-ai/core/location-mutation"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { Permission } from "@ycoding-ai/core/permission"
import { Ripgrep } from "@ycoding-ai/core/ripgrep"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionInstructions } from "@ycoding-ai/core/session/instructions"
import { GlobTool } from "@ycoding-ai/core/tool/glob"
import { GrepTool } from "@ycoding-ai/core/tool/grep"
import { McpTool } from "@ycoding-ai/core/tool/mcp"
import { ReadTool } from "@ycoding-ai/core/tool/read"
import { ReadToolFileSystem } from "@ycoding-ai/core/tool/read-filesystem"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { WriteTool } from "@ycoding-ai/core/tool/write"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { registerToolPlugin, settleTool, toolIdentity, waitForTool } from "./lib/tool"

const read = makeLocationNode({
  name: "test/unified-read",
  layer: Layer.effectDiscard(registerToolPlugin(ReadTool.Plugin)),
  deps: [
    ToolRegistry.toolsNode,
    ReadToolFileSystem.node,
    LocationMutation.node,
    Image.node,
    Permission.node,
    SessionInstructions.node,
    FSUtil.node,
    Location.node,
    Config.node,
  ],
})
const glob = makeLocationNode({
  name: "test/unified-glob",
  layer: Layer.effectDiscard(registerToolPlugin(GlobTool.Plugin)),
  deps: [ToolRegistry.toolsNode, FSUtil.node, Ripgrep.node, Location.node, Permission.node],
})
const grep = makeLocationNode({
  name: "test/unified-grep",
  layer: Layer.effectDiscard(registerToolPlugin(GrepTool.Plugin)),
  deps: [ToolRegistry.toolsNode, FSUtil.node, Ripgrep.node, Location.node, Permission.node, Global.node],
})
const write = makeLocationNode({
  name: "test/unified-write",
  layer: Layer.effectDiscard(registerToolPlugin(WriteTool.Plugin)),
  deps: [ToolRegistry.toolsNode, LocationMutation.node, FileMutation.node, Permission.node, SessionGuardrail.node],
})
const sessionID = Session.ID.make("ses_unified_fixture")
const it = testEffect(Layer.empty)

it.live("requires permission before nested writes and leaves rejected files untouched", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        for (const allowed of [false, true]) {
          const requested = yield* Deferred.make<Permission.AssertInput>()
          const reply = yield* Deferred.make<void>()
          const permissions = Layer.mock(Permission.Service, {
            assert: (input) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(requested, input)
                yield* Deferred.await(reply)
                if (!allowed)
                  return yield* new Permission.BlockedError({
                    rules: [],
                    permission: input.action,
                    resources: input.resources,
                  })
              }),
          })
          const layer = AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, write]), [
            [
              Location.node,
              Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
              ),
            ],
            [Permission.node, permissions],
            [Image.node, imagePassthrough],
            [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            [
              SessionGuardrail.node,
              Layer.mock(SessionGuardrail.Service, {
                reviewPolicy: { enabled: true, decideReviews: false, decideHardReviews: true },
                assert: () => Effect.succeed({ release: Effect.void }),
              }),
            ],
          ])
          yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const fiber = yield* settleTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "permission",
                name: "execute",
                input: { code: 'return await tools.write({path:"result.txt",content:"approved"})' },
              },
            }).pipe(Effect.forkScoped)
            const request = yield* Deferred.await(requested)
            expect(request.source).toEqual({ type: "tool", messageID: toolIdentity.messageID, callID: "permission" })
            expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "result.txt")).exists())).toBe(false)
            yield* Deferred.succeed(reply, undefined)
            const result = yield* Fiber.join(fiber)
            expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "result.txt")).exists())).toBe(allowed)
            expect(result.output?.structured).toMatchObject(
              allowed ? { toolCalls: [{ status: "completed" }] } : { error: true, toolCalls: [{ status: "error" }] },
            )
          }).pipe(Effect.provide(layer), Effect.timeout("2 seconds"))
        }
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("combines actual file tools with an MCP leaf and returns a reduced result", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "alpha.txt"), "needle\nsecond\n"))
        const mcp = Layer.mock(MCP.Service, {
          tools: () =>
            Effect.succeed([
              new MCP.Tool({
                server: MCP.ServerName.make("demo"),
                name: "search",
                codemode: false,
                description: "Search demo",
                inputSchema: { type: "object", properties: {} },
              }),
            ]),
          callTool: () =>
            Effect.succeed(
              new MCP.ToolResult({
                server: MCP.ServerName.make("demo"),
                tool: "search",
                isError: false,
                structured: { found: 7 },
                content: [],
              }),
            ),
        })
        const layer = AppNodeBuilder.build(
          LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, read, glob, grep, McpTool.node]),
          [
            [
              Location.node,
              Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
              ),
            ],
            [Permission.node, Layer.mock(Permission.Service, { assert: () => Effect.void })],
            [
              SessionGuardrail.node,
              Layer.mock(SessionGuardrail.Service, {
                reviewPolicy: { enabled: true, decideReviews: false, decideHardReviews: true },
                assert: () => Effect.succeed({ release: Effect.void }),
              }),
            ],
            [EventRuntime.node, Layer.mock(EventRuntime.Service, { subscribe: () => Stream.never })],
            [SessionInstructions.node, Layer.mock(SessionInstructions.Service, { load: () => Effect.void })],
            [MCP.node, mcp],
            [Image.node, imagePassthrough],
            [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ],
        )
        yield* Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          yield* waitForTool(registry, "demo_search")
          const materialized = yield* registry.materialize()
          const directDefinitions = materialized.definitions.filter((item) => item.name !== "execute")
          const directStart = performance.now()
          const direct = yield* Effect.forEach(
            [
              { name: "glob", input: { pattern: "*.txt" } },
              { name: "grep", input: { pattern: "needle" } },
              { name: "read", input: { path: "alpha.txt" } },
              { name: "demo_search", input: {} },
            ],
            (item, index) =>
              materialized.settle({
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: `direct-${index}`, ...item },
              }),
          )
          const directElapsedMs = performance.now() - directStart
          expect(direct.every((item) => item.result.type !== "error")).toBe(true)
          const executeStart = performance.now()
          const result = yield* settleTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "mixed",
              name: "execute",
              input: {
                code: 'const a = await tools.glob({pattern:"*.txt"}); const b = await tools.grep({pattern:"needle"}); const c = await tools.read({path:"alpha.txt"}); const d = await tools.demo.search({}); return {files:a.length,matches:b.length,contains:c.content.includes("needle"),found:d.found}',
              },
            },
          })
          const executeElapsedMs = performance.now() - executeStart
          const modelBytes = (value: typeof result.result) =>
            Buffer.byteLength(typeof value.value === "string" ? value.value : (JSON.stringify(value.value) ?? ""))
          console.log(
            JSON.stringify({
              directDefinitions: directDefinitions.length,
              directDefinitionChars: JSON.stringify(directDefinitions).length,
              unifiedDefinitions: materialized.definitions.length,
              unifiedDefinitionChars: JSON.stringify(materialized.definitions).length,
              directCalls: direct.length,
              executeCalls: 1,
              directIntermediateBytes: direct.reduce((total, item) => total + modelBytes(item.result), 0),
              executeIntermediateBytes: 0,
              finalAggregateBytes: modelBytes(result.result),
              directElapsedMs,
              executeElapsedMs,
            }),
          )
          expect(result.result.type).toBe("text")
          expect(typeof result.result.value).toBe("string")
          if (typeof result.result.value !== "string") return
          expect(JSON.parse(result.result.value)).toEqual({ files: 1, matches: 1, contains: true, found: 7 })
          expect(result.output?.structured).toMatchObject({
            toolCalls: [
              { name: "glob", status: "completed" },
              { name: "grep", status: "completed" },
              { name: "read", status: "completed" },
              { name: "demo_search", status: "completed" },
            ],
          })
        }).pipe(Effect.provide(layer))
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)
