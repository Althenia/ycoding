import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { MeetingIntelligence } from "../../../extensions/meeting/src/intelligence"
import { MeetingStore } from "../../../extensions/meeting/src/store"
import type { TranscriptSegment } from "../../../extensions/meeting/src/types"
import { Config } from "@ycoding-ai/core/config"
import { ConfigMCP } from "@ycoding-ai/core/config/mcp"
import { Credential } from "@ycoding-ai/core/credential"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { Integration } from "@ycoding-ai/core/integration"
import { Location } from "@ycoding-ai/core/location"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Effect, Layer, Stream } from "effect"
import { location } from "./fixture/location"

const resources: Array<{ directory: string; store: MeetingStore; server: KnowledgeServer }> = []

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.store.close()
    await resource.server.close()
    rmSync(resource.directory, { recursive: true, force: true })
  }
})

describe("Meeting Intelligence with deterministic extraction over real MCP", () => {
  test("persists discovered references and leaves extracted proposals pending", async () => {
    await withFixture(async ({ store, reopen, intelligence, meetingID, server }) => {
      await intelligence.analyze(meetingID, true)
      const proposal = store.proposals(meetingID)[0]

      expect(store.references(meetingID)).toMatchObject([
        { server: "knowledge", target: "doc-1", revision: "r1", content: "Original canonical content" },
      ])
      expect(server.searchRequests).toEqual([{ query: "We discussed the deployment", limit: 3 }])
      expect(server.readRequests).toEqual(["doc-1"])
      expect(proposal).toMatchObject({
        status: "pending",
        expectedRevision: "r1",
        existingContent: "Original canonical content",
      })
      expect(store.approvals(meetingID)).toEqual([])
      expect(server.writes).toEqual([])
      const reopened = reopen()
      expect(reopened.references(meetingID)).toMatchObject([{ server: "knowledge", target: "doc-1", revision: "r1" }])
      expect(reopened.proposals(meetingID)).toMatchObject([{ id: proposal!.id, status: "pending" }])
    })
  })

  test("records a manual outcome rather than claiming success without a configured write tool", async () => {
    await withFixture(
      async ({ store, intelligence, meetingID, server }) => {
        intelligence.options.bindings = [{ server: "knowledge", search: "search", read: "read" }]
        await intelligence.analyze(meetingID, true)
        const proposal = store.proposals(meetingID)[0]!

        await intelligence.review(meetingID, proposal.id, true)

        expect(store.proposals(meetingID)[0]?.status).toBe("manual")
        expect(store.approvals(meetingID).map((approval) => approval.decision)).toEqual(["approve"])
        expect(server.writes).toEqual([])
        expect(store.references(meetingID)[0]?.content).toBe("Original canonical content")
      },
      { withWriteTool: false },
    )
  })

  test("records a manual outcome when the MCP writer omits revision requirements", async () => {
    await withFixture(
      async ({ store, intelligence, meetingID, server }) => {
        await intelligence.analyze(meetingID, true)
        const proposal = store.proposals(meetingID)[0]!

        await intelligence.review(meetingID, proposal.id, true)

        expect(store.proposals(meetingID)[0]).toMatchObject({
          status: "manual",
          error: "The MCP writer does not advertise required revision-aware update fields",
        })
        expect(store.approvals(meetingID).map((approval) => approval.decision)).toEqual(["approve"])
        expect(server.writes).toEqual([])
      },
      { writerSchemaValid: false },
    )
  })

  test("fails analysis when a search hit cannot be read", async () => {
    await withFixture(async ({ store, intelligence, meetingID, server }) => {
      server.missingDocument = true

      await expect(intelligence.analyze(meetingID, true)).rejects.toThrow("MCP knowledge operation failed")

      expect(store.references(meetingID)).toEqual([])
      expect(store.proposals(meetingID)).toEqual([])
      expect(store.jobs(meetingID)[0]?.status).toBe("failed")
    })
  })

  test("audits explicit rejection without calling the MCP writer", async () => {
    await withFixture(async ({ store, intelligence, meetingID, server }) => {
      await intelligence.analyze(meetingID, true)
      const proposal = store.proposals(meetingID)[0]!

      await intelligence.review(meetingID, proposal.id, false)

      expect(store.proposals(meetingID)[0]?.status).toBe("rejected")
      expect(store.approvals(meetingID).map((approval) => approval.decision)).toEqual(["reject"])
      expect(server.writes).toEqual([])
    })
  })

  test("marks a changed canonical revision stale without writing", async () => {
    await withFixture(async ({ store, intelligence, meetingID, server }) => {
      await intelligence.analyze(meetingID, true)
      const proposal = store.proposals(meetingID)[0]!
      server.document = { id: "doc-1", revision: "r2", content: "Changed by another editor" }

      await intelligence.review(meetingID, proposal.id, true)

      expect(store.proposals(meetingID)[0]).toMatchObject({ status: "stale" })
      expect(store.approvals(meetingID).map((approval) => approval.decision)).toEqual(["approve"])
      expect(server.writes).toEqual([])
      expect(server.document.content).toBe("Changed by another editor")
    })
  })

  test("marks pre-write document-read failures failed and never writes", async () => {
    await withFixture(async ({ store, intelligence, meetingID, server }) => {
      await intelligence.analyze(meetingID, true)
      const proposal = store.proposals(meetingID)[0]!
      server.missingDocument = true

      await expect(intelligence.review(meetingID, proposal.id, true)).rejects.toThrow("MCP knowledge operation failed")

      expect(store.proposals(meetingID)[0]).toMatchObject({
        status: "failed",
        error: "Pre-write verification failed; no write was attempted. Review again before retrying.",
      })
      expect(store.approvals(meetingID).map((approval) => approval.decision)).toEqual(["approve"])
      expect(server.writes).toEqual([])
    })
  })

  test("writes with the reviewed expected revision and persists the verified read-back", async () => {
    await withFixture(async ({ store, intelligence, meetingID, server }) => {
      await intelligence.analyze(meetingID, true)
      const proposal = store.proposals(meetingID)[0]!

      await intelligence.review(meetingID, proposal.id, true)

      expect(server.writes).toEqual([{ id: "doc-1", content: "Replacement content", expectedRevision: "r1" }])
      expect(server.document).toEqual({ id: "doc-1", revision: "r2", content: "Replacement content" })
      expect(store.proposals(meetingID)[0]?.status).toBe("applied")
      expect(store.references(meetingID)[0]).toMatchObject({ revision: "r2", content: "Replacement content" })
      expect(store.approvals(meetingID).map((approval) => approval.decision)).toEqual(["approve"])
    })
  })

  test.each(["write", "read-back"] as const)(
    "records uncertain outcome after %s failure without replay",
    async (failure) => {
      await withFixture(async ({ store, intelligence, meetingID, server }) => {
        await intelligence.analyze(meetingID, true)
        const proposal = store.proposals(meetingID)[0]!
        server.failure = failure

        await intelligence.review(meetingID, proposal.id, true)

        expect(store.proposals(meetingID)[0]).toMatchObject({ status: "uncertain" })
        expect(server.writes).toHaveLength(1)
        expect(store.approvals(meetingID).map((approval) => approval.decision)).toEqual(["approve"])
        await expect(intelligence.review(meetingID, proposal.id, true)).rejects.toThrow("not awaiting review")
        expect(server.writes).toHaveLength(1)
      })
    },
  )

  test("rejects a model-supplied approval status", async () => {
    const extraction = JSON.parse(proposalExtraction()) as { proposals: Array<Record<string, unknown>> }
    extraction.proposals[0]!.status = "approved"

    await withFixture(async ({ store, intelligence, meetingID, server }) => {
      intelligence.options.generate = async () => JSON.stringify(extraction)

      await expect(intelligence.analyze(meetingID, true)).rejects.toThrow()

      expect(store.proposals(meetingID)).toEqual([])
      expect(store.approvals(meetingID)).toEqual([])
    })
  })
})

