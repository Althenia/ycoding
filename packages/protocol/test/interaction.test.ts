import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { ClientApi } from "../src/client.js"

test("Session Interaction publishes only pending request, status, preview and revocation", () => {
  const entries = Object.entries(ClientApi.groups).find(([name]) => name === "server.interaction")
  expect(entries && Object.keys(entries[1].endpoints)).toEqual([
    "session.interaction.status", "session.interaction.request", "session.interaction.preview", "session.interaction.stop",
  ])
})

test("published preview limits match the native connection budget", () => {
  const frameSchema = OpenApi.fromApi(ClientApi).components.schemas["Interaction.Frame"]
  expect(frameSchema).toMatchObject({ properties: {
    base64: { allOf: expect.arrayContaining([{ maxLength: 218_456 }, { pattern: expect.any(String) }]) },
    width: { allOf: expect.arrayContaining([{ maximum: 960 }]) },
    height: { allOf: expect.arrayContaining([{ maximum: 720 }]) },
  } })

  const base64 = Buffer.alloc(163_840).toString("base64")
  expect(Buffer.byteLength(JSON.stringify({ type: "result", id: crypto.randomUUID(), result: {
    status: "ready", frame: { mimeType: "image/jpeg", width: 960, height: 720, base64 },
  } }))).toBeLessThanOrEqual(262_144)
})
