import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@ycoding-ai/core/config"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Credential } from "@ycoding-ai/core/credential"
import { EventV2 } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { WellKnown } from "@ycoding-ai/core/wellknown"
import { makeGlobalNode } from "@ycoding-ai/core/effect/app-node"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const emptyCredentialNode = makeGlobalNode({
  service: Credential.Service,
  layer: Layer.succeed(
    Credential.Service,
    Credential.Service.of({
      all: () => Effect.succeed([]),
      list: () => Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      create: () => Effect.die("unused Credential.create"),
      update: () => Effect.die("unused Credential.update"),
      activate: () => Effect.die("unused Credential.activate"),
      remove: () => Effect.die("unused Credential.remove"),
    }),
  ),
  deps: [],
})

const emptyWellknownNode = makeGlobalNode({
  service: WellKnown.Service,
  layer: Layer.succeed(
    WellKnown.Service,
    WellKnown.Service.of({
      entries: () => Effect.succeed([]),
      snapshot: () => [],
      refresh: () => Effect.succeed(false),
      add: () => Effect.die("unused Wellknown.add"),
      remove: () => Effect.die("unused Wellknown.remove"),
      resolve: () => Effect.die("unused Wellknown.resolve"),
    }),
  ),
  deps: [],
})

function testLayer(directory: string, globalDirectory: string) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(directory) }),
    ),
  )
  return AppNodeBuilder.build(LayerNode.group([Config.node, EventV2.node]), [
    [Config.node, Config.configured()],
    [Location.node, locationLayer],
    [
      Global.node,
      Global.layerWith({
        data: path.join(globalDirectory, "data"),
        config: globalDirectory,
        home: path.join(globalDirectory, "home"),
      }),
    ],
    [Credential.node, emptyCredentialNode],
    [WellKnown.node, emptyWellknownNode],
  ])
}

type Paths = {
  readonly directory: string
  readonly global: string
  readonly project: string
}

/**
 * Fixture files must exist before the Location-scoped Config layer boots, because discovery runs
 * once during layer construction. Write files in `setup`, then exercise the body with the real
 * service; the layer is provided to the body only, after setup resolves.
 */
const withTempConfig = <A, E, R>(
  setup: (paths: Paths) => Promise<void>,
  body: (paths: Paths) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((tmp) => {
      const paths: Paths = {
        directory: tmp.path,
        global: path.join(tmp.path, "global"),
        project: path.join(tmp.path, "ycoding.json"),
      }
      return Effect.promise(() => fs.mkdir(paths.global, { recursive: true })).pipe(
        Effect.andThen(Effect.promise(() => setup(paths))),
        Effect.andThen(body(paths).pipe(Effect.provide(testLayer(paths.directory, paths.global)))),
      )
    }),
  )

const write = (file: string, text: string, mode?: number) =>
  fs.writeFile(file, text, mode === undefined ? undefined : { mode })

const read = (file: string) => fs.readFile(file, "utf8")

describe("Config read", () => {
  it.live("reports effective values with explicit source scope and provenance", () =>
    withTempConfig(
      async ({ directory, global }) => {
        await write(path.join(global, "ycoding.json"), `{ "shell": "zsh", "username": "global-user" }`)
        await write(path.join(directory, "ycoding.json"), `{ "shell": "fish" }`)
      },
      () =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const result = yield* config.read()

          // Highest priority wins, and a key only the global document defines survives the fold.
          expect(result.values.shell).toBe("fish")
          expect(result.values.username).toBe("global-user")
          const sources = result.sources.map((source) => [source.scope, path.basename(source.path)])
          expect(sources).toContainEqual(["global", "ycoding.json"])
          expect(sources).toContainEqual(["project", "ycoding.json"])
          // Revision covers raw bytes so `{env:}` and `{file:}` tokens are part of the identity.
          expect(result.sources.every((source) => /^[0-9a-f]{64}$/.test(source.revision))).toBe(true)
          expect(
            result.sources.filter((source) => source.scope === "project").flatMap((source) => source.keys),
          ).toEqual(["shell"])
        }),
    ),
  )

  it.live("never returns credential material, provider headers, or MCP environment values", () =>
    withTempConfig(
      ({ project }) =>
        write(
          project,
          `{
            // secrets must never leave this file
            "providers": {
              "openai": {
                "settings": { "apiKey": "sk-live-secret", "baseURL": "https://example.test" },
                "headers": { "authorization": "Bearer sk-live-secret" }
              }
            },
            "mcp": {
              "servers": {
                "local": { "type": "local", "command": ["node"], "environment": { "TOKEN": "env-secret" } }
              }
            }
          }`,
        ),
      () =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const serialized = JSON.stringify((yield* config.read()).values)

          expect(serialized).not.toContain("sk-live-secret")
          expect(serialized).not.toContain("env-secret")
          expect(serialized).not.toContain("Bearer")
          // Structure survives so a client can still report which keys are configured.
          expect(serialized).toContain("https://example.test")
          expect(serialized).toContain("[redacted]")
        }),
    ),
  )
})

