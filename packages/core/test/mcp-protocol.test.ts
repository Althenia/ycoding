import path from "node:path"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import {
  createMcpHandler,
  PROTOCOL_VERSION_META_KEY,
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server"
import { ConfigMCP } from "@ycoding-ai/core/config/mcp"
import { MCPClient } from "@ycoding-ai/core/mcp/client"
import { Deferred, Effect, Exit } from "effect"
import { z } from "zod"

const MODERN = "2026-07-28"
const LEGACY = "2025-11-25"
const Meta = z.record(z.string(), z.unknown())
const Body = z.object({ method: z.string(), params: Meta.optional() })

type Received = {
  readonly method: string
  readonly header: string | null
  readonly envelope: unknown
  readonly params: Record<string, unknown> | undefined
}

function protocolServer(version: () => string | undefined) {
  const server = new Server({ name: "protocol", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler("tools/list", () => ({
    tools: [{ name: "protocol", inputSchema: { type: "object" as const } }],
  }))
  server.setRequestHandler("tools/call", (_request, ctx) => {
    const envelope: Record<string, unknown> | undefined = ctx.mcpReq.envelope
    const claimed = envelope?.[PROTOCOL_VERSION_META_KEY]
    return { content: [{ type: "text" as const, text: typeof claimed === "string" ? claimed : String(version()) }] }
  })
  return server
}

function httpServer(era: "modern" | "legacy") {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const received: Received[] = []
      const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
      const renewal = {
        refuse: false,
        held: undefined as PromiseWithResolvers<void> | undefined,
      }
      const modern = createMcpHandler(() => protocolServer(() => undefined), { legacy: "reject" })
      const legacy = async (request: Request, method: string | undefined) => {
        const sessionID = request.headers.get("mcp-session-id")
        if (sessionID !== null) {
          const transport = sessions.get(sessionID)
          if (transport) return transport.handleRequest(request)
          return Response.json(
            { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
            { status: 404 },
          )
        }
        if (renewal.refuse) return new Response("unavailable", { status: 503 })
        if (method === "initialize") await renewal.held?.promise
        const server = protocolServer(() => server.getNegotiatedProtocolVersion())
        const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, transport)
          },
        })
        await server.connect(transport)
        return transport.handleRequest(request)
      }
      const http = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const body = Body.safeParse(
            await request
              .clone()
              .json()
              .catch(() => undefined),
          )
          if (body.success)
            received.push({
              method: body.data.method,
              header: request.headers.get("mcp-protocol-version"),
              envelope: Meta.safeParse(body.data.params?._meta).data?.[PROTOCOL_VERSION_META_KEY],
              params: body.data.params,
            })
          if (body.data?.method === "notifications/cancelled") renewal.held?.resolve()
          return era === "modern" ? modern.fetch(request) : legacy(request, body.data?.method)
        },
      })
      return {
        received,
        url: http.url.toString(),
        expireSessions: (options: { readonly refuse?: boolean; readonly holdUntilCancelled?: boolean } = {}) => {
          sessions.clear()
          renewal.refuse = options.refuse === true
          renewal.held = options.holdUntilCancelled ? Promise.withResolvers<void>() : undefined
        },
        close: async () => {
          await modern.close()
          await http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

const stdio = (era: "modern" | "legacy" | "exits" | "silent" | "unsupported", log: string, startup?: number) =>
  MCPClient.connect(
    "protocol",
    new ConfigMCP.Local({
      type: "local",
      command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-protocol.ts")],
      environment: { MCP_PROTOCOL_ERA: era, MCP_PROTOCOL_LOG: log },
      ...(startup === undefined ? {} : { timeout: new ConfigMCP.Timeout({ startup }) }),
    }),
    import.meta.dir,
  )

const remote = (url: string, execution?: number) =>
  MCPClient.connect(
    "protocol",
    new ConfigMCP.Remote({
      type: "remote",
      url,
      oauth: false,
      ...(execution === undefined ? {} : { timeout: new ConfigMCP.Timeout({ execution }) }),
    }),
    import.meta.dir,
  )

const negotiated = (connection: MCPClient.Connection, args?: Record<string, unknown>) =>
  connection
    .callTool({ name: "protocol", args })
    .pipe(Effect.map((result) => result.content.flatMap((part) => (part.type === "text" ? [part.text] : []))))

const connectStdio = (era: "modern" | "legacy" | "exits" | "silent" | "unsupported", log: string, startup?: number) =>
  Effect.runPromise(
    Effect.scoped(stdio(era, log, startup).pipe(Effect.flatMap((connection) => negotiated(connection)))),
  )

async function withLog(run: (log: string, lines: () => Promise<Record<string, number>>) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-mcp-protocol-"))
  const log = path.join(directory, "methods.log")
  const lines = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .reduce<Record<string, number>>((counts, line) => ({ ...counts, [line]: (counts[line] ?? 0) + 1 }), {})
  try {
    await run(log, lines)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("MCP protocol negotiation", () => {
  test("negotiates revision 2026-07-28 with a modern stdio server in one process", async () => {
    await withLog(async (log, lines) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* stdio("modern", log)
            return {
              tools: (yield* connection.tools()).map((tool) => tool.name),
              version: yield* negotiated(connection),
            }
          }),
        ),
      )
      expect(result).toEqual({ tools: ["protocol"], version: [MODERN] })
      expect(await lines()).toEqual({ spawn: 1 })
    })
  })

  test("falls back to the 2025-11-25 initialize handshake in the probed legacy stdio process", async () => {
    await withLog(async (log, lines) => {
      expect(await connectStdio("legacy", log)).toEqual([LEGACY])
      expect(await lines()).toMatchObject({ spawn: 1, "server/discover": 1, initialize: 1 })
    })
  })

  test("reconnects a known legacy stdio server without probing it again", async () => {
    await withLog(async (log, lines) => {
      expect(await connectStdio("legacy", log)).toEqual([LEGACY])
      expect(await connectStdio("legacy", log)).toEqual([LEGACY])
      expect(await lines()).toMatchObject({ spawn: 2, "server/discover": 1, initialize: 2 })
    })
  })

  test("starts a fresh legacy stdio process when the probed process exits", async () => {
    await withLog(async (log, lines) => {
      expect(await connectStdio("exits", log)).toEqual([LEGACY])
      expect(await lines()).toMatchObject({ spawn: 2, "server/discover": 1, initialize: 1 })
      expect(await connectStdio("exits", log)).toEqual([LEGACY])
      expect(await lines()).toMatchObject({ spawn: 3, "server/discover": 1, initialize: 2 })
    })
  })

  test("does not fall back when a stdio server supports only later revisions", async () => {
    await withLog(async (log, lines) => {
      expect(String(await connectStdio("unsupported", log).catch((error: unknown) => error))).toContain(
        "Unsupported protocol version",
      )
      expect(await lines()).toEqual({ spawn: 1, "server/discover": 1 })
    })
  })

  test("bounds the probe of a silent stdio process and starts a fresh legacy process", async () => {
    await withLog(async (log, lines) => {
      const started = performance.now()
      expect(await connectStdio("silent", log)).toEqual([LEGACY])
      expect(performance.now() - started).toBeLessThan(15_000)
      expect(await lines()).toMatchObject({ spawn: 2, "server/discover": 1, initialize: 1 })
    })
  })

  test("negotiates revision 2026-07-28 over Streamable HTTP and sends it on every request", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* httpServer("modern")
          const connection = yield* remote(server.url)
          expect(yield* negotiated(connection)).toEqual([MODERN])
          const methods = server.received.map((entry) => entry.method)
          expect(methods[0]).toBe("server/discover")
          expect(methods).toContain("tools/call")
          expect(methods).not.toContain("initialize")
          expect(server.received.map((entry) => [entry.header, entry.envelope])).toEqual(
            server.received.map(() => [MODERN, MODERN]),
          )
        }),
      ),
    )
  })

  test("falls back to the 2025-11-25 initialize handshake over Streamable HTTP", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* httpServer("legacy")
          const connection = yield* remote(server.url)
          expect(yield* negotiated(connection)).toEqual([LEGACY])
          expect(server.received.slice(0, 3).map((entry) => entry.method)).toEqual([
            "server/discover",
            "initialize",
            "notifications/initialized",
          ])
          expect(server.received[1]?.params?.protocolVersion).toBe(LEGACY)
          expect(server.received.slice(2).map((entry) => [entry.header, entry.envelope])).toEqual(
            server.received.slice(2).map(() => [LEGACY, undefined]),
          )
        }),
      ),
    )
  })

  test("re-initializes an expired legacy HTTP session and retries the request", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* httpServer("legacy")
          const connection = yield* remote(server.url)
          expect(yield* negotiated(connection)).toEqual([LEGACY])
          server.expireSessions()
          expect(yield* negotiated(connection)).toEqual([LEGACY])
          expect(server.received.filter((entry) => entry.method === "initialize")).toHaveLength(2)
        }),
      ),
    )
  })

  test("closes the connection when an expired legacy HTTP session cannot be re-initialized", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* httpServer("legacy")
          const connection = yield* remote(server.url)
          const closed = yield* Deferred.make<void>()
          connection.onClose(() => Deferred.doneUnsafe(closed, Exit.void))
          server.expireSessions({ refuse: true })
          expect((yield* negotiated(connection).pipe(Effect.flip)).message).toContain("Connection closed")
          yield* Deferred.await(closed)
        }),
      ),
    )
  })

  test("does not resend a request abandoned while its expired legacy HTTP session is renewed", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* httpServer("legacy")
          const connection = yield* remote(server.url, 200)
          expect(yield* negotiated(connection, { attempt: "warm" })).toEqual([LEGACY])
          server.expireSessions({ holdUntilCancelled: true })
          expect((yield* negotiated(connection, { attempt: "abandoned" }).pipe(Effect.flip)).message).toContain(
            "timed out",
          )
          expect(yield* negotiated(connection, { attempt: "after" })).toEqual([LEGACY])
          const attempts = server.received.flatMap((entry) =>
            entry.method === "tools/call" ? [Meta.safeParse(entry.params?.arguments).data?.attempt] : [],
          )
          expect(attempts.filter((attempt) => attempt === "abandoned")).toHaveLength(1)
          expect(attempts.at(-1)).toBe("after")
        }),
      ),
    )
  })
})
