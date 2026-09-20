import path from "path"
import fs from "fs/promises"
import { expect, test } from "bun:test"
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
import { location } from "../../core/test/fixture/location"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { ServiceStatus } from "@ycoding-ai/protocol/groups/health"
import { Api } from "../src/api"
import { ClientApi } from "@ycoding-ai/protocol/client"

// Response shapes come from the public contract, so this test cannot drift from the wire format.
const endpoints = ClientApi.groups["server.config"].endpoints
const readSchema = endpoints["config.get"].success.values().next().value
const previewSchema = endpoints["config.preview"].success.values().next().value
const commitSchema = endpoints["config.commit"].success.values().next().value

const decode = <A>(schema: unknown, input: unknown): A => Schema.decodeUnknownSync(schema as never)(input) as A

type ReadResponse = {
  readonly location: { readonly directory: string }
  readonly data: {
    readonly values: Record<string, unknown>
    readonly sources: ReadonlyArray<{ readonly scope: string }>
  }
}
type PreviewResponse = {
  readonly data: { readonly changes: ReadonlyArray<{ readonly key: string }>; readonly revision: string }
}
type CommitResponse = {
  readonly data: { readonly read: { readonly values: Record<string, unknown> } }
}
import { ConfigHandler } from "../src/handlers/config"
import { LocationMiddleware, type LocationServices } from "../src/location"
import { processIdentityLayer } from "../src/process-identity"

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

/**
 * Boot the real Location-scoped Config service for a throwaway directory and expose it through
 * the assembled public route: the `server.config` group, the Location middleware, authorization,
 * and the schema-error middleware exactly as `createRoutes` provides them.
 */
