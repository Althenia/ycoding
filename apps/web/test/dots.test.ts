import { expect, test } from "bun:test"
import { remoteDotsPeerLabel, type RemoteDotsStatus } from "@ycoding-ai/remote"
import type { RemoteLink } from "../src/remote/queries"
import { dotsClient } from "../src/remote/dots"

const scope = { deviceID: "device-1", generation: 1 }
const status = { access: { enabled: false, revision: 2 }, configuration: { ready: true, profile: "native-test" }, connection: { state: "off", hostname: "test-computer" } } satisfies RemoteDotsStatus

test("reads and updates global Dots status without Session or Location", async () => {
  const calls: unknown[] = []
  const link: RemoteLink = { recoveries: () => 0, recovered: async () => false, request: async (_scope, operation, request) => {
    calls.push({ operation, sessionID: request?.sessionID, input: request?.input })
    return { status: "ok", value: { data: operation === "dots.get" ? status : { ...status, access: { enabled: true, revision: 3 }, connection: { state: "connecting" } } } }
  } }
  const client = dotsClient(link, scope)
  expect(await client.get()).toEqual(status)
  expect(await client.set(true, 2)).toEqual({ status: "ok", value: { ...status, access: { enabled: true, revision: 3 }, connection: { state: "connecting" } } })
  expect(calls).toEqual([{ operation: "dots.get", sessionID: undefined, input: undefined }, { operation: "dots.set", sessionID: undefined, input: { enabled: true, expectedRevision: 2 } }])
})

test("rejects malformed status and never replays an unknown mutation", async () => {
  const calls: string[] = []
  const link: RemoteLink = { recoveries: () => 0, recovered: async () => false, request: async (_scope, operation) => {
    calls.push(operation)
    return operation === "dots.get" ? { status: "ok", value: { data: { ...status, connection: { state: "invented" } } } } : { status: "unknown", error: { code: "outcome_unknown", message: "unknown" } }
  } }
  const client = dotsClient(link, scope)
  await expect(client.get()).rejects.toThrow("invalid Dots status")
  expect((await client.set(true, 2)).status).toBe("unknown")
  expect(calls).toEqual(["dots.get", "dots.set"])
})

test("historical peer messages retain external attribution", () => {
  const peer = { origin: "dots-peer", profile: "p", dotID: "dot-1", threadID: "thread-1", itemID: "i" }
  expect(remoteDotsPeerLabel({ dots: peer })).toBe("Dot dot-1 · external peer · thread-1")
  expect(remoteDotsPeerLabel({ dots: { ...peer, itemID: "" } })).toBeUndefined()
})
