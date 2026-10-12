import { describe, expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@ycoding-ai/core/config"
import { ConfigMCP } from "@ycoding-ai/core/config/mcp"
import { Credential } from "@ycoding-ai/core/credential"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { Integration } from "@ycoding-ai/core/integration"
import { Location } from "@ycoding-ai/core/location"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventRuntime.node])))

const SERVER = "oauth"
const CLIENT = { client_id: "fixture-client" }

function oauthServer(input: {
  rotate: boolean
  access: string[]
  refresh: string[]
  beforeRefresh?: (refreshToken: string, refresh: Set<string>) => Promise<void>
}) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const state = {
        access: new Set(input.access),
        refresh: new Set(input.refresh),
        refreshRequests: [] as string[],
        holdDiscoveries: 0,
        discoveries: 0,
        issued: 0,
      }
      const discovered = Promise.withResolvers<void>()
      const http = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const url = new URL(request.url)
          const base = url.origin
          if (url.pathname === "/.well-known/oauth-protected-resource")
            return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] })
          if (url.pathname === "/.well-known/oauth-authorization-server") {
            if (state.holdDiscoveries > 0) {
              state.discoveries += 1
              if (state.discoveries >= state.holdDiscoveries) discovered.resolve()
              await discovered.promise
            }
            return Response.json({
              issuer: base,
              authorization_endpoint: `${base}/authorize`,
              token_endpoint: `${base}/token`,
              registration_endpoint: `${base}/register`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: ["none"],
            })
          }
          if (url.pathname === "/register")
            return Response.json(
              { ...((await request.json()) as Record<string, unknown>), client_id: "registered-client" },
              { status: 201 },
            )
          if (url.pathname === "/token") {
            const form = new URLSearchParams(await request.text())
            const presented = form.get("refresh_token") ?? ""
            state.refreshRequests.push(presented)
            await input.beforeRefresh?.(presented, state.refresh)
            if (form.get("grant_type") !== "refresh_token" || !state.refresh.has(presented))
              return Response.json({ error: "invalid_grant" }, { status: 400 })
            state.issued += 1
            const access = `access-${state.issued}`
            state.access.add(access)
            if (!input.rotate) return Response.json({ access_token: access, token_type: "Bearer", expires_in: 3600 })
            state.refresh.delete(presented)
            const refresh = `refresh-${state.issued}`
            state.refresh.add(refresh)
            return Response.json({
              access_token: access,
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: refresh,
            })
          }
          const token = request.headers.get("authorization")?.replace(/^Bearer /, "")
          if (!token || !state.access.has(token))
            return new Response(null, {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
              },
            })
          const protocol = new Server({ name: "oauth-fixture", version: "1.0.0" }, { capabilities: { tools: {} } })
          protocol.setRequestHandler(ListToolsRequestSchema, () =>
            Promise.resolve({ tools: [{ name: "echo", inputSchema: { type: "object" as const, properties: {} } }] }),
          )
          protocol.setRequestHandler(CallToolRequestSchema, () =>
            Promise.resolve({ content: [{ type: "text" as const, text: `served with ${token}` }] }),
          )
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          })
          await protocol.connect(transport)
          return transport.handleRequest(request)
        },
      })
      return { state, url: `${http.url.origin}/mcp`, stop: () => http.stop(true) }
    }),
    (server) => Effect.promise(server.stop),
  )
}

function locationMcp(
  url: string,
  directory: string,
  credentials: Layer.Layer<Credential.Service, never, Credential.Service> = Layer.empty as never,
) {
  const layer = MCP.layer.pipe(
    Layer.provide(credentials),
    Layer.provideMerge(Form.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            diagnostics: () => Effect.succeed([]),
            reload: () => Effect.void,
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: new Config.Info({
                    mcp: new ConfigMCP.Info({ servers: { [SERVER]: new ConfigMCP.Remote({ type: "remote", url }) } }),
                  }),
                }),
              ]),
          }),
        ),
        Layer.succeed(
          Location.Service,
          Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
        ),
        Layer.mock(SessionAutonomy.Service, { get: () => Effect.succeed(SessionAutonomy.defaultState) }),
      ),
    ),
  )
  return Layer.build(layer).pipe(Effect.map((context) => Context.get(context, MCP.Service)))
}

const status = (mcp: MCP.Interface) =>
  mcp.servers().pipe(Effect.map((servers) => servers.find((server) => server.name === SERVER)?.status))

