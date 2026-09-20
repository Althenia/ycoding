import { describe, expect, test } from "bun:test"
import { relayTargets, smokeHostname, smokeSignal } from "../src/policy"

describe("Cloudflare relay smoke policy", () => {
  test("allows the development Worker and local Wrangler hosts but not the production domain", () => {
    expect(smokeHostname("ycoding-cloud.lostq901.workers.dev")).toBe(true)
    expect(smokeHostname("localhost")).toBe(true)
    expect(smokeHostname("127.0.0.1")).toBe(true)
    expect(smokeHostname("ycoding.althenia.app")).toBe(false)
    expect(smokeHostname("evil-ycoding-cloud.lostq901.workers.dev")).toBe(false)
  })

  test("accepts only the exact ping-pong smoke protocol", () => {
    expect(smokeSignal('{"type":"ping"}')).toEqual({ type: "ping" })
    expect(smokeSignal('{"type":"pong"}')).toEqual({ type: "pong" })
    expect(smokeSignal('{"type":"ping","session":"ses_secret"}')).toBeUndefined()
    expect(smokeSignal('{"type":"message","payload":"tool output"}')).toBeUndefined()
    expect(smokeSignal(new Uint8Array([1, 2, 3]).buffer)).toBeUndefined()
  })

  test("routes client ping through the agent and agent pong back to clients", () => {
    expect(relayTargets("agent", { type: "ping" })).toEqual(["self"])
    expect(relayTargets("client", { type: "ping" })).toEqual(["agent"])
    expect(relayTargets("agent", { type: "pong" })).toEqual(["client"])
    expect(relayTargets("client", { type: "pong" })).toEqual([])
  })
})
