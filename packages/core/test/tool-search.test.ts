import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { FileSystem } from "@ycoding-ai/core/filesystem"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { Ripgrep } from "@ycoding-ai/core/ripgrep"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { GlobTool } from "@ycoding-ai/core/tool/glob"
import { GrepTool } from "@ycoding-ai/core/tool/grep"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, settleTool, toolIdentity } from "./lib/tool"

const globToolNode = makeLocationNode({
  name: "test/glob-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(GlobTool.Plugin)),
  deps: [ToolRegistry.toolsNode, FSUtil.node, Ripgrep.node, Location.node, PermissionV2.node],
})
const grepToolNode = makeLocationNode({
  name: "test/grep-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(GrepTool.Plugin)),
  deps: [ToolRegistry.toolsNode, FSUtil.node, Ripgrep.node, Location.node, PermissionV2.node, Global.node],
})
const permission = (assert: PermissionV2.Interface["assert"] = () => Effect.void) =>
  Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      evaluateEffective: () => Effect.die(new Error("unused PermissionV2.evaluateEffective")),
      assert,
      ask: () => Effect.die("unused"),
      reply: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      forSession: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
    }),
  )
const sessionID = SessionV2.ID.make("ses_search_tool_test")

const withTools = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  options: { readonly data?: string; readonly assert?: PermissionV2.Interface["assert"] } = {},
) =>
  Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          globToolNode,
          grepToolNode,
          ToolOutputStore.nodeWithoutConfig,
        ]),
        [
          [
            Location.node,
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
          ],
          [PermissionV2.node, permission(options.assert)],
          ...(options.data ? [[Global.node, Global.layerWith({ data: options.data })] as const] : []),
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )

const call = (name: "glob" | "grep", input: unknown) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: `call-${name}`, name, input },
})

const it = testEffect(Layer.empty)

describe("search tools", () => {
  it.live("bounds omitted glob and grep limits", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all(
              Array.from({ length: FileSystem.DEFAULT_SEARCH_LIMIT + 1 }, (_, index) =>
                fs.writeFile(path.join(tmp.path, `${index}.txt`), "needle\n"),
              ),
            ),
          )
          yield* withTools(tmp.path, (registry) =>
            Effect.gen(function* () {
              const glob = yield* settleTool(registry, call("glob", { pattern: "*" }))
              const grep = yield* settleTool(registry, call("grep", { pattern: "needle" }))

              expect(glob.output?.structured).toHaveLength(FileSystem.DEFAULT_SEARCH_LIMIT)
              expect(grep.output?.structured).toHaveLength(FileSystem.DEFAULT_SEARCH_LIMIT)
            }),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  for (const name of ["glob", "grep"] as const) {
    it.live(`${name} reports a missing search path`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          withTools(tmp.path, (registry) =>
            Effect.gen(function* () {
              const result = yield* executeTool(
                registry,
                call(name, { path: "missing", pattern: name === "glob" ? "*" : "needle" }),
              )
              expect(result).toEqual({ type: "error", value: "Search path does not exist: missing" })
            }),
          ),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )

    it.live(`${name} refuses paths outside the Location`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([inside, outside]) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(path.join(outside.path, "fixture.txt"), "outside-marker\n"))
            yield* withTools(inside.path, (registry) =>
              Effect.gen(function* () {
                for (const escaped of [outside.path, path.relative(inside.path, outside.path)]) {
                  const result = yield* executeTool(
                    registry,
                    call(name, { path: escaped, pattern: name === "glob" ? "*" : "outside-marker" }),
                  )
                  expect(result.type).toBe("error")
                }
              }),
            )
          }),
        ([inside, outside]) =>
          Effect.promise(() =>
            Promise.all([inside[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    )
  }

  it.live("search tools refuse a symlinked directory outside the Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([inside, outside]) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.symlink(outside.path, path.join(inside.path, "linked")))
          yield* withTools(inside.path, (registry) =>
            Effect.gen(function* () {
              for (const name of ["glob", "grep"] as const) {
                const result = yield* executeTool(registry, call(name, { path: "linked", pattern: "fixture" }))
                expect(result.type).toBe("error")
              }
            }),
          )
        }),
      ([inside, outside]) =>
        Effect.promise(() =>
          Promise.all([inside[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("grep applies read permissions to an explicit file and matched files in a directory", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".env"), "fixture-only-marker\n"))
          const checks: PermissionV2.AssertInput[] = []
          const assert: PermissionV2.Interface["assert"] = (input) =>
            Effect.sync(() => checks.push(input)).pipe(
              Effect.andThen(
                input.action === "read" && input.resources.includes(".env")
                  ? Effect.fail(
                      new PermissionV2.BlockedError({ rules: [], permission: "read", resources: input.resources }),
                    )
                  : Effect.void,
              ),
            )
          yield* withTools(
            tmp.path,
            (registry) =>
              Effect.gen(function* () {
                for (const input of [
                  { path: ".env", pattern: "missing-marker" },
                  { path: ".env", pattern: "fixture-only-marker" },
                  { path: ".", pattern: "fixture-only-marker" },
                ]) {
                  const result = yield* executeTool(registry, call("grep", input))
                  expect(result.type).toBe("error")
                }
                expect(checks.filter((check) => check.action === "read").map((check) => check.resources)).toEqual([
                  [".env"],
                  [".env"],
                  [".env"],
                ])
              }),
            { assert },
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("grep can search a managed tool-output file without external directory approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([inside, outside]) =>
        Effect.gen(function* () {
          const checks: PermissionV2.AssertInput[] = []
          yield* withTools(
            inside.path,
            (registry) =>
              Effect.gen(function* () {
                const store = yield* ToolOutputStore.Service
                const bounded = yield* store.bound({
                  sessionID,
                  callID: "call-managed",
                  output: {
                    structured: {},
                    content: [{ type: "text", text: `${"x".repeat(ToolOutputStore.MAX_BYTES)}\nmanaged-marker` }],
                  },
                })
                const result = yield* executeTool(
                  registry,
                  call("grep", { path: bounded.outputPaths[0], pattern: "managed-marker" }),
                )
                expect(result).toMatchObject({ type: "text", value: expect.stringContaining("managed-marker") })
                expect(checks.map((check) => check.action)).not.toContain("external_directory")
              }),
            {
              data: outside.path,
              assert: (input) =>
                Effect.sync(() => {
                  checks.push(input)
                }),
            },
          )
        }),
      ([inside, outside]) =>
        Effect.promise(() =>
          Promise.all([inside[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )
})
