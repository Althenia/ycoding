import { expect, test } from "bun:test"
import { remoteControlTransport } from "../src/remote-control/bootstrap"
import { unavailableConversation } from "./fixture/cca-scope"

const computer = {
  computer: async () => ({ state: "attached" as const }),
  attach: async () => ({ state: "attached" as const }),
  detach: async () => ({ state: "detached" as const }),
  remove: async () => ({ state: "removed" as const }),
}

test("status keeps the registered name separate from hostname", async () => {
  const transport = remoteControlTransport(async () => ({ state: "on", serverName: "box.local", name: "Registered desk" }), computer, unavailableConversation)
  expect(await transport.status()).toEqual({ state: "connected", hostname: "box.local", name: "Registered desk" })
})

test.each([
  { state: "off", expected: "off" },
  { state: "connecting", expected: "connecting" },
  { state: "on", expected: "connected" },
  { state: "error", expected: "error", problem: "configuration" },
  { state: "error", expected: "error", problem: "authentication" },
  { state: "error", expected: "error", problem: "enrollment" },
  { state: "error", expected: "error", problem: "connection" },
] as const)("status adapter exposes only closed transport fields: %j", async (input) => {
  const transport = remoteControlTransport(async () => ({
    state: input.state, serverName: "fixture.local", profile: "synthetic-private-profile", environmentID: "synthetic-private-environment", message: "synthetic-private-error",
    ...("problem" in input ? { problem: input.problem } : {}),
  }), computer, unavailableConversation)
  expect(await transport.status()).toEqual({
    state: input.expected, hostname: "fixture.local", ...("problem" in input ? { problem: input.problem } : {}),
  })
})

test("status adapter bounds unexpected failures to a typed connection problem", async () => {
  const transport = remoteControlTransport(async () => { throw Error("synthetic-private-error") }, computer, unavailableConversation)
  expect(await transport.status()).toEqual({ state: "error", problem: "connection" })
})