describe("Config preview", () => {
  it.live("validates a patch and reports changes without writing", () =>
    withTempConfig(
      ({ project }) => write(project, `{\n  // keep me\n  "shell": "zsh"\n}\n`),
      ({ project }) =>
        Effect.gen(function* () {
          const before = yield* Effect.promise(() => read(project))
          const config = yield* Config.Service
          const result = yield* config.preview({ patch: { shell: "fish" }, scope: "project" })

          expect(result.scope).toBe("project")
          expect(result.path).toBe(project)
          expect(result.changes.map((change) => change.key)).toEqual(["shell"])
          expect(result.changes[0]?.value).toBe("fish")
          expect(yield* Effect.promise(() => read(project))).toBe(before)
          // Preview reports the revision it validated against and the revision the write would produce.
          expect(result.revision).toBe(
            (yield* config.read()).sources.find((source) => source.path === project)?.revision ?? "",
          )
          expect(result.result).not.toBe(result.revision)
        }),
    ),
  )

  it.live("rejects invalid and removed keys before any write", () =>
    withTempConfig(
      ({ project }) => write(project, `{ "shell": "zsh" }\n`),
      ({ project }) =>
        Effect.gen(function* () {
          const before = yield* Effect.promise(() => read(project))
          const config = yield* Config.Service

          const invalid = yield* config.preview({ patch: { shell: 5 }, scope: "project" }).pipe(Effect.flip)
          expect(invalid.name).toBe("ConfigInvalidError")
          expect(invalid.data.message).toContain("shell")

          const removed = yield* config.preview({ patch: { server: {} }, scope: "project" }).pipe(Effect.flip)
          expect(removed.name).toBe("ConfigInvalidError")
          expect(removed.data.message).toContain("removed configuration keys: server")

          const unknown = yield* config.preview({ patch: { not_a_key: 1 }, scope: "project" }).pipe(Effect.flip)
          expect(unknown.name).toBe("ConfigInvalidError")

          expect(yield* Effect.promise(() => read(project))).toBe(before)
        }),
    ),
  )

  it.live("reports an actionable reason when the requested scope has no document", () =>
    withTempConfig(
      ({ global }) => write(path.join(global, "ycoding.json"), `{ "shell": "zsh" }`),
      ({ global }) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const error = yield* config.preview({ patch: { shell: "fish" }, scope: "project" }).pipe(Effect.flip)
          expect(error.name).toBe("ConfigInvalidError")
          expect(error.data.message).toContain("no project configuration document")
          expect(yield* Effect.promise(() => read(path.join(global, "ycoding.json")))).toBe(`{ "shell": "zsh" }`)
        }),
    ),
  )
})

