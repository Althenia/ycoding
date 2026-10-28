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
  test("keeps owned-tab identity optional for selected tabs and requires fenced open/close", () => {
    expect(Schema.decodeUnknownSync(Browser.Tab)(tab as unknown) as unknown).toEqual(tab)
    expect(Schema.decodeUnknownSync(Browser.Tab)({ ...tab, mode: "owned" })).toMatchObject({ mode: "owned" })
    expect(Schema.decodeUnknownSync(Browser.Tab)({ ...tab, mode: "profile" })).toMatchObject({ mode: "profile" })
    expect(Schema.is(Browser.Tab)({ ...tab, mode: "personal" })).toBe(false)
    expect(Schema.is(Browser.OpenInput)({ sessionID: tab.sessionID, generation: 1,
      url: "https://example.test/", callID: "open" })).toBe(true)
    expect(Schema.is(Browser.OpenInput)({ sessionID: tab.sessionID,
      url: "https://example.test/", callID: "open" })).toBe(false)
    expect(Schema.is(Browser.CloseInput)({ sessionID: tab.sessionID, tabID: tab.id,
      generation: 1, callID: "close" })).toBe(true)
  })
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

  test("action results do not expose the browser input transport", () => {
    const result = Schema.decodeUnknownSync(Browser.ActionResult)({
      callID: "call_contract",
      tab: { ...tab, generation: 1, documentGeneration: 2, observationRevision: 3 },
      status: "completed",
      input: "scripted",
    })
    expect(result.status).toBe("completed")
    expect("input" in result).toBe(false)
  })

  test("bounds profile tab grouping and accepts Chrome group zero", () => {
    const base = { sessionID: tab.sessionID, tabID: tab.id, generation: 1,
      documentGeneration: 2, observationRevision: 3, callID: "group" }
    expect(Schema.is(Browser.ActionInput)({ ...base, action: { type: "group",
      tabIDs: [tab.id], title: "Task" } })).toBe(true)
    expect(Schema.is(Browser.ActionInput)({ ...base, action: { type: "group",
      tabIDs: Array(9).fill(tab.id), title: "Task" } })).toBe(false)
    expect(Schema.is(Browser.ActionInput)({ ...base, action: { type: "ungroup",
      tabIDs: [tab.id], groupID: 0 } })).toBe(true)
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

  test("accepts bounded history, key, and wait actions and rejects unbounded forms", () => {
    const base = {
      sessionID: "ses_contract",
      tabID: "btab_contract",
      generation: 1,
      documentGeneration: 2,
      observationRevision: 3,
      callID: "call_contract",
    }
    for (const action of [
      { type: "back" },
      { type: "forward" },
      { type: "reload" },
      { type: "key", key: "Enter" },
      { type: "key", key: "Tab", modifiers: ["Shift"] },
      { type: "wait" },
      { type: "wait", ref: "b1", timeoutMs: Browser.MAX_WAIT_MS },
    ])
      expect(Schema.is(Browser.ActionInput)({ ...base, action }), JSON.stringify(action)).toBe(true)
    for (const action of [
      { type: "hover", ref: "b1" },
      { type: "key", key: "" },
      { type: "key", key: "Enter", modifiers: ["Hyper"] },
      { type: "wait", timeoutMs: Browser.MAX_WAIT_MS + 1 },
      { type: "wait", timeoutMs: -1 },
    ])
      expect(Schema.is(Browser.ActionInput)({ ...base, action }), JSON.stringify(action)).toBe(false)
  })

  test("bounds the readable text projection and frame completeness list", () => {
    const observation = {
      tabID: tab.id,
      generation: 1,
      documentGeneration: 2,
      revision: 3,
      title: "Fixture",
      page: tab.page,
      elements: [
        { ref: "b1", role: "button", name: "Child", frame: { origin: "https://child.example.test", path: "/tempo" } },
      ],
      texts: [{ role: "heading", name: "Shell heading" }],
      frames: [{ page: { origin: "https://child.example.test", path: "/tempo" }, observed: true }],
      truncated: false,
    }
    expect(Schema.decodeUnknownSync(Browser.Observation)(observation) as unknown).toEqual(observation)
    expect(
      Schema.is(Browser.Observation)({
        ...observation,
        texts: Array.from({ length: Browser.MAX_OBSERVATION_TEXTS + 1 }, () => ({ role: "StaticText", name: "x" })),
      }),
    ).toBe(false)
    expect(
      Schema.is(Browser.Observation)({
        ...observation,
        frames: Array.from({ length: Browser.MAX_OBSERVATION_FRAMES + 1 }, () => ({
          page: { origin: "https://child.example.test", path: "/tempo" },
          observed: false,
        })),
      }),
    ).toBe(false)
  })

  test("accepts bounded peripheral actions and rejects unbounded forms", () => {
    const base = {
      sessionID: "ses_contract",
      tabID: "btab_contract",
      generation: 1,
      documentGeneration: 2,
      observationRevision: 3,
      callID: "call_contract",
    }
    for (const action of [
      { type: "clipboard_read" },
      { type: "clipboard_write", text: "synthetic" },
      { type: "upload", ref: "b1", paths: ["/tmp/fixture.txt"] },
      { type: "download", timeoutMs: 1000 },
      { type: "logs", limit: 10 },
      { type: "export" },
      { type: "webmcp_list" },
      { type: "webmcp_invoke", name: "lookup", arguments: { q: 1 } },
    ])
      expect(Schema.is(Browser.ActionInput)({ ...base, action }), JSON.stringify(action)).toBe(true)
    for (const action of [
      { type: "clipboard_write", text: "x".repeat(Browser.MAX_CLIPBOARD_BYTES + 1) },
      { type: "upload", ref: "b1", paths: [] },
      { type: "upload", ref: "b1", paths: Array(Browser.MAX_UPLOAD_FILES + 1).fill("/tmp/a") },
      { type: "download", timeoutMs: Browser.MAX_WAIT_MS + 1 },
      { type: "logs", limit: Browser.MAX_LOG_ENTRIES + 1 },
      { type: "webmcp_invoke", name: "" },
    ])
      expect(Schema.is(Browser.ActionInput)({ ...base, action }), JSON.stringify(action)).toBe(false)
  })

  test("bounds history search input and results and action payloads", () => {
    expect(
      Schema.is(Browser.HistoryInput)({
        sessionID: "ses_contract", generation: 1, callID: "h1", query: "tempo", limit: 5, startTime: 1, endTime: 2,
      }),
    ).toBe(true)
    expect(Schema.is(Browser.HistoryInput)({ sessionID: "ses_contract", generation: 1, callID: "h1", limit: 101 })).toBe(false)
    const result = {
      callID: "c1",
      tab,
      status: "completed",
      text: "clipboard",
      logs: [{ level: "log", text: "hello" }],
      download: { filename: "report.csv", state: "complete", bytesReceived: 3 },
      savedFile: { path: "/tmp/page.mhtml", bytes: 10 },
      webmcpTools: [{ name: "lookup", description: "Look up" }],
    }
    expect(Schema.decodeUnknownSync(Browser.ActionResult)(result) as unknown).toEqual(result)
    expect(
      Schema.is(Browser.ActionResult)({
        ...result,
        logs: Array.from({ length: Browser.MAX_LOG_ENTRIES + 1 }, () => ({ level: "log", text: "x" })),
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
