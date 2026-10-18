import { expect, test } from "bun:test"
import { Effect } from "effect"
import { McpEvents } from "@ycoding-ai/protocol/groups/mcp-events"
import { SessionMcpEvents } from "@ycoding-ai/core/mcp-events/index"
import { McpEventsAuthorization } from "../src/mcp-events-authorization"
import { RemoteConnection } from "../src/remote-connection"

const context = { requestID: "request_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" }, epoch: "epoch_fixture" }
const principal = { ...context.principal, epoch: context.epoch, grantID: "grant_fixture" }

test("an unavailable connector keeps Events disabled", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const authorization = yield* SessionMcpEvents.Authorization.Service
    expect(yield* authorization.capabilities).toBe(false)
    return yield* authorization.resolve(context).pipe(Effect.result)
  }).pipe(Effect.provide(McpEventsAuthorization.layer(RemoteConnection.unavailable))))
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "McpEvents.Failure", category: "unavailable", reason: "authorization_unavailable" } })
})

test("fresh grant checks preserve scope and the connector cancellation signal", async () => {
  const calls: unknown[] = []
  const controller = new AbortController()
  await Effect.runPromise(Effect.gen(function* () {
    const authorization = yield* SessionMcpEvents.Authorization.Service
    expect(yield* authorization.capabilities).toBe(true)
    expect(yield* authorization.resolve(context)).toEqual({ grantID: "grant_fixture", expiresAt: 1000 })
    const checked = yield* authorization.check(principal)
    expect(checked.expiresAt).toBe(1000)
    expect(checked.signal).toBe(controller.signal)
    controller.abort()
    expect(checked.signal?.aborted).toBe(true)
  }).pipe(Effect.provide(McpEventsAuthorization.layer({
    ...RemoteConnection.unavailable,
    mcpEvents: {
      capabilities: async () => true,
      resolve: async (input, signal) => { calls.push(input); expect(signal).toBeInstanceOf(AbortSignal); return { grantID: "grant_fixture", expiresAt: 1000 } },
      check: async (input, signal) => { calls.push(input); expect(signal).toBeInstanceOf(AbortSignal); return { expiresAt: 1000, signal: controller.signal } },
    },
  }))))
  expect(calls).toEqual([context, principal])
})

test("typed revocation remains distinct from unavailable transport without leaking its cause", async () => {
  for (const error of [new Error("fixture-private-credential"), new McpEvents.Failure({ category: "unauthorized", reason: "grant_revoked" })]) {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const authorization = yield* SessionMcpEvents.Authorization.Service
      return yield* authorization.check(principal).pipe(Effect.result)
    }).pipe(Effect.provide(McpEventsAuthorization.layer({
      ...RemoteConnection.unavailable,
      mcpEvents: {
        capabilities: async () => { throw error },
        resolve: async () => { throw error },
        check: async () => { throw error },
      },
    }))))
    expect(result).toMatchObject({ _tag: "Failure", failure: { category: error instanceof McpEvents.Failure ? "unauthorized" : "unavailable" } })
    expect(JSON.stringify(result)).not.toContain("fixture-private-credential")
  }
})
