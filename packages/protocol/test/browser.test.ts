import { expect, test } from "bun:test"
import { Schema } from "effect"
import { makeBrowserGroup, isBrowserConnectURL } from "../src/groups/browser.js"
import { Authorization } from "../src/middleware/authorization.js"
import { effectOmitEndpoints, groupNames, promiseOmitEndpoints } from "../src/client.js"

const group = makeBrowserGroup(Authorization).endpoints

function payload(endpoint: (typeof group)[keyof typeof group]) {
  const schema = endpoint.payload.values().next().value?.schemas[0]
  if (!schema) throw new Error("endpoint has no payload schema")
  return schema
}

test("browser routes are Session-scoped and expose bounded typed operations", () => {
  expect(group["browser.status"].path).toBe("/api/session/:sessionID/browser")
  expect(group["browser.start"].method).toBe("POST")
  expect(group["browser.observe"].method).toBe("POST")
  expect(group["browser.action"].method).toBe("POST")
  expect(group["browser.forget"].path).toBe("/api/session/:sessionID/browser/pairing")
  expect(group["browser.forget"].method).toBe("DELETE")
  expect(Schema.is(payload(group["browser.control"]))({ action: "pause" })).toBe(true)
  expect(Schema.is(payload(group["browser.control"]))({ action: "activate-tab" })).toBe(false)
})

test("only the exact secret-free browser websocket path bypasses server authentication", () => {
  expect(isBrowserConnectURL(new URL("http://localhost/api/session/ses_owner/browser/connect"))).toBe(true)
  expect(isBrowserConnectURL(new URL("http://localhost/api/session/ses_owner/browser/connect?secret=leak"))).toBe(false)
  expect(isBrowserConnectURL(new URL("http://localhost/api/session/ses_owner/browser"))).toBe(false)
})

test("generated clients expose HTTP browser operations but omit the extension-only WebSocket", () => {
  expect(groupNames["server.browser"]).toBe("browser")
  expect(promiseOmitEndpoints.has("browser.connect")).toBe(true)
  expect(effectOmitEndpoints.has("browser.connect")).toBe(true)
})