describe("Config commit", () => {
  it.live("preserves comments, unknown fields, and substitution tokens on a real file roundtrip", () =>
    withTempConfig(
      ({ project }) =>
        write(
          project,
          `{
  // The shell for terminal and shell tool execution.
  "shell": "zsh",
  /* a block comment */
  "username": "local",
  "mcp": {
    "servers": {
      "local": { "type": "local", "command": ["node"], "environment": { "TOKEN": "{env:YC_TEST_TOKEN}" } },
    },
  },
  "unreleased_future_key": { "deep": [1, 2] },
}
`,
        ),
      ({ project }) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const result = yield* config.commit({ patch: { shell: "fish" }, scope: "project" })
          const after = yield* Effect.promise(() => read(project))

          expect(result.path).toBe(project)
          expect(after).toContain("// The shell for terminal and shell tool execution.")
          expect(after).toContain("/* a block comment */")
          expect(after).toContain(`"shell": "fish"`)
          expect(after).toContain(`"username": "local"`)
          expect(after).toContain(`"TOKEN": "{env:YC_TEST_TOKEN}"`)
          expect(after).toContain(`"unreleased_future_key": { "deep": [1, 2] }`)
          expect(after).not.toContain(`"shell": "zsh"`)
          // Readback is the settled value after the write, not the requested patch.
          expect(result.read.values.shell).toBe("fish")
          expect(result.read.values.username).toBe("local")
          expect(result.revision).toBe(
            result.read.sources.find((source) => source.path === project)?.revision ?? "",
          )
        }),
    ),
  )

  it.live("removes a key with a null value and reports the resulting settled state", () =>
    withTempConfig(
      ({ project }) => write(project, `{ "shell": "zsh", "username": "local" }\n`),
      () =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const result = yield* config.commit({ patch: { shell: null }, scope: "project" })

          expect(result.changes[0]?.value).toBeUndefined()
          expect(result.read.values.shell).toBeUndefined()
          expect(result.read.values.username).toBe("local")
        }),
    ),
  )

  it.live("rejects a stale revision without modifying the file", () =>
    withTempConfig(
      ({ project }) => write(project, `{ "shell": "zsh" }\n`),
      ({ project }) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const preview = yield* config.preview({ patch: { shell: "fish" }, scope: "project" })

          // Another writer changes the file between preview and commit.
          const concurrent = `{ "shell": "bash" }\n`
          yield* Effect.promise(() => write(project, concurrent))

          const error = yield* config
            .commit({ patch: { shell: "fish" }, scope: "project", expectedRevision: preview.revision })
            .pipe(Effect.flip)

          expect(error.name).toBe("ConfigInvalidError")
          expect(error.data.message).toContain("changed since it was read")
          expect(yield* Effect.promise(() => read(project))).toBe(concurrent)
        }),
    ),
  )

  it.live("commits against the revision it actually read", () =>
    withTempConfig(
      ({ project }) => write(project, `{ "shell": "zsh" }\n`),
      ({ project }) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const revision = (yield* config.read()).sources.find((source) => source.path === project)?.revision

          const result = yield* config.commit({
            patch: { shell: "fish" },
            scope: "project",
            expectedRevision: revision,
          })
          expect(result.read.values.shell).toBe("fish")
        }),
    ),
  )

  it.live("preserves an existing restrictive file mode", () =>
    withTempConfig(
      ({ project }) => write(project, `{ "shell": "zsh" }\n`, 0o600),
      ({ project }) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          yield* config.commit({ patch: { shell: "fish" }, scope: "project" })

          const mode = (yield* Effect.promise(() => fs.stat(project))).mode & 0o777
          expect(mode).toBe(0o600)
        }),
    ),
  )

  it.live("keeps a lower-priority document and reports a key another source still owns", () =>
    withTempConfig(
      async ({ global, project }) => {
        await write(path.join(global, "ycoding.json"), `{ "username": "global-user", "shell": "zsh" }`)
        await write(project, `{ "shell": "fish" }\n`)
      },
      () =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const result = yield* config.commit({ patch: { shell: null }, scope: "project" })

          // Removing the project value settles back to the global document, not to undefined.
          expect(result.read.values.shell).toBe("zsh")
          expect(result.unsettled).toEqual(["shell"])
        }),
    ),
  )

  it.live("refuses to retarget a write at a document the runtime does not own", () =>
    withTempConfig(
      async ({ directory }) => {
        await fs.mkdir(path.join(directory, "elsewhere"), { recursive: true })
        await write(path.join(directory, "elsewhere", "custom.json"), `{ "shell": "zsh" }\n`)
      },
      ({ directory }) =>
        Effect.gen(function* () {
          const outside = path.join(directory, "elsewhere", "custom.json")
          const config = yield* Config.Service
          const error = yield* config.preview({ patch: { shell: "fish" }, scope: "project" }).pipe(Effect.flip)

          // No discoverable project document exists, so the write cannot silently pick an arbitrary path.
          expect(error.name).toBe("ConfigInvalidError")
          expect(yield* Effect.promise(() => read(outside))).toBe(`{ "shell": "zsh" }\n`)
        }),
    ),
  )
})