interface KnowledgeServer {
  document: { id: string; revision: string; content: string }
  missingDocument: boolean
  readCalls: number
  failure?: "write" | "read-back"
  searchRequests: Array<Record<string, unknown>>
  readRequests: string[]
  writes: Array<{ id: string; content: string; expectedRevision: string }>
  close: () => Promise<void>
  url: string
}

async function withFixture<A>(
  run: (input: {
    meetingID: string
    store: MeetingStore
    reopen: () => MeetingStore
    intelligence: MeetingIntelligence
    server: KnowledgeServer
  }) => Promise<A>,
  options: { withWriteTool?: boolean; writerSchemaValid?: boolean } = {},
) {
  const directory = mkdtempSync(path.join(tmpdir(), "meeting-mcp-"))
  const server = await knowledgeServer(options)
  const file = path.join(directory, "meetings.sqlite")
  const resource = { directory, store: new MeetingStore(file), server }
  const store = resource.store
  store.createMeeting({ id: "meeting-1", title: "Meeting", sessionID: "session-1" })
  store.putSegment({
    id: "segment-1",
    meetingID: "meeting-1",
    sequence: 1,
    source: "remote",
    speakerID: "remote",
    startMs: 0,
    endMs: 1000,
    rawText: "We discussed the deployment",
    text: "We discussed the deployment",
    state: "final",
    model: "fixture",
    createdAt: new Date().toISOString(),
  } satisfies TranscriptSegment)
  resources.push(resource)

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* MCP.Service
        yield* service.connect("knowledge")
        const tools = yield* service.tools()
        expect(yield* service.servers()).toMatchObject([{ name: "knowledge", status: { status: "connected" } }])
        expect(tools.map((tool) => tool.name)).toContain("search")
        const intelligence = new MeetingIntelligence({
          store,
          generate: async () => proposalExtraction(),
          mcp: {
            tools: () => Effect.runPromise(service.tools()),
            callTool: (input) => Effect.runPromise(service.callTool(input)),
          },
          bindings: [{ server: "knowledge", search: "search", read: "read", write: "write" }],
          maxCharacters: 32000,
          retrievalTTL: 0,
        })
        return yield* Effect.promise(() =>
          run({
            meetingID: "meeting-1",
            store,
            reopen: () => {
              resource.store.close()
              resource.store = new MeetingStore(file)
              return resource.store
            },
            intelligence,
            server,
          }),
        )
      }).pipe(Effect.provide(knowledgeLayer(server.url))),
    ),
  )
}

