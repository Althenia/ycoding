import path from "node:path"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import {
  createMcpHandler,
  inputRequired,
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server"
import { ConfigCapabilities } from "@ycoding-ai/core/config/capabilities"
import { ConfigMCP } from "@ycoding-ai/core/config/mcp"
import { Config } from "@ycoding-ai/core/config"
import { Credential } from "@ycoding-ai/core/credential"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { Decision } from "@ycoding-ai/core/decision"
import { Database } from "@ycoding-ai/core/database/database"
import { Integration } from "@ycoding-ai/core/integration"
import { Location } from "@ycoding-ai/core/location"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { MCPClient } from "@ycoding-ai/core/mcp/client"
import { Permission } from "@ycoding-ai/core/permission"
import { Hash } from "@ycoding-ai/core/util/hash"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { McpTool } from "@ycoding-ai/core/tool/mcp"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { Image } from "@ycoding-ai/core/image"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { location } from "./fixture/location"
import { settleTool, toolDefinitions, toolIdentity, waitForTool } from "./lib/tool"

let assertion: Deferred.Deferred<Permission.AssertInput> | undefined
let decision: Effect.Effect<void, Permission.Error> = Effect.void
let calls = 0
let parallelGate: Deferred.Deferred<void> | undefined
let nestedStarted: Deferred.Deferred<void> | undefined
let nestedCancelled: Deferred.Deferred<void> | undefined

type ResourcePage = {
  items: Array<{ name: string; uri: string; description?: string; mimeType?: string }>
  nextCursor?: string
}

type ResourceTemplatePage = {
  items: Array<{ name: string; uriTemplate: string; description?: string; mimeType?: string }>
  nextCursor?: string
}

function resourceServer(
  input: {
    era?: "legacy" | "modern"
    resources?: boolean
    resourceMethods?: boolean
    listChanged?: boolean
    emptyElicitation?: boolean
    urlElicitation?: boolean
  } = {},
) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const state = {
        resources: [] as ResourcePage["items"],
        templates: [] as ResourceTemplatePage["items"],
        resourcePages: undefined as Record<string, ResourcePage> | undefined,
        templatePages: undefined as Record<string, ResourceTemplatePage> | undefined,
        contents: [
          { uri: "docs://readme", text: "hello", mimeType: "text/plain" },
          { uri: "docs://logo", blob: "aGVsbG8=", mimeType: "image/png" },
        ] as Array<{ uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string }>,
        resourceLists: 0,
        templateLists: 0,
        resourceMethodRequests: 0,
        templateMethodRequests: 0,
      }
      const elicitation = input.urlElicitation
        ? {
            tool: "url-elicitation",
            legacy: {
              mode: "url" as const,
              message: "Authorize access",
              url: "https://example.com/authorize",
              elicitationId: "elicitation-test",
            },
            modern: inputRequired.elicitUrl({ message: "Authorize access", url: "https://example.com/authorize" }),
          }
        : input.emptyElicitation
          ? {
              tool: "empty-elicitation",
              legacy: {
                mode: "form" as const,
                message: "Confirm",
                requestedSchema: { type: "object" as const, properties: {} },
              },
              modern: inputRequired.elicit({ message: "Confirm", requestedSchema: { type: "object", properties: {} } }),
            }
          : undefined
      const build = () => {
        const protocol = new Server(
          { name: "mcp-resources", version: "1.0.0" },
          {
            capabilities: {
              tools: {},
              ...(input.resources === false ? {} : { resources: { listChanged: input.listChanged } }),
            },
          },
        )
        protocol.setRequestHandler("tools/list", () => ({
          tools: elicitation
            ? [{ name: elicitation.tool, inputSchema: { type: "object" as const, properties: {} } }]
            : [],
        }))
        if (elicitation) {
          protocol.setRequestHandler("tools/call", async (_request, ctx) => {
            const answered = input.era === "modern" ? ctx.mcpReq.inputResponses?.elicitation : undefined
            if (input.era === "modern" && answered === undefined)
              return inputRequired({ inputRequests: { elicitation: elicitation.modern } })
            const result = answered ?? (await protocol.elicitInput(elicitation.legacy))
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: result,
            }
          })
        }
        if (input.resources !== false && input.resourceMethods !== false) {
          protocol.setRequestHandler("resources/list", (request) => {
            state.resourceLists += 1
            const page = state.resourcePages?.[request.params?.cursor ?? "initial"]
            return { resources: page?.items ?? state.resources, nextCursor: page?.nextCursor }
          })
          protocol.setRequestHandler("resources/templates/list", (request) => {
            state.templateLists += 1
            const page = state.templatePages?.[request.params?.cursor ?? "initial"]
            return { resourceTemplates: page?.items ?? state.templates, nextCursor: page?.nextCursor }
          })
          protocol.setRequestHandler("resources/read", () => ({ contents: state.contents }))
        }
        return protocol
      }
      const modern = createMcpHandler(build, { legacy: "reject" })
      const legacy = build()
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await legacy.connect(transport)
      const http = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const body = (await request
            .clone()
            .json()
            .catch(() => undefined)) as { method?: string } | undefined
          if (body?.method === "resources/list") state.resourceMethodRequests++
          if (body?.method === "resources/templates/list") state.templateMethodRequests++
          return input.era === "modern" ? modern.fetch(request) : transport.handleRequest(request)
        },
      })
      return {
        state,
        url: http.url.toString(),
        sendResourceListChanged: async () =>
          input.era === "modern" ? modern.notify.resourcesChanged() : legacy.sendResourceListChanged(),
        completeElicitation: () => legacy.createElicitationCompletionNotifier("elicitation-test")(),
        close: async () => {
          await legacy.close().catch(() => {})
          await modern.close()
          await http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

function resourceMcpLayer(
  server: string | typeof ConfigMCP.Server.Type,
  onFormCreated?: (form: Form.Info) => Effect.Effect<void>,
  locationDirectory = import.meta.dir,
  capabilities?: ConfigCapabilities.Info,
) {
  const directory = AbsolutePath.make(locationDirectory)
  const unusedIntegration = () => Effect.die("unused integration service")
  return MCP.layer.pipe(
    Layer.provideMerge(Form.layer),
    Layer.provideMerge(
      Layer.mock(Decision.Service, { evaluate: () => Effect.die("MCP forms must not request judgments") }),
    ),
    Layer.provide(
      Layer.mergeAll(
        Database.layer({ path: ":memory:" }),
        Layer.succeed(
          Config.Service,
          Config.Service.of({ diagnostics: () => Effect.succeed([]),
            reload: () => Effect.void,
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: new Config.Info({
                    capabilities,
                    mcp: new ConfigMCP.Info({
                      servers: {
                        resources:
                          typeof server === "string"
                            ? new ConfigMCP.Remote({ type: "remote", url: server, oauth: false })
                            : server,
                      },
                    }),
                  }),
                }),
              ]),
          }),
        ),
        Layer.succeed(Location.Service, Location.Service.of(location({ directory }))),
        Layer.mock(SessionAutonomy.Service, {
          get: () => Effect.succeed(SessionAutonomy.defaultState),
        }),
        Layer.mock(EventRuntime.Service, {
          subscribe: () => Stream.never,
          publish: (definition, data) => {
            const event = {
              id: EventRuntime.ID.create(),
              type: definition.type,
              data,
            } as EventRuntime.Payload<typeof definition>
            if (event.type !== Form.Event.Created.type || !onFormCreated) return Effect.succeed(event)
            return onFormCreated(Schema.decodeUnknownSync(Form.Event.Created.data)(data).form).pipe(Effect.as(event))
          },
        }),
        Layer.mock(Integration.Service, {
          connection: {
            snapshot: () => Effect.die("unused Integration.snapshot"),
            active: unusedIntegration,
            resolve: unusedIntegration,
            key: unusedIntegration,
            update: unusedIntegration,
            activate: unusedIntegration,
            remove: unusedIntegration,
          },
          oauth: {
            connect: unusedIntegration,
            status: unusedIntegration,
            complete: unusedIntegration,
            cancel: unusedIntegration,
          },
          command: {
            connect: unusedIntegration,
            status: unusedIntegration,
            cancel: unusedIntegration,
          },
        }),
        Layer.mock(Credential.Service, {}),
      ),
    ),
  )
}