const integrationOf = (mcp: MCP.Interface) =>
  mcp.servers().pipe(
    Effect.flatMap((servers) => {
      const integrationID = servers.find((server) => server.name === SERVER)?.integrationID
      return integrationID ? Effect.succeed(integrationID) : Effect.die("OAuth MCP server has no integration")
    }),
  )

const store = (integrationID: Integration.ID, input: { access: string; refresh: string; label?: string }) =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    return yield* credentials.create({
      integrationID,
      label: input.label,
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make(integrationID),
        access: input.access,
        refresh: input.refresh,
        expires: 0,
        metadata: { tokenType: "Bearer", client: CLIENT },
      }),
    })
  })

const stored = (id: Credential.ID) =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const credential = yield* credentials.get(id)
    return credential?.value.type === "oauth" ? credential.value : undefined
  })

const echo = (mcp: MCP.Interface) =>
  mcp
    .callTool({ server: SERVER, name: "echo" })
    .pipe(Effect.map((result) => result.content.flatMap((part) => (part.type === "text" ? [part.text] : []))))

describe("MCP OAuth token refresh", () => {
  it.live("refreshes a rejected access token and keeps the refresh token a non-rotating server did not return", () =>
    Effect.gen(function* () {
      const server = yield* oauthServer({ rotate: false, access: [], refresh: ["refresh-0"] })
      const mcp = yield* locationMcp(server.url, import.meta.dir)
      const credential = yield* store(yield* integrationOf(mcp), { access: "expired", refresh: "refresh-0" })

      yield* mcp.connect(SERVER)

      expect(yield* status(mcp)).toEqual({ status: "connected" })
      expect(server.state.refreshRequests).toEqual(["refresh-0"])
      expect(yield* stored(credential.id)).toMatchObject({
        access: "access-1",
        refresh: "refresh-0",
        metadata: { client: CLIENT },
      })
    }),
  )

  it.live("persists each rotated refresh token and refreshes again mid-session", () =>
    Effect.gen(function* () {
      const server = yield* oauthServer({ rotate: true, access: [], refresh: ["refresh-0"] })
      const mcp = yield* locationMcp(server.url, import.meta.dir)
      const credential = yield* store(yield* integrationOf(mcp), { access: "expired", refresh: "refresh-0" })

      yield* mcp.connect(SERVER)
      expect(yield* stored(credential.id)).toMatchObject({ access: "access-1", refresh: "refresh-1" })

      server.state.access.clear()
      expect(yield* echo(mcp)).toEqual(["served with access-2"])
      expect(server.state.refreshRequests).toEqual(["refresh-0", "refresh-1"])
      expect(yield* stored(credential.id)).toMatchObject({
        access: "access-2",
        refresh: "refresh-2",
        metadata: { client: CLIENT },
      })
    }),
  )

  it.live("a connection holding a superseded token adopts another Location's rotation instead of deleting it", () =>
    Effect.gen(function* () {
      const server = yield* oauthServer({ rotate: true, access: ["access-0"], refresh: ["refresh-0"] })
      const first = yield* locationMcp(server.url, import.meta.dir)
      const second = yield* locationMcp(server.url, AbsolutePath.make(`${import.meta.dir}/fixture`))
      const credential = yield* store(yield* integrationOf(first), { access: "access-0", refresh: "refresh-0" })
      yield* first.connect(SERVER)
      yield* second.connect(SERVER)
      expect(yield* status(second)).toEqual({ status: "connected" })

      server.state.access.delete("access-0")
      expect(yield* echo(first)).toEqual(["served with access-1"])
      expect(yield* echo(second)).toEqual(["served with access-1"])

      expect(server.state.refreshRequests).toEqual(["refresh-0"])
      expect(yield* stored(credential.id)).toMatchObject({ access: "access-1", refresh: "refresh-1" })
    }),
  )

  it.live("concurrent requests rejected together share one exchange of a single-use refresh token", () =>
    Effect.gen(function* () {
      const server = yield* oauthServer({ rotate: true, access: ["access-0"], refresh: ["refresh-0"] })
      const mcp = yield* locationMcp(server.url, import.meta.dir)
      const credential = yield* store(yield* integrationOf(mcp), { access: "access-0", refresh: "refresh-0" })
      yield* mcp.connect(SERVER)

      server.state.access.delete("access-0")
      server.state.holdDiscoveries = 2
      expect(yield* Effect.all([echo(mcp), echo(mcp)], { concurrency: "unbounded" })).toEqual([
        ["served with access-1"],
        ["served with access-1"],
      ])

      expect(server.state.refreshRequests).toEqual(["refresh-0"])
      expect(yield* stored(credential.id)).toMatchObject({ access: "access-1", refresh: "refresh-1" })
    }),
  )

  it.live(
    "a request refreshing with a token this process already exchanged reuses that exchange instead of deleting the rotation",
    () =>
      Effect.gen(function* () {
        const server = yield* oauthServer({ rotate: true, access: ["access-0"], refresh: ["refresh-0"] })
        const updating = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const held = { remaining: 1 }
        const holdFirstUpdate = Layer.effect(
          Credential.Service,
          Effect.gen(function* () {
            const credentials = yield* Credential.Service
            return Credential.Service.of({
              ...credentials,
              update: (id, updates) =>
                Effect.gen(function* () {
                  if (held.remaining > 0) {
                    held.remaining -= 1
                    yield* Deferred.succeed(updating, undefined)
                    yield* Deferred.await(release)
                  }
                  yield* credentials.update(id, updates)
                }),
            })
          }),
        )
        const mcp = yield* locationMcp(server.url, import.meta.dir, holdFirstUpdate)
        const credential = yield* store(yield* integrationOf(mcp), { access: "access-0", refresh: "refresh-0" })
        yield* mcp.connect(SERVER)

        server.state.access.delete("access-0")
        const first = yield* echo(mcp).pipe(Effect.forkScoped)
        yield* Deferred.await(updating)
        expect(yield* echo(mcp)).toEqual(["served with access-1"])
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(first)).toEqual(["served with access-1"])
        expect(server.state.refreshRequests).toEqual(["refresh-0"])
        expect(yield* stored(credential.id)).toMatchObject({ access: "access-1", refresh: "refresh-1" })
      }),
  )

  it.live("a refresh rejected because another process rotated the token first retries with the stored rotation", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const rotation = { id: undefined as Credential.ID | undefined }
      const server = yield* oauthServer({
        rotate: true,
        access: [],
        refresh: ["refresh-0"],
        beforeRefresh: async (refreshToken, refresh) => {
          const id = rotation.id
          if (refreshToken !== "refresh-0" || !id) return
          refresh.delete("refresh-0")
          refresh.add("refresh-other")
          const current = await Effect.runPromise(credentials.get(id))
          if (current?.value.type !== "oauth") return
          await Effect.runPromise(
            credentials.update(id, { value: { ...current.value, access: "expired-other", refresh: "refresh-other" } }),
          )
        },
      })
      const mcp = yield* locationMcp(server.url, import.meta.dir)
      const credential = yield* store(yield* integrationOf(mcp), { access: "expired", refresh: "refresh-0" })
      rotation.id = credential.id

      yield* mcp.connect(SERVER)

      expect(yield* status(mcp)).toEqual({ status: "connected" })
      expect(server.state.refreshRequests).toEqual(["refresh-0", "refresh-other"])
      expect(yield* stored(credential.id)).toMatchObject({
        access: "access-1",
        refresh: "refresh-1",
        metadata: { client: CLIENT },
      })
    }),
  )

  it.live("a rejected refresh of the latest stored token removes it and reports needs_auth", () =>
    Effect.gen(function* () {
      const server = yield* oauthServer({ rotate: true, access: [], refresh: [] })
      const mcp = yield* locationMcp(server.url, import.meta.dir)
      const credential = yield* store(yield* integrationOf(mcp), { access: "expired", refresh: "revoked" })

      yield* mcp.connect(SERVER)

      expect(yield* status(mcp)).toEqual({ status: "needs_auth" })
      expect(server.state.refreshRequests).toEqual(["revoked"])
      const credentials = yield* Credential.Service
      expect(yield* credentials.get(credential.id)).toBeUndefined()
    }),
  )

  it.live("connects with the active profile when the integration stores several", () =>
    Effect.gen(function* () {
      const server = yield* oauthServer({ rotate: true, access: ["access-work"], refresh: [] })
      const mcp = yield* locationMcp(server.url, import.meta.dir)
      const integrationID = yield* integrationOf(mcp)
      const personal = yield* store(integrationID, { access: "revoked", refresh: "revoked", label: "personal" })
      const work = yield* store(integrationID, { access: "access-work", refresh: "refresh-work", label: "work" })

      yield* mcp.connect(SERVER)

      expect(yield* status(mcp)).toEqual({ status: "connected" })
      expect(yield* echo(mcp)).toEqual(["served with access-work"])
      expect(server.state.refreshRequests).toEqual([])
      expect(yield* stored(personal.id)).toMatchObject({ access: "revoked" })
      expect(yield* stored(work.id)).toMatchObject({ access: "access-work" })
    }),
  )
})
