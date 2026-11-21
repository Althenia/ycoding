import { expect, test } from "bun:test"
import { YCoding } from "@ycoding-ai/client/promise"
import { makeAuthority } from "@ycoding-ai/core/interaction/authority"
import { chromeConnectPath, chromeExtensionID } from "@ycoding-ai/core/interaction/chrome"
import { Interaction, InteractionRuntime } from "@ycoding-ai/core/interaction/index"
import { Layer } from "effect"
import { mkdtempDisposable, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalServer } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"
import { auth, createSession, password, startServer } from "./remote-harness"

test.skipIf(process.platform !== "darwin")("Chrome enrollment does not mount a peer route without the signed helper", async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), "ycoding-interaction-peer-"))
  const directory = await realpath(scratch.path)
  const options = {
    macOS: { application: join(directory, "YCoding Interaction.app"), certificateSHA1: "0".repeat(40) },
  }
  const server = await startServer(directory, { interactionPlatforms: options })
  try {
    const route = server.base + chromeConnectPath
    const origin = `chrome-extension://${chromeExtensionID}`
    expect((await fetch(route, { headers: { origin } })).status).toBe(404)
    expect((await fetch(`${route}?extra=1`, { headers: { origin } })).status).toBe(401)
  } finally {
    await server.close()
  }
}, 30_000)

test("direct and connector Stop use the same authenticated server and exact pending generation", async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), "ycoding-interaction-auth-"))
  const directory = await realpath(scratch.path)
  const authority = makeAuthority()
  const native = authority.register({
    platform: "chrome",
    inventory: async () => [],
    attach: async () => { throw new Error("No native consent in this test") },
    observe: async () => { throw new Error("No active target") },
    perform: async () => { throw new Error("No active target") },
    preview: async () => undefined,
    resume: async () => false,
    detach: async () => {},
  })
  const server = await startServer(directory, { replacements: [[InteractionRuntime.node, Layer.succeed(InteractionRuntime.Service, authority)]] })
  try {
    const sessionID = "ses_interaction_stop_owner"
    await createSession(server, sessionID, directory)
    const client = YCoding.make({ baseUrl: server.base, headers: { authorization: auth } })
    const first = await client.sessionInteraction.request({ sessionID, payload: { platform: "chrome" } })
    if (first.state !== "pending") throw new Error("Expected pending consent")
    const stopPath = `/api/session/${sessionID}/interaction/stop`
    const stop = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ generation: first.generation }) }
    expect((await fetch(server.base + stopPath, stop)).status).toBe(401)
    expect((await fetch(server.base + stopPath, { ...stop, headers: { ...stop.headers, authorization: "Basic eDp4" } })).status).toBe(401)
    expect(await client.sessionInteraction.status({ sessionID })).toEqual(first)
    expect((await server.request(stopPath, { ...stop, body: JSON.stringify({ generation: Interaction.Generation.create() }) })).status).toBe(409)
    expect(await client.sessionInteraction.stop({ sessionID, generation: first.generation })).toMatchObject({ state: "stopped", reason: "stopped" })
    const second = await client.sessionInteraction.request({ sessionID, payload: { platform: "chrome" } })
    if (second.state !== "pending") throw new Error("Expected a new pending generation")
    expect(second.generation).not.toBe(first.generation)
    const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
    const sessions = createSessionRegistry({ local })
    await sessions.refresh()
    const subscriptions = createSubscriptions()
    const run = async (generation: string) => (await executeRemoteOperation({ local, sessions, subscriptions, request: {
      type: "request", id: crypto.randomUUID(), operation: "session.interaction.stop", sessionID, input: { generation },
    } }))[0]
    expect(await run(first.generation)).toMatchObject({ ok: false, error: { code: "invalid_message", message: expect.stringContaining("conflicting request") } })
    expect(await client.sessionInteraction.status({ sessionID })).toEqual(second)
    expect(await run(second.generation)).toMatchObject({ ok: true, value: { data: { state: "stopped", generation: second.generation } } })
    expect(await client.sessionInteraction.status({ sessionID })).toMatchObject({ state: "stopped", generation: second.generation })
    expect(native.pending()).toEqual([])
  } finally {
    native.disconnect()
    await server.close()
  }
}, 30_000)
