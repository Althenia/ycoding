import { expect, test } from "bun:test"
import { IsolatedBrowser } from "@ycoding-ai/schema/isolated-browser"
import { Schema } from "effect"
import { makeIsolatedBrowserGroup } from "../src/groups/isolated-browser.js"
import { Authorization } from "../src/middleware/authorization.js"
import { groupNames } from "../src/client.js"

const group = makeIsolatedBrowserGroup(Authorization).endpoints

function payload(endpoint: (typeof group)[keyof typeof group]) {
  const schema = endpoint.payload.values().next().value?.schemas[0]
  if (!schema) throw new Error("endpoint has no payload schema")
  return schema
}

test("isolated browser routes are Session-scoped, explicit, and expose no raw CDP operation", () => {
  expect(group["isolatedBrowser.status"].path).toBe("/api/session/:sessionID/browser/isolated")
  expect(group["isolatedBrowser.start"].path).toBe("/api/session/:sessionID/browser/isolated/start")
  expect(group["isolatedBrowser.start"].method).toBe("POST")
  expect(group["isolatedBrowser.stop"].method).toBe("DELETE")
  const startPayload = group["isolatedBrowser.start"].payload.values().next().value?.schemas[0]
  if (!startPayload) throw new Error("isolated browser start has no payload schema")
  expect(startPayload.ast).toBe(IsolatedBrowser.StartPayload.ast)
  const decodeStart = Schema.decodeUnknownSync(IsolatedBrowser.StartPayload)
  expect(decodeStart({ url: "https://example.test/form" })).toEqual({ url: "https://example.test/form" })
  expect(() => decodeStart({ url: "file:///tmp/private" })).toThrow()
  expect(
    Schema.is(payload(group["isolatedBrowser.action"]))({
      instanceID: "ibrowser_contract",
      tabID: "btab_contract",
      generation: 1,
      documentGeneration: 1,
      observationRevision: 1,
      callID: "call_contract",
      action: { type: "cdp", method: "Runtime.evaluate" },
    }),
  ).toBe(false)
  expect(groupNames["server.isolatedBrowser"]).toBe("isolatedBrowser")
})