const mcp = Layer.mock(MCP.Service, {
  tools: () =>
    Effect.succeed([
      new MCP.Tool({
        server: MCP.ServerName.make("demo"),
        name: "search",
        description: "Search",
        inputSchema: { type: "object", properties: { label: { type: "string" } } },
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" }, label: { type: "string" } },
          required: ["ok"],
        },
      }),
      new MCP.Tool({
        server: MCP.ServerName.make("direct"),
        name: "lookup",
        codemode: false,
        description: "Lookup",
        inputSchema: { type: "object", properties: {} },
      }),
    ]),
  callTool: (input) =>
    Effect.gen(function* () {
      calls += 1
      if (nestedStarted) yield* Deferred.succeed(nestedStarted, undefined)
      const gate = parallelGate
      if (gate) {
        if (calls === 2) yield* Deferred.succeed(gate, undefined)
        yield* Deferred.await(gate).pipe(Effect.onInterrupt(() => nestedCancelled ? Deferred.succeed(nestedCancelled, undefined).pipe(Effect.asVoid) : Effect.void))
      }
      return new MCP.ToolResult({
        server: MCP.ServerName.make(input.server),
        tool: input.name,
        isError: false,
        structured: { ok: true, ...(input.args?.label === undefined ? {} : { label: input.args.label }) },
        content: [],
      })
    }),
})
const permissions = Layer.mock(Permission.Service, {
  assert: (input) =>
    Effect.gen(function* () {
      if (!assertion) return yield* Effect.die("Permission test is not initialized")
      yield* Deferred.succeed(assertion, input)
      yield* decision
    }),
})
const guardrail = Layer.mock(SessionGuardrail.Service, {
  reviewPolicy: { enabled: true, decideReviews: false, decideHardReviews: true },
  assert: () => Effect.succeed({ release: Effect.void }),
})
const events = Layer.mock(EventRuntime.Service, { subscribe: () => Stream.never })
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, McpTool.node]), [
    [MCP.node, mcp],
    [Permission.node, permissions],
    [SessionGuardrail.node, guardrail],
    [EventRuntime.node, events],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Image.node, imagePassthrough],
  ]),
)

