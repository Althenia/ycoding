import { expect, spyOn, test } from "bun:test"
import type { JsonSchemaType } from "@modelcontextprotocol/client"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv"
import { ConfigMCP } from "@ycoding-ai/core/config/mcp"
import { MCPClient } from "@ycoding-ai/core/mcp/client"
import { Effect, Exit, Fiber } from "effect"
import { z } from "zod"

const RpcRequest = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
})

test.each(["anonymous", "identified"] as const)(
  "should retain only current output validators when one MCP server refreshes %s schemas",
  async (identity) => {
    const title = `schema-lifetime-${crypto.randomUUID()}`
    const observed: { latest?: AjvJsonSchemaValidator; compiled: number } = { compiled: 0 }
    const spy = spyOn(AjvJsonSchemaValidator.prototype, "getValidator")
    const getValidator = spy.getMockImplementation()
    if (!getValidator) throw new Error("Expected the schema compiler")
    spy.mockImplementation(function <T>(this: AjvJsonSchemaValidator, schema: JsonSchemaType) {
      observed.latest = this
      observed.compiled++
      return getValidator.bind(this)<T>(schema)
    })
    let revision = 0
    let listings = 0
    let calls = 0
    let closed = 0
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* MCPClient.connect(
              title,
              new ConfigMCP.Remote({ type: "remote", url: `https://mcp.invalid/${title}`, oauth: false }),
              "/fixture",
              {
                fetch: async (input, init) => {
                  const request = new Request(String(input), init)
                  if (request.method === "GET") return new Response(null, { status: 405 })
                  const rpc = RpcRequest.parse(await request.json())
                  if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 })
                  let result: unknown
                  if (rpc.method === "initialize")
                    result = {
                      protocolVersion: "2025-11-25",
                      serverInfo: { name: title, version: "1" },
                      capabilities: { tools: {} },
                    }
                  else if (rpc.method === "tools/list") {
                    listings++
                    result = {
                      tools: [
                        {
                          name: "current",
                          inputSchema: { type: "object" },
                          outputSchema: {
                            ...(identity === "identified" ? { $id: `https://mcp.invalid/${title}/output` } : {}),
                            title,
                            type: "object",
                            properties: { revision: { type: "integer", const: revision } },
                            required: ["revision"],
                          },
                        },
                      ],
                      ttlMs: 0,
                      cacheScope: "private",
                    }
                  } else if (rpc.method === "tools/call") {
                    calls++
                    const responseRevision = revision
                    if (calls === 1) {
                      entered.resolve()
                      await release.promise
                    }
                    result = { content: [], structuredContent: { revision: responseRevision } }
                  } else throw new Error(`Unexpected fixture request: ${rpc.method}`)
                  return Response.json({ jsonrpc: "2.0", id: rpc.id, result })
                },
              },
              undefined,
              "legacy",
            )
            connection.onClose(() => closed++)
            expect(yield* connection.tools()).toHaveLength(1)
            const first = yield* connection.callTool({ name: "current" }).pipe(Effect.forkScoped)
            yield* Effect.promise(() => entered.promise)
            for (revision = 1; revision < 16; revision++) {
              const tools = yield* connection.tools()
              expect(tools).toHaveLength(1)
              expect(tools[0].outputSchema).toMatchObject({ properties: { revision: { const: revision } } })
              const result = yield* connection.callTool({ name: "current" }).pipe(Effect.exit)
              expect(Exit.isSuccess(result)).toBe(true)
              if (Exit.isSuccess(result)) expect(result.value.structured).toEqual({ revision })
            }
            release.resolve()
            const original = yield* Fiber.join(first).pipe(Effect.exit)
            expect(Exit.isSuccess(original)).toBe(true)
            if (Exit.isSuccess(original)) expect(original.value.structured).toEqual({ revision: 0 })
            expect(listings).toBe(16)
            expect(calls).toBe(16)
            expect(observed.compiled).toBe(16)
            if (!observed.latest) throw new Error("Expected output-schema validation")
            const engine: unknown = Reflect.get(observed.latest, "ajv")
            if (engine === null || typeof engine !== "object") throw new Error("Expected the validator engine")
            const cache: unknown = Reflect.get(engine, "_cache")
            if (!(cache instanceof Map)) throw new Error("Expected the validator's schema cache")
            const schemas: unknown[] = Array.from(cache.keys())
            const owned = schemas.filter(
              (schema) => schema !== null && typeof schema === "object" && Reflect.get(schema, "title") === title,
            )
            expect(owned).toHaveLength(1)
            expect(owned[0]).toMatchObject({ properties: { revision: { const: 15 } } })
            const invalid = yield* connection.callTool({ name: "current" }).pipe(Effect.exit)
            expect(Exit.isFailure(invalid)).toBe(true)
            expect(calls).toBe(17)
          }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())), Effect.timeout("5 seconds")),
        ),
      )
      expect(closed).toBe(1)
    } finally {
      spy.mockRestore()
    }
  },
)
