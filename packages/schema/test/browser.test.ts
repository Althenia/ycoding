import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Browser } from "../src/browser.js"

const tab = {
  id: "btab_contract",
  sessionID: "ses_contract",
  title: "Fixture",
  page: { origin: "https://example.test", path: "/form" },
  status: "shared",
  generation: 1,
  documentGeneration: 2,
  observationRevision: 3,
}

describe("Browser selected-tab contract", () => {
  test("exposes only safe tab metadata and explicit ownership generations", () => {
    expect(Schema.decodeUnknownSync(Browser.Tab)(tab as unknown) as unknown).toEqual(tab)
    expect(() =>
      Schema.decodeUnknownSync(Browser.Tab)({ ...tab, page: { origin: "https://x.test", path: "/?token=x" } }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(Browser.Tab)({ ...tab, sessionID: undefined })).toThrow()
  })

  test("requires fresh observation fences for semantic actions and rejects arbitrary commands", () => {
    expect(
      Schema.is(Browser.ActionInput)({
        sessionID: "ses_contract",
        tabID: "btab_contract",
        generation: 1,
        documentGeneration: 2,
        observationRevision: 3,
        callID: "call_contract",
        action: { type: "click", ref: "b1" },
      }),
    ).toBe(true)
    expect(
      Schema.is(Browser.ActionInput)({
        sessionID: "ses_contract",
        tabID: "btab_contract",
        generation: 1,
        documentGeneration: 2,
        observationRevision: 3,
        callID: "call_contract",
        action: { type: "cdp", method: "Runtime.evaluate" },
      }),
    ).toBe(false)
  })

  test("bounds observations, typed text, and explicit captures", () => {
    expect(Browser.MAX_OBSERVATION_ELEMENTS).toBeGreaterThan(0)
    expect(Browser.MAX_CAPTURE_BYTES).toBeLessThanOrEqual(1024 * 1024)
    expect(
      Schema.is(Browser.ActionInput)({
        sessionID: "ses_contract",
        tabID: "btab_contract",
        generation: 1,
        documentGeneration: 2,
        observationRevision: 3,
        callID: "call_contract",
        action: { type: "type", ref: "b1", text: "x".repeat(Browser.MAX_TYPE_BYTES + 1) },
      }),
    ).toBe(false)
  })

  test("keeps durable trust credentials out of the public pairing response", () => {
    expect(
      Schema.is(Browser.Pairing)({
        secret: "s".repeat(32),
        expiresAt: Date.now() + 1_000,
      }),
    ).toBe(true)
    expect(
      Schema.decodeUnknownSync(Browser.Pairing)({
        secret: "s".repeat(32),
        expiresAt: Date.now() + 1_000,
        credential: "must-not-be-public",
      }),
    ).toEqual({ secret: "s".repeat(32), expiresAt: expect.any(Number) })
  })
})