describe("MCP errors", () => {
  test("expose useful messages", () => {
    expect(new MCP.NotFoundError({ server: MCP.ServerName.make("demo") }).message).toBe("MCP server not found: demo")
    expect(
      new MCP.ToolCallError({ server: MCP.ServerName.make("demo"), tool: "search", message: "failed" }).message,
    ).toBe("failed")
    expect(new MCPClient.NeedsAuthError({ server: "demo" }).message).toBe("MCP server requires authentication: demo")
    expect(new MCPClient.ConnectError({ server: "demo", message: "offline" }).message).toBe("offline")
  })
})

test("MCP tool names match V1 sanitization", () => {
  expect(McpTool.namespace("context 7")).toBe("context_7")
  expect(McpTool.name("context 7", "resolve.library/id")).toBe("context_7_resolve_library_id")
})

test("preserves output schema validation across paginated tool discovery", async () => {
  const result = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* MCPClient.connect(
          "pagination",
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-output-schema.ts")],
          }),
          import.meta.dir,
        )
        expect((yield* connection.tools()).map((tool) => tool.name)).toEqual(["first", "second", "unresolved"])
        expect(yield* connection.callTool({ name: "second" })).toMatchObject({ structured: { value: 1 } })
        expect(yield* connection.callTool({ name: "unresolved" })).toMatchObject({ structured: { value: 1 } })
        return yield* connection.callTool({ name: "first" })
      }),
    ),
  )

  await expect(result).rejects.toThrow("Structured content does not match the tool's output schema")
})

test("retains output schemas across paginated MCP discovery", async () => {
  const tools = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* MCPClient.connect(
          "pagination",
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-output-schema.ts")],
          }),
          import.meta.dir,
        )
        return yield* connection.tools()
      }),
    ),
  )

  expect(tools.map((tool) => ({ name: tool.name, outputSchema: tool.outputSchema }))).toEqual([
    {
      name: "first",
      outputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
    {
      name: "second",
      outputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
    },
    {
      name: "unresolved",
      outputSchema: {
        type: "object",
        properties: { value: { $ref: "#/$defs/missing" } },
      },
    },
  ])
})

test("applies the configured MCP catalog timeout", async () => {
  const result = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* MCPClient.connect(
          "catalog-timeout",
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-timeout.ts")],
            environment: { MCP_TIMEOUT_TARGET: "catalog" },
            timeout: new ConfigMCP.Timeout({ catalog: 10 }),
          }),
          import.meta.dir,
        )
        return yield* connection.tools()
      }),
    ),
  )

  await expect(result).rejects.toThrow("Request timed out")
})

test("applies the configured MCP execution timeout", async () => {
  const result = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* MCPClient.connect(
          "execution-timeout",
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-timeout.ts")],
            timeout: new ConfigMCP.Timeout({ execution: 10 }),
          }),
          import.meta.dir,
        )
        return yield* connection.callTool({ name: "slow" })
      }),
    ),
  )

  await expect(result).rejects.toThrow("Request timed out")
})

test("applies the configured MCP execution timeout to prompts", async () => {
  const result = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* MCPClient.connect(
          "prompt-timeout",
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-timeout.ts")],
            timeout: new ConfigMCP.Timeout({ execution: 10 }),
          }),
          import.meta.dir,
        )
        return yield* connection.prompt({ name: "slow" })
      }),
    ),
  )

  await expect(result).rejects.toThrow("Request timed out")
})

test("applies configured MCP timeouts to resource operations", async () => {
  const catalog = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* MCPClient.connect(
          "resource-catalog-timeout",
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-timeout.ts")],
            environment: { MCP_TIMEOUT_TARGET: "resource-catalog" },
            timeout: new ConfigMCP.Timeout({ catalog: 10 }),
          }),
          import.meta.dir,
        )
        return yield* connection.resources()
      }),
    ),
  )
  await expect(catalog).rejects.toThrow("Request timed out")

  const read = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* MCPClient.connect(
          "resource-read-timeout",
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-timeout.ts")],
            timeout: new ConfigMCP.Timeout({ execution: 10 }),
          }),
          import.meta.dir,
        )
        return yield* connection.readResource({ uri: "test://slow" })
      }),
    ),
  )
  await expect(read).rejects.toThrow("Request timed out")
})