function proposalExtraction() {
  return JSON.stringify({
    summary: "Deployment was discussed",
    findings: [],
    proposals: [
      {
        server: "knowledge",
        target: "doc-1",
        suggestedContent: "Replacement content",
        explanation: "The meeting agreed",
        sourceSegmentIds: ["segment-1"],
        confidence: 0.9,
      },
    ],
  })
}

async function knowledgeServer(
  options: { withWriteTool?: boolean; writerSchemaValid?: boolean } = {},
): Promise<KnowledgeServer> {
  const protocol = new Server({ name: "meeting-knowledge", version: "1.0.0" }, { capabilities: { tools: {} } })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  })
  await protocol.connect(transport)
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => transport.handleRequest(request),
  })
  const state: KnowledgeServer = {
    document: { id: "doc-1", revision: "r1", content: "Original canonical content" },
    missingDocument: false,
    readCalls: 0,
    searchRequests: [],
    readRequests: [],
    writes: [],
    close: async () => {
      await protocol.close()
      await http.stop(true)
    },
    url: "",
  }
  const tools = [
    {
      name: "search",
      description: "Find knowledge documents",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer" } },
        required: ["query", "limit"],
        additionalProperties: false,
      },
    },
    {
      name: "read",
      description: "Read a knowledge document",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    ...(options.withWriteTool === false
      ? []
      : [
          {
            name: "write",
            description: "Replace a knowledge document with revision check",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" }, content: { type: "string" }, expectedRevision: { type: "string" } },
              required: options.writerSchemaValid === false ? ["id", "content"] : ["id", "content", "expectedRevision"],
              additionalProperties: false,
            },
          },
        ]),
  ]
  protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools }))
  protocol.setRequestHandler(CallToolRequestSchema, ({ params }) => {
    const args = params.arguments ?? {}
    if (params.name === "search") {
      state.searchRequests.push(args)
      return Promise.resolve(result({ documents: [{ id: "doc-1" }] }))
    }
    if (params.name === "read") {
      state.readCalls += 1
      state.readRequests.push(String(args.id))
      if (state.missingDocument || (state.failure === "read-back" && state.readCalls >= 3))
        return Promise.resolve(failure("Document not available"))
      return Promise.resolve(result(state.document))
    }
    if (params.name === "write") {
      const write = {
        id: String(args.id),
        content: String(args.content),
        expectedRevision: String(args.expectedRevision),
      }
      state.writes.push(write)
      if (write.id !== state.document.id || write.expectedRevision !== state.document.revision)
        return Promise.resolve(failure("Revision conflict"))
      state.document = { id: write.id, revision: "r2", content: write.content }
      return Promise.resolve(state.failure === "write" ? failure("Write result unavailable") : result({ ok: true }))
    }
    return Promise.resolve(failure("Unknown operation"))
  })
  state.url = http.url.toString()
  return state
}

function result(structuredContent: unknown) {
  return { structuredContent, content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }] }
}

function failure(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] }
}

function knowledgeLayer(url: string) {
  const unusedIntegration = () => Effect.die("unused Integration method")
  return MCP.layer.pipe(
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
                    mcp: new ConfigMCP.Info({
                      servers: {
                        knowledge: new ConfigMCP.Remote({ type: "remote", url, oauth: false, disabled: true }),
                      },
                    }),
                  }),
                }),
              ]),
          }),
        ),
        Layer.succeed(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
        ),
        Layer.mock(SessionAutonomy.Service, { get: () => Effect.succeed(SessionAutonomy.defaultState) }),
        Layer.mock(EventRuntime.Service, {
          subscribe: () => Stream.never,
          publish: (definition, data) =>
            Effect.succeed({
              id: EventRuntime.ID.create(),
              type: definition.type,
              data,
            } as EventRuntime.Payload<typeof definition>),
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
          command: { connect: unusedIntegration, status: unusedIntegration, cancel: unusedIntegration },
        }),
        Layer.mock(Credential.Service, {}),
      ),
    ),
  )
}
