import { expect, test } from "bun:test"
import { decodeClient } from "../../src/browser/protocol"

test("shared extension frames identify profile tabs explicitly", () => {
  const shared = {
    type: "shared",
    tabID: "btab_profile_wire",
    title: "Synthetic",
    url: "https://example.test/",
    documentGeneration: 1,
    active: true,
  }
  expect(decodeClient(JSON.stringify({ ...shared, mode: "profile" }))).toMatchObject({ ...shared, mode: "profile" })
  expect(decodeClient(JSON.stringify(shared))).toBeUndefined()
})

test("observation frames carry per-frame elements, texts, and completeness entries", () => {
  const message = {
    type: "observation",
    callID: "observe-1",
    tabID: "btab_profile_wire",
    generation: 1,
    documentGeneration: 2,
    revision: 3,
    title: "Synthetic",
    url: "https://example.test/form",
    elements: [
      { ref: "b1", role: "button", name: "Child button", frame: "https://child.example.test/tempo" },
    ],
    texts: [{ role: "StaticText", name: "Tempo rows", frame: "https://child.example.test/tempo" }],
    frames: [
      { url: "https://child.example.test/tempo", observed: true },
      { url: "https://blocked.example.test/widget", observed: false },
    ],
    truncated: false,
  }
  expect(decodeClient(JSON.stringify(message))).toMatchObject(message)
})

test("history results and peripheral payloads decode as bounded client frames", () => {
  const history = {
    type: "history_result",
    callID: "h1",
    generation: 1,
    entries: [{ url: "https://example.test/visited", title: "Visited", lastVisitTime: 10, visitCount: 2 }],
  }
  expect(decodeClient(JSON.stringify(history))).toMatchObject(history)
  const result = {
    type: "result",
    callID: "a1",
    tabID: "btab_profile_wire",
    generation: 1,
    documentGeneration: 1,
    observationRevision: 1,
    status: "completed",
    title: "Synthetic",
    url: "https://example.test/form",
    text: "clipboard",
    logs: [{ level: "error", text: "boom", frame: "https://child.example.test/tempo" }],
    download: { filename: "report.csv", state: "complete" },
    webmcpTools: [{ name: "lookup" }],
  }
  expect(decodeClient(JSON.stringify(result))).toMatchObject(result)
})

test("rejects a connected pre-grant extension protocol before accepting its handshake", () => {
  const extensionID = "b".repeat(32)
  expect(decodeClient(JSON.stringify({ type: "pair", version: 2, extensionID, secret: "s".repeat(32) }))).toBeUndefined()
  expect(decodeClient(JSON.stringify({
    type: "authenticate", version: 2, extensionID, serverID: "server-identity-test", credential: "c".repeat(32),
  }))).toBeUndefined()
})