test.each(["legacy", "modern"] as const)("lists, reads, and reports MCP resource changes (%s era)", async (era) => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* resourceServer({ era, listChanged: true })
        server.state.resourcePages = {
          initial: {
            items: [{ name: "Readme", uri: "docs://readme", description: "Project docs" }],
            nextCursor: "resources-2",
          },
          "resources-2": { items: [{ name: "Logo", uri: "docs://logo", mimeType: "image/png" }] },
        }
        server.state.templatePages = {
          initial: {
            items: [{ name: "File", uriTemplate: "docs://{path}" }],
            nextCursor: "templates-2",
          },
          "templates-2": { items: [{ name: "Issue", uriTemplate: "issue://{id}", description: "Issue" }] },
        }
        const connection = yield* MCPClient.connect(
          "resources",
          new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false }),
          import.meta.dir,
        )

        expect(yield* connection.resources()).toEqual([
          { name: "Readme", uri: "docs://readme", description: "Project docs", mimeType: undefined },
          { name: "Logo", uri: "docs://logo", description: undefined, mimeType: "image/png" },
        ])
        expect(yield* connection.resourceTemplates()).toEqual([
          { name: "File", uriTemplate: "docs://{path}", description: undefined, mimeType: undefined },
          { name: "Issue", uriTemplate: "issue://{id}", description: "Issue", mimeType: undefined },
        ])
        expect(yield* connection.readResource({ uri: "docs://readme" })).toEqual({
          contents: [
            { type: "text", uri: "docs://readme", text: "hello", mimeType: "text/plain" },
            { type: "blob", uri: "docs://logo", blob: "aGVsbG8=", mimeType: "image/png" },
          ],
        })

        const changed = yield* Deferred.make<void>()
        connection.onResourcesChanged(() => Deferred.doneUnsafe(changed, Exit.void))
        yield* Effect.promise(server.sendResourceListChanged)
        yield* Deferred.await(changed)
      }),
    ),
  )
})

test("skips MCP resource requests when the capability is absent", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* resourceServer({ resources: false })
        const connection = yield* MCPClient.connect(
          "resources",
          new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false }),
          import.meta.dir,
        )
        expect(yield* connection.resources()).toEqual([])
        expect(yield* connection.resourceTemplates()).toEqual([])
        expect(yield* connection.readResource({ uri: "docs://readme" })).toBeUndefined()
        expect({ resources: server.state.resourceLists, templates: server.state.templateLists }).toEqual({
          resources: 0,
          templates: 0,
        })
      }),
    ),
  )
})

test("caches unsupported MCP resource list methods", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* resourceServer({ resourceMethods: false })
        const connection = yield* MCPClient.connect(
          "resources",
          new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false }),
          import.meta.dir,
        )
        expect(yield* connection.resources()).toEqual([])
        expect(yield* connection.resources()).toEqual([])
        expect(yield* connection.resourceTemplates()).toEqual([])
        expect(yield* connection.resourceTemplates()).toEqual([])
        expect({
          resources: server.state.resourceMethodRequests,
          templates: server.state.templateMethodRequests,
        }).toEqual({
          resources: 1,
          templates: 1,
        })
      }),
    ),
  )
})

test.each(["legacy", "modern"] as const)("accepts empty MCP elicitations without creating forms (%s era)", async (era) => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* resourceServer({ era, resources: false, emptyElicitation: true })
        const result = yield* Effect.gen(function* () {
          const service = yield* MCP.Service
          const forms = yield* Form.Service
          const result = yield* service.callTool({ server: "resources", name: "empty-elicitation" })
          expect(yield* forms.list()).toEqual([])
          return result
        }).pipe(Effect.provide(resourceMcpLayer(server.url)))

        expect(result.structured).toEqual({ action: "accept", content: {} })
      }),
    ),
  )
})

test("acknowledges completed MCP URL elicitations without returning internal content", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* resourceServer({ resources: false, urlElicitation: true })
        const created = yield* Deferred.make<Form.Info>()
        const result = yield* Effect.gen(function* () {
          const service = yield* MCP.Service
          const forms = yield* Form.Service
          const call = yield* service.callTool({ server: "resources", name: "url-elicitation" }).pipe(Effect.forkScoped)

          const form = yield* Deferred.await(created)
          expect(form.fields).toEqual([{ key: "elicitation", type: "external", url: "https://example.com/authorize" }])

          yield* Effect.promise(server.completeElicitation)
          const result = yield* Fiber.join(call)
          expect(yield* forms.state(form.id)).toEqual({ status: "answered", answer: { elicitation: true } })
          return result
        }).pipe(
          Effect.provide(resourceMcpLayer(server.url, (form) => Deferred.succeed(created, form).pipe(Effect.asVoid))),
        )

        expect(result.structured).toEqual({ action: "accept" })
      }),
    ),
  )
})

