import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Browser } from "../src/browser.js"
import { IsolatedBrowser } from "../src/isolated-browser.js"

const sessionID = "ses_isolated_contract"
const instanceID = "ibrowser_contract"
const tab = {
  id: "btab_isolated_contract",
  sessionID,
  title: "Fixture",
  page: { origin: "https://example.test", path: "/form" },
  status: "shared",
  generation: 1,
  documentGeneration: 1,
  observationRevision: 0,
}

describe("IsolatedBrowser contract", () => {
  test("requires a bounded credential-free HTTP or HTTPS start URL", () => {
    const prefix = "https://example.test/"
    const exact = `${prefix}${"x".repeat(8 * 1024 - new TextEncoder().encode(prefix).byteLength)}`
    const multibyteOver = `${prefix}${"é".repeat(Math.floor((8 * 1024 - prefix.length) / 2) + 1)}`
    const decode = Schema.decodeUnknownSync(IsolatedBrowser.StartPayload)

    expect(Schema.is(IsolatedBrowser.StartInput)({ url: "https://example.test/form" })).toBe(true)
    expect(Schema.is(IsolatedBrowser.StartInput)({ url: "https://user:secret@example.test" })).toBe(false)
    expect(Schema.is(IsolatedBrowser.StartInput)({ url: "file:///tmp/private" })).toBe(false)
    expect(Schema.is(IsolatedBrowser.StartInput)({ url: multibyteOver })).toBe(false)
    expect(decode({ url: "https://example.test/form?query=allowed" })).toEqual({
      url: "https://example.test/form?query=allowed",
    })
    expect(decode({ url: exact })).toEqual({ url: exact })
    expect(() => decode({ url: "https://user:secret@example.test" })).toThrow()
    expect(() => decode({ url: "file:///tmp/private" })).toThrow()
    expect(() => decode({ url: "not a URL" })).toThrow()
    expect(() => decode({ url: `${exact}x` })).toThrow()
    expect(() => decode({ url: multibyteOver })).toThrow()
    expect(() => Schema.encodeSync(IsolatedBrowser.StartPayload)({ url: "https://user:secret@example.test" })).toThrow()
  })

  test("identifies every isolated status and result with mode and instance identity", () => {
    expect(Schema.is(IsolatedBrowser.Status)({ mode: "isolated", state: "ready", instanceID, tab })).toBe(true)
    expect(Schema.is(IsolatedBrowser.Status)({ state: "ready", instanceID, tab })).toBe(false)
    expect(
      Schema.is(IsolatedBrowser.ActionResult)({
        mode: "isolated",
        instanceID,
        callID: "call_contract",
        tab,
        status: "rejected",
      }),
    ).toBe(true)
  })

  test("reuses bounded semantic browser operations and adds a mandatory instance fence", () => {
    expect(
      Schema.is(IsolatedBrowser.ActionInput)({
        sessionID,
        instanceID,
        tabID: tab.id,
        generation: 1,
        documentGeneration: 1,
        observationRevision: 0,
        callID: "call_contract",
        action: { type: "type", ref: "b1", text: "x".repeat(Browser.MAX_TYPE_BYTES) },
      }),
    ).toBe(true)
    expect(
      Schema.is(IsolatedBrowser.ActionInput)({
        sessionID,
        tabID: tab.id,
        generation: 1,
        documentGeneration: 1,
        observationRevision: 0,
        callID: "call_contract",
        action: { type: "click", ref: "b1" },
      }),
    ).toBe(false)
  })
})
