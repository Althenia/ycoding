import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import type { DotsAccess } from "@ycoding-ai/core/dots/access"
import { remoteControlTransport, startNativeRemoteControl } from "../src/remote-control/bootstrap"

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
  }))
  expect(await transport.status()).toEqual({
    state: input.expected, hostname: "fixture.local", ...("problem" in input ? { problem: input.problem } : {}),
  })
})

test("status adapter bounds unexpected failures to a typed connection problem", async () => {
  const transport = remoteControlTransport(async () => { throw Error("synthetic-private-error") })
  expect(await transport.status()).toEqual({ state: "error", problem: "connection" })
})

test.each([false, true])("bootstrap registers the existing host status and unregisters on cleanup or startup failure: %s", async (fails) => {
  const events: string[] = []
  let transport: DotsAccess.Transport | undefined
  const native: NativeDots.Host = {
    configuration: async () => ({ enabled: false }),
    credential: async () => undefined,
    subscribeConfiguration: () => {
      events.push("subscribe")
      if (fails) throw Error("Synthetic startup failure")
      return () => { events.push("unsubscribe") }
    },
    attach: async () => { throw Error("Unexpected attachment") },
    attachTransport: (value) => { transport = value; events.push("attach"); return () => { events.push("detach"); transport = undefined } },
  }
  const input = {
    native, stateDirectory: await mkdtemp(path.join(tmpdir(), "ycoding-rc-bootstrap-")), codexHome: "/synthetic", onDiagnostic: () => {},
  }
  if (fails) {
    const failure = await startNativeRemoteControl(input).then(async (stop) => { await stop(); return undefined }, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: "Synthetic startup failure" })
    expect(events).toEqual(["attach", "subscribe", "detach"])
    expect(transport).toBeUndefined()
    return
  }
  const stop = await startNativeRemoteControl(input)
  expect(events).toEqual(["attach", "subscribe"])
  expect(await transport?.status()).toMatchObject({ state: "off", hostname: expect.any(String) })
  await stop()
  expect(events).toEqual(["attach", "subscribe", "detach", "unsubscribe"])
  expect(transport).toBeUndefined()
})