test("answers MCP URL elicitations from the form on modern servers", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* resourceServer({ era: "modern", resources: false, urlElicitation: true })
        const created = yield* Deferred.make<Form.Info>()
        const result = yield* Effect.gen(function* () {
          const service = yield* MCP.Service
          const forms = yield* Form.Service
          const call = yield* service.callTool({ server: "resources", name: "url-elicitation" }).pipe(Effect.forkScoped)

          const form = yield* Deferred.await(created)
          expect(form.fields).toEqual([{ key: "elicitation", type: "external", url: "https://example.com/authorize" }])

          yield* forms.reply({ id: form.id, answer: { elicitation: true } })
          return yield* Fiber.join(call)
        }).pipe(
          Effect.provide(resourceMcpLayer(server.url, (form) => Deferred.succeed(created, form).pipe(Effect.asVoid))),
        )

        expect(result.structured).toEqual({ action: "accept" })
      }),
    ),
  )
})

test("loads and reads MCP resources", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* resourceServer()
        server.state.resources = [{ name: "Readme", uri: "docs://readme" }]
        server.state.templates = [{ name: "File", uriTemplate: "docs://{path}" }]

        yield* Effect.gen(function* () {
          const service = yield* MCP.Service
          expect(yield* service.resourceCatalog()).toEqual({
            resources: [
              {
                server: "resources",
                name: "Readme",
                uri: "docs://readme",
                description: undefined,
                mimeType: undefined,
              },
            ],
            templates: [
              {
                server: "resources",
                name: "File",
                uriTemplate: "docs://{path}",
                description: undefined,
                mimeType: undefined,
              },
            ],
          })

          server.state.resources = [{ name: "Guide", uri: "docs://guide" }]
          expect((yield* service.resourceCatalog()).resources.map((resource) => resource.uri)).toEqual(["docs://guide"])
          expect(yield* service.readResource({ server: "resources", uri: "docs://readme" })).toEqual({
            server: "resources",
            uri: "docs://readme",
            contents: [
              { type: "text", uri: "docs://readme", text: "hello", mimeType: "text/plain" },
              { type: "blob", uri: "docs://logo", blob: "aGVsbG8=", mimeType: "image/png" },
            ],
          })
        }).pipe(Effect.provide(resourceMcpLayer(server.url)))
      }),
    ),
  )
})

test("adds, disconnects, and reconnects MCP servers at runtime", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const service = yield* MCP.Service

          expect((yield* service.servers())[0]?.status).toEqual({ status: "disabled" })
          expect(yield* service.connect("missing").pipe(Effect.flip)).toBeInstanceOf(MCP.NotFoundError)
          expect(yield* service.disconnect("missing").pipe(Effect.flip)).toBeInstanceOf(MCP.NotFoundError)
          yield* service.add(
            "dynamic",
            new ConfigMCP.Local({
              type: "local",
              command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-output-schema.ts")],
            }),
          )
          expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status).toEqual({
            status: "connected",
          })

          yield* service.add(
            "dynamic",
            new ConfigMCP.Local({
              type: "local",
              command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-output-schema.ts")],
              disabled: true,
            }),
          )
          expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status).toEqual({
            status: "disabled",
          })
          expect(yield* service.tools()).toEqual([])

          yield* service.connect("dynamic")
          expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status).toEqual({
            status: "connected",
          })
          yield* service.disconnect("dynamic")
          expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status).toEqual({
            status: "disabled",
          })
          expect(yield* service.tools()).toEqual([])

          yield* service.connect("dynamic")
          expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status).toEqual({
            status: "connected",
          })

          yield* service.remove("dynamic")
          expect((yield* service.servers()).some((server) => server.name === "dynamic")).toBe(false)
          expect(yield* service.tools()).toEqual([])
          expect(yield* service.remove("dynamic").pipe(Effect.flip)).toBeInstanceOf(MCP.NotFoundError)
        }).pipe(
          Effect.provide(
            resourceMcpLayer(
              new ConfigMCP.Local({
                type: "local",
                command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-output-schema.ts")],
                disabled: true,
              }),
            ),
          ),
        )
      }),
    ),
  )
})

test("checks local MCP working directories before spawning and connects from an existing directory", async () => {
  await mkdir("/tmp/ycoding-mcp", { recursive: true })
  const temporaryDirectory = await mkdtemp("/tmp/ycoding-mcp/mcp-test-")
  const marker = path.join(temporaryDirectory, "started")
  const serverConfig = new ConfigMCP.Local({
    type: "local",
    command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-spawn-marker.ts")],
    environment: { MCP_TEST_START_MARKER: marker },
  })

  try {
    const missingDirectory = path.join(temporaryDirectory, "missing")
    const missing = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* MCP.Service
          yield* service.tools()
          return yield* service.servers()
        }).pipe(Effect.provide(resourceMcpLayer(serverConfig, undefined, missingDirectory))),
      ),
    )
    expect(missing[0]?.status).toEqual({
      status: "failed",
      error: `Working directory does not exist: ${missingDirectory}`,
    })
    expect(await Bun.file(marker).exists()).toBe(false)

    const existing = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* MCP.Service
          yield* service.tools()
          return yield* service.servers()
        }).pipe(Effect.provide(resourceMcpLayer(serverConfig))),
      ),
    )
    expect(existing[0]?.status).toEqual({ status: "connected" })
    expect(await Bun.file(marker).text()).toBe("started")
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