async function fixture(setup: (paths: { directory: string; global: string }) => Promise<void>) {
  const tmp = await tmpdir()
  const directory = tmp.path
  const global = path.join(directory, "global")
  await fs.mkdir(global, { recursive: true })
  await setup({ directory, global })

  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(directory) }),
    ),
  )
  const services = AppNodeBuilder.build(LayerNode.group([Config.node, EventV2.node]), [
    [Config.node, Config.configured()],
    [Location.node, locationLayer],
    [
      Global.node,
      Global.layerWith({
        data: path.join(global, "data"),
        config: global,
        home: path.join(global, "home"),
      }),
    ],
    [Credential.node, emptyCredentialNode],
    [WellKnown.node, emptyWellknownNode],
  ])

  // The Location middleware supplies the request-scoped Location service. `response()` reads it
  // to report where the configuration came from, so provide the same Location the Config layer
  // was built with rather than an empty context.
  const locationContext = Context.make(
    Location.Service,
    Location.Service.of(
      location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(directory) }),
    ),
  ) as Context.Context<LocationServices>

  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.config"])).pipe(
      Layer.provide(
        ConfigHandler.pipe(
          Layer.provide(services),
          Layer.provide(processIdentityLayer(ServiceStatus.Epoch.make("epoch_config_test"))),
        ),
      ),
      Layer.provide(Layer.succeed(Authorization, (effect) => effect)),
      Layer.provide(Layer.succeed(SchemaErrorMiddleware, (effect) => effect)),
      Layer.provide(Layer.succeed(LocationMiddleware, (effect) => Effect.provide(effect, locationContext))),
      Layer.provideMerge(HttpServer.layerServices),
    ),
  )

  return {
    directory,
    global,
    request: (input: { method: string; path?: string; body?: unknown }) =>
      handler.handler(
        new Request(`http://localhost${input.path ?? "/api/config"}`, {
          method: input.method,
          headers: { "Content-Type": "application/json", "x-ycoding-directory": directory },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        }),
      ),
    [Symbol.asyncDispose]: async () => {
      await handler.dispose()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test("serves configuration reads through the assembled public route", async () => {
  await using fixtureValue = await fixture(async ({ directory }) => {
    await fs.writeFile(path.join(directory, "ycoding.json"), `{ "shell": "fish" }\n`)
  })

  const response = await fixtureValue.request({ method: "GET" })
  expect(response.status).toBe(200)
  const body = decode<ReadResponse>(readSchema, await response.json())
  expect(body.location.directory).toBe(fixtureValue.directory)
  expect(body.data.values.shell).toBe("fish")
  expect(body.data.sources.length).toBeGreaterThan(0)
})

test("previews without writing and commits through the same public route", async () => {
  const file = "ycoding.json"
  await using fixtureValue = await fixture(async ({ directory }) => {
    await fs.writeFile(path.join(directory, file), `{\n  // keep\n  "shell": "fish"\n}\n`)
  })
  const configPath = path.join(fixtureValue.directory, file)

  const preview = await fixtureValue.request({
    method: "POST",
    path: "/api/config/preview",
    body: { patch: { shell: "zsh" }, scope: "project" },
  })
  expect(preview.status).toBe(200)
  const previewBody = decode<PreviewResponse>(previewSchema, await preview.json())
  expect(previewBody.data.changes[0]?.key).toBe("shell")
  expect(await fs.readFile(configPath, "utf8")).toContain(`"shell": "fish"`)

  const commit = await fixtureValue.request({
    method: "PUT",
    body: { patch: { shell: "zsh" }, scope: "project", expectedRevision: previewBody.data.revision },
  })
  expect(commit.status).toBe(200)
  const commitBody = decode<CommitResponse>(commitSchema, await commit.json())
  expect(commitBody.data.read.values.shell).toBe("zsh")
  const after = await fs.readFile(configPath, "utf8")
  expect(after).toContain("// keep")
  expect(after).toContain(`"shell": "zsh"`)
})

test("returns a sanitized 400 for an invalid patch and a 400 for a stale revision", async () => {
  await using fixtureValue = await fixture(async ({ directory }) => {
    await fs.writeFile(path.join(directory, "ycoding.json"), `{ "shell": "fish" }\n`)
  })

  const invalid = await fixtureValue.request({
    method: "POST",
    path: "/api/config/preview",
    body: { patch: { shell: 5 }, scope: "project" },
  })
  expect(invalid.status).toBe(400)
  const invalidBody = (await invalid.json()) as { message: string; path?: string }
  expect(invalidBody.message).toContain("shell")
  // The reason is actionable but carries no file contents and no credential material.
  expect(invalidBody.message).not.toContain("fish")
  expect(invalidBody.path).toBe(path.join(fixtureValue.directory, "ycoding.json"))

  const stale = await fixtureValue.request({
    method: "PUT",
    body: { patch: { shell: "zsh" }, scope: "project", expectedRevision: "0".repeat(64) },
  })
  expect(stale.status).toBe(400)
  const staleBody = (await stale.json()) as { message: string }
  expect(staleBody.message).toContain("changed since it was read")
  expect(await fs.readFile(path.join(fixtureValue.directory, "ycoding.json"), "utf8")).toContain(`"shell": "fish"`)
})

test("never returns resolved secrets through the public route", async () => {
  await using fixtureValue = await fixture(async ({ directory }) => {
    await fs.writeFile(
      path.join(directory, "ycoding.json"),
      `{
        "providers": { "openai": { "settings": { "apiKey": "sk-live-secret" } } },
        "mcp": { "servers": { "local": { "type": "local", "command": ["node"], "environment": { "TOKEN": "env-secret" } } } }
      }`,
    )
  })

  const response = await fixtureValue.request({ method: "GET" })
  const text = await response.text()
  expect(response.status).toBe(200)
  expect(text).not.toContain("sk-live-secret")
  expect(text).not.toContain("env-secret")
  expect(text).toContain("[redacted]")
})

test("ignores a client-supplied path and writes only the Location's own document", async () => {
  await using fixtureValue = await fixture(async ({ directory }) => {
    await fs.writeFile(path.join(directory, "ycoding.json"), `{ "shell": "fish" }\n`)
  })
  const configPath = path.join(fixtureValue.directory, "ycoding.json")

  // `path` is not part of the public payload contract; a client cannot redirect the write.
  const response = await fixtureValue.request({
    method: "PUT",
    body: { patch: { shell: "zsh" }, scope: "project", path: "/tmp/ycoding-should-not-be-written.json" },
  })

  expect(response.status).toBe(200)
  expect(await fs.readFile(configPath, "utf8")).toContain(`"shell": "zsh"`)
  expect(await fs.stat("/tmp/ycoding-should-not-be-written.json").catch(() => undefined)).toBeUndefined()
})

test("redacts secret-bearing changes in preview and commit without changing stored values", async () => {
  await using fixtureValue = await fixture(async ({ directory }) => {
    await fs.writeFile(path.join(directory, "ycoding.json"), "{}\n")
  })
  const patch = {
    providers: {
      openai: {
        name: "Configured provider",
        headers: { Authorization: "synthetic-header-marker" },
        settings: { apiKey: "synthetic-key-marker" },
      },
    },
  }
  for (const operation of [
    { method: "POST", path: "/api/config/preview" },
    { method: "PUT", path: "/api/config" },
  ]) {
    const response = await fixtureValue.request({ ...operation, body: { scope: "project", patch } })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain("synthetic-header-marker")
    expect(text).not.toContain("synthetic-key-marker")
    expect(text).toContain("[redacted]")
    expect(text).toContain("Configured provider")
    if (operation.method === "POST") {
      expect(await fs.readFile(path.join(fixtureValue.directory, "ycoding.json"), "utf8")).toBe("{}\n")
    }
  }
  expect(JSON.parse(await fs.readFile(path.join(fixtureValue.directory, "ycoding.json"), "utf8"))).toEqual(patch)
})

test("invalid configuration values are rejected without echoing submitted content", async () => {
  await using fixtureValue = await fixture(async ({ directory }) => {
    await fs.writeFile(path.join(directory, "ycoding.json"), "{}\n")
  })
  for (const operation of [
    { method: "POST", path: "/api/config/preview" },
    { method: "PUT", path: "/api/config" },
  ]) {
    const response = await fixtureValue.request({
      ...operation,
      body: { scope: "project", patch: { providers: { openai: { env: "synthetic-private-marker" } } } },
    })
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).not.toContain("synthetic-private-marker")
    expect(text).toContain("providers")
    expect(await fs.readFile(path.join(fixtureValue.directory, "ycoding.json"), "utf8")).toBe("{}\n")
  }
})
