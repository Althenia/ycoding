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
  expect(group["browser.open"].path).toBe("/api/session/:sessionID/browser/open")
  expect(group["browser.close"].path).toBe("/api/session/:sessionID/browser/close")
  expect(group["browser.release"].path).toBe("/api/session/:sessionID/browser/release")
  expect(group["browser.release"].method).toBe("POST")
  expect(Schema.is(payload(group["browser.release"]))({ tabID: "btab_profile", generation: 1, callID: "one" })).toBe(true)
  expect(Schema.is(payload(group["browser.release"]))({ tabID: "tab_profile", generation: 1, callID: "one" })).toBe(false)
  expect(Schema.is(payload(group["browser.open"]))({ generation: 1, url: "https://example.test", callID: "one" })).toBe(true)
  expect(group["browser.action"].method).toBe("POST")
  expect(group["browser.forget"].path).toBe("/api/session/:sessionID/browser/pairing")
  expect(group["browser.forget"].method).toBe("DELETE")
  expect(group["browser.connect"].path).toBe("/api/browser/connect")
  expect(Schema.is(payload(group["browser.control"]))({ action: "pause" })).toBe(true)
  expect(Schema.is(payload(group["browser.control"]))({ action: "activate-tab" })).toBe(false)
})

test("browser action payload accepts form-control and wait actions and rejects combined wait conditions", () => {
  const action = payload(group["browser.action"])
  const base = { tabID: "btab_profile", generation: 1, documentGeneration: 1, observationRevision: 1, callID: "one" }
  for (const item of [
    { type: "fill", ref: "b1", text: "synthetic" },
    { type: "select", ref: "b1", labels: ["Small"] },
    { type: "check", locator: 'role=checkbox[name="Agree"]', checked: true },
    { type: "hover", ref: "b2" },
    { type: "wait", locator: 'role=heading[name="Done"]', state: "visible" },
    { type: "wait", url: "https://example.test/*" },
    { type: "wait", load: "networkidle", timeoutMs: 1000 },
    { type: "wait", text: "Saved" },
  ])
    expect(Schema.is(action)({ ...base, action: item }), JSON.stringify(item)).toBe(true)
  for (const item of [
    { type: "wait", text: "Saved", load: "load" },
    { type: "wait", ref: "b1", url: "https://example.test/*" },
    { type: "wait", state: "hidden" },
    { type: "select", ref: "b1", values: ["a"], indexes: [0] },
  ])
    expect(Schema.is(action)({ ...base, action: item }), JSON.stringify(item)).toBe(false)
})

test("only the exact secret-free browser websocket path bypasses server authentication", () => {
  expect(isBrowserConnectURL(new URL("http://localhost/api/browser/connect"))).toBe(true)
  expect(isBrowserConnectURL(new URL("http://localhost/api/browser/connect?secret=leak"))).toBe(false)
  expect(isBrowserConnectURL(new URL("http://localhost/api/session/ses_owner/browser/connect"))).toBe(false)
})

test("generated clients expose HTTP browser operations but omit the extension-only WebSocket", () => {
  expect(groupNames["server.browser"]).toBe("browser")
  expect(promiseOmitEndpoints.has("browser.connect")).toBe(true)
  expect(effectOmitEndpoints.has("browser.connect")).toBe(true)
})