test("never starts MCP servers excluded by capabilities, at boot or when added later", async () => {
  await mkdir("/tmp/ycoding-mcp", { recursive: true })
  const temporaryDirectory = await mkdtemp("/tmp/ycoding-mcp/mcp-capabilities-")
  const marker = path.join(temporaryDirectory, "started")
  const serverConfig = new ConfigMCP.Local({
    type: "local",
    command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-spawn-marker.ts")],
    environment: { MCP_TEST_START_MARKER: marker },
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* MCP.Service
          expect(yield* service.servers()).toEqual([])
          expect(yield* service.tools()).toEqual([])
          expect(yield* service.instructions()).toEqual([])
          expect(yield* service.skillCatalog()).toEqual([])

          yield* service.add("denied-dynamic", serverConfig)
          expect((yield* service.servers()).find((server) => server.name === "denied-dynamic")?.status).toEqual({
            status: "disabled",
          })
          yield* service.connect("denied-dynamic")
          expect((yield* service.servers()).find((server) => server.name === "denied-dynamic")?.status).toEqual({
            status: "disabled",
          })
          expect(yield* service.tools()).toEqual([])
        }).pipe(
          Effect.provide(
            resourceMcpLayer(
              serverConfig,
              undefined,
              import.meta.dir,
              new ConfigCapabilities.Info({ mcp: { deny: ["resources", "denied-*"] } }),
            ),
          ),
        ),
      ),
    )
    expect(await Bun.file(marker).exists()).toBe(false)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* MCP.Service
          expect(yield* service.servers()).toEqual([])
        }).pipe(
          Effect.provide(
            resourceMcpLayer(serverConfig, undefined, import.meta.dir, new ConfigCapabilities.Info({ mcp: { enabled: false } })),
          ),
        ),
      ),
    )
    expect(await Bun.file(marker).exists()).toBe(false)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

test("serializes concurrent MCP lifecycle operations", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const service = yield* MCP.Service

          // Whatever order the racing operations land in, the resulting state must be consistent.
          yield* Effect.all(
            [
              service.connect("resources"),
              service.connect("resources"),
              service.disconnect("resources"),
              service.connect("resources"),
            ],
            { concurrency: "unbounded", discard: true },
          )
          const status = (yield* service.servers()).find((server) => server.name === "resources")?.status
          const tools = yield* service.tools()
          expect(status?.status === "connected" || status?.status === "disabled").toBe(true)
          if (status?.status === "disabled") expect(tools).toEqual([])
          if (status?.status === "connected") expect(tools.length).toBeGreaterThan(0)

          yield* service.disconnect("resources")
          expect((yield* service.servers())[0]?.status).toEqual({ status: "disabled" })
          expect(yield* service.tools()).toEqual([])
          yield* service.connect("resources")
          expect((yield* service.servers())[0]?.status).toEqual({ status: "connected" })
          expect((yield* service.tools()).length).toBeGreaterThan(0)
        }).pipe(
          Effect.provide(
            resourceMcpLayer(
              new ConfigMCP.Local({
                type: "local",
                command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-output-schema.ts")],
                disabled: true,
              }),
            ),
          ),
        )
      }),
    ),
  )
})

it.effect("exposes MCP output schemas through Code Mode search", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    yield* waitForTool(registry, "execute")
    const settlement = yield* settleTool(registry, {
      sessionID: Session.ID.make("ses_mcp_discovery"),
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: "call_mcp_discovery",
        name: "execute",
        input: { code: 'return search({ query: "demo search" })' },
      },
    })
    const text = settlement.output?.content.find((part) => part.type === "text")?.text
    const discovered = text === undefined ? undefined : JSON.parse(text)

    expect(discovered?.items[0]?.path).toBe("tools.demo.search")
    expect(discovered?.items[0]?.signature).toBe("tools.demo.search(input: {\n  label?: string,\n}): Promise<{\n  ok: boolean,\n  label?: string,\n}>")
  }),
)

