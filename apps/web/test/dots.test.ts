import { expect, test } from "bun:test"
import { remoteDotsPeerLabel } from "@ycoding-ai/remote"
import type { RemoteLink } from "../src/remote/queries"
import { dotsClient } from "../src/remote/dots"

const scope = { deviceID: "device-1", generation: 1 }
const access = { sessionID: "ses_local", rootSessionID: "ses_local", enabled: false, revision: 2, inherited: false, configured: true }

test("reads and updates authoritative Session access with its expected revision", async () => {
  const calls: unknown[] = []
  const link: RemoteLink = { recoveries: () => 0, recovered: async () => false, request: async (_scope, operation, request) => {
    calls.push({ operation, sessionID: request?.sessionID, input: request?.input })
    return { status: "ok", value: { data: operation === "session.dots.access.get" ? access : { ...access, enabled: true, revision: 3 } } }
  } }
  const client = dotsClient(link, scope, "ses_local")
  expect(await client.get()).toEqual(access)
  expect(await client.set(true, 2)).toEqual({ status: "ok", value: { ...access, enabled: true, revision: 3 } })
  expect(calls).toEqual([{ operation: "session.dots.access.get", sessionID: "ses_local", input: undefined }, { operation: "session.dots.access.set", sessionID: "ses_local", input: { enabled: true, expectedRevision: 2 } }])
})

test("rejects another Session's response and never replays a failed mutation", async () => {
  const calls: string[] = []
  const link: RemoteLink = { recoveries: () => 0, recovered: async () => false, request: async (_scope, operation) => {
    calls.push(operation)
    return operation === "session.dots.access.get" ? { status: "ok", value: { data: { ...access, sessionID: "ses_other" } } } : { status: "unknown", error: { code: "outcome_unknown", message: "unknown" } }
  } }
  const client = dotsClient(link, scope, "ses_local")
  await expect(client.get()).rejects.toThrow("invalid Dots access")
  expect((await client.set(true, 2)).status).toBe("unknown")
  expect(calls).toEqual(["session.dots.access.get", "session.dots.access.set"])
})

test("historical peer messages retain external attribution", () => {
  const peer = { origin: "dots-peer", profile: "p", dotID: "dot-1", threadID: "thread-1", itemID: "i" }
  expect(remoteDotsPeerLabel({ dots: peer })).toBe("Dot dot-1 · external peer · thread-1")
  expect(remoteDotsPeerLabel({ dots: { ...peer, itemID: "" } })).toBeUndefined()
})