it.live("runs parallel nested MCP calls independently", () =>
  Effect.gen(function* () {
    calls = 0
    assertion = yield* Deferred.make<Permission.AssertInput>()
    decision = Effect.void
    parallelGate = yield* Deferred.make<void>()
    const registry = yield* ToolRegistry.Service
    yield* waitForTool(registry, "execute")
    const settlement = yield* settleTool(registry, {
      sessionID: Session.ID.make("ses_mcp_parallel"),
      ...toolIdentity,
      call: { type: "tool-call", id: "call_mcp_parallel", name: "execute", input: { code: "return await Promise.all([tools.demo.search({}), tools.demo.search({})])" } },
    }).pipe(Effect.timeout("2 seconds"), Effect.ensuring(Effect.sync(() => { parallelGate = undefined })))
    expect(calls).toBe(2)
    expect(settlement.output?.structured).toEqual({ toolCalls: [
      { tool: "demo.search", name: "demo_search", id: expect.any(String), index: 0, input: {}, status: "completed", structured: { ok: true } },
      { tool: "demo.search", name: "demo_search", id: expect.any(String), index: 1, input: {}, status: "completed", structured: { ok: true } },
    ] })
    expect(settlement.result).toMatchObject({ type: "text", value: expect.not.stringContaining("error") })
  }),
)

it.live("runs sequential nested MCP calls independently", () =>
  Effect.gen(function* () {
    calls = 0
    assertion = yield* Deferred.make<Permission.AssertInput>()
    decision = Effect.void
    const registry = yield* ToolRegistry.Service
    yield* waitForTool(registry, "execute")
    const settlement = yield* settleTool(registry, {
      sessionID: Session.ID.make("ses_mcp_sequential"),
      ...toolIdentity,
      call: { type: "tool-call", id: "call_mcp_sequential", name: "execute", input: { code: "const a = await tools.demo.search({}); const b = await tools.demo.search({}); return [a,b]" } },
    }).pipe(Effect.timeout("2 seconds"))
    expect(calls).toBe(2)
    expect(settlement.output?.structured).toEqual({ toolCalls: [
      { tool: "demo.search", name: "demo_search", id: expect.any(String), index: 0, input: {}, status: "completed", structured: { ok: true } },
      { tool: "demo.search", name: "demo_search", id: expect.any(String), index: 1, input: {}, status: "completed", structured: { ok: true } },
    ] })
  }),
)

it.live("interrupting execute cancels its nested MCP job", () =>
  Effect.gen(function* () {
    calls = 0
    assertion = yield* Deferred.make<Permission.AssertInput>()
    decision = Effect.void
    parallelGate = yield* Deferred.make<void>()
    nestedStarted = yield* Deferred.make<void>()
    nestedCancelled = yield* Deferred.make<void>()
    const started = nestedStarted
    const cancelled = nestedCancelled
    const registry = yield* ToolRegistry.Service
    yield* waitForTool(registry, "execute")
    yield* Effect.gen(function* () {
      const fiber = yield* settleTool(registry, {
        sessionID: Session.ID.make("ses_mcp_cancel"), ...toolIdentity,
        call: { type: "tool-call", id: "call_mcp_cancel", name: "execute", input: { code: "return await tools.demo.search({})" } },
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      yield* Deferred.await(cancelled)
      expect(calls).toBe(1)
    }).pipe(Effect.timeout("2 seconds"), Effect.ensuring(Effect.sync(() => { parallelGate = undefined; nestedStarted = undefined; nestedCancelled = undefined })))
  }),
)

it.live("isolates parallel MCP calls across concurrent sessions", () =>
  Effect.gen(function* () {
    calls = 0
    assertion = yield* Deferred.make<Permission.AssertInput>()
    decision = Effect.void
    parallelGate = yield* Deferred.make<void>()
    const registry = yield* ToolRegistry.Service
    yield* waitForTool(registry, "execute")
    const run = (session: string, label: string, messageID: SessionMessage.ID) => settleTool(registry, {
      sessionID: Session.ID.make(`ses_mcp_${session}`), ...toolIdentity, messageID,
      call: { type: "tool-call", id: "shared_call", name: "execute", input: { code: `return await Promise.all([tools.demo.search({label:"${label}1"}), tools.demo.search({label:"${label}2"})])` } },
    })
    const results = yield* Effect.all([run("one", "one", toolIdentity.messageID), run("two", "two", toolIdentity.messageID), run("one", "three", SessionMessage.ID.make("msg_other"))], { concurrency: "unbounded" }).pipe(
      Effect.timeout("2 seconds"), Effect.ensuring(Effect.sync(() => { parallelGate = undefined })),
    )
    expect(calls).toBe(6)
    expect(JSON.stringify(results[0]?.result)).toContain("one1")
    expect(JSON.stringify(results[0]?.result)).toContain("one2")
    expect(JSON.stringify(results[1]?.result)).toContain("two1")
    expect(JSON.stringify(results[1]?.result)).toContain("two2")
    expect(JSON.stringify(results[2]?.result)).toContain("three1")
    expect(JSON.stringify(results[2]?.result)).toContain("three2")
    for (const result of results) expect(result.output?.structured).not.toHaveProperty("error")
    const ids = results.flatMap((result) => Schema.decodeUnknownSync(Schema.Struct({ toolCalls: Schema.Array(Schema.Struct({ id: Schema.String })) }))(result.output?.structured).toolCalls.map((call) => call.id))
    expect(new Set(ids).size).toBe(6)
  }),
)

testEffect(Layer.empty).live("reports disconnected MCP calls and succeeds after reconnect", () =>
  Effect.gen(function* () {
    const server = new ConfigMCP.Local({ type: "local", codemode: false, command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-output-schema.ts")] })
    yield* Effect.gen(function* () {
    const service = yield* MCP.Service
    yield* service.connect("resources")
    const layer = AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, McpTool.node]), [
      [MCP.node, Layer.succeed(MCP.Service, service)],
      [Permission.node, Layer.mock(Permission.Service, { assert: () => Effect.void })],
      [SessionGuardrail.node, guardrail], [EventRuntime.node, events],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig], [Image.node, imagePassthrough],
    ])
    yield* Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* service.servers()).toMatchObject([{ name: "resources", status: { status: "connected" } }])
      yield* waitForTool(registry, "resources_second")
      const request = yield* registry.materialize()
      const call = { sessionID: Session.ID.make("ses_mcp_reconnect"), ...toolIdentity, call: { type: "tool-call" as const, id: "reconnect", name: "execute", input: { code: "return await tools.resources.second({})" } } }
      yield* service.disconnect("resources")
      const disconnected = yield* request.settle(call)
      expect(disconnected.result).toMatchObject({ type: "text", value: expect.stringContaining("MCP") })
      expect(disconnected.output?.structured).toMatchObject({ error: true, toolCalls: [{ name: "resources_second", status: "error" }] })
      yield* service.connect("resources")
      const connected = yield* request.settle({ ...call, call: { ...call.call, id: "reconnected" } })
      expect(connected.result).toMatchObject({ type: "text", value: expect.stringContaining('"value": 1') })
      expect(connected.output?.structured).toMatchObject({ toolCalls: [{ name: "resources_second", status: "completed" }] })
    }).pipe(Effect.provide(layer), Effect.timeout("10 seconds"))
    }).pipe(Effect.provide(resourceMcpLayer(server)))
  }),
)

it.effect("advertises MCP tools directly when Code Mode is disabled for the server", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    yield* waitForTool(registry, "direct_lookup")
    const definitions = yield* toolDefinitions(registry)
    const execute = definitions.find((tool) => tool.name === "execute")

    expect(definitions.some((tool) => tool.name === "direct_lookup")).toBe(true)
    expect(execute?.description).not.toContain("tools.direct.lookup")
  }),
)

it.effect("waits for permission before calling an MCP tool", () =>
  Effect.gen(function* () {
    calls = 0
    assertion = yield* Deferred.make<Permission.AssertInput>()
    const permission = yield* Deferred.make<void>()
    decision = Deferred.await(permission)
    const registry = yield* ToolRegistry.Service
    yield* waitForTool(registry, "execute")

    const fiber = yield* settleTool(registry, {
      sessionID: Session.ID.make("ses_mcp_permission"),
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: "call_mcp_permission",
        name: "execute",
        input: { code: "return await tools.demo.search({})" },
      },
    }).pipe(Effect.forkScoped)
    expect(yield* Deferred.await(assertion)).toEqual({
      action: "demo_search",
      resources: ["*"],
      save: ["*"],
      metadata: { operationDigest: Hash.json({ server: "demo", tool: "search", arguments: {} }) },
      sessionID: Session.ID.make("ses_mcp_permission"),
      agent: toolIdentity.agent,
      source: {
        type: "tool",
        messageID: toolIdentity.messageID,
        callID: "call_mcp_permission",
      },
    })
    expect(calls).toBe(0)

    yield* Deferred.succeed(permission, undefined)
    yield* Fiber.join(fiber)
    expect(calls).toBe(1)
  }),
)

it.effect("does not call MCP when permission is blocked", () =>
  Effect.gen(function* () {
    calls = 0
    assertion = yield* Deferred.make<Permission.AssertInput>()
    decision = Effect.fail(new Permission.BlockedError({ rules: [], permission: "demo_search", resources: ["*"] }))
    const registry = yield* ToolRegistry.Service
    yield* waitForTool(registry, "execute")

    const settlement = yield* settleTool(registry, {
      sessionID: Session.ID.make("ses_mcp_blocked"),
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: "call_mcp_blocked",
        name: "execute",
        input: { code: "return await tools.demo.search({})" },
      },
    })
    expect(settlement.result).toEqual({ type: "text", value: "Unable to execute demo_search" })
    expect(settlement.output?.structured).toEqual({
      toolCalls: [{ tool: "demo.search", name: "demo_search", id: expect.any(String), index: 0, input: {}, status: "error" }],
      error: true,
    })
    expect(calls).toBe(0)
  }),
)
