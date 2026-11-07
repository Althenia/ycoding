import { expect, test } from "bun:test"
import { decodeClient, VERSION } from "../../src/browser/protocol"

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

test("decodes element state, control state, and a wait match frame in version 6 frames", () => {
  const extensionID = "b".repeat(32)
  expect(VERSION).toBe(6)
  const pair = { type: "pair", version: 6, extensionID, secret: "s".repeat(32) }
  expect(decodeClient(JSON.stringify(pair))).toMatchObject(pair)
  const observation = {
    type: "observation", callID: "observe-6", tabID: "btab_profile_wire", generation: 1, documentGeneration: 1,
    revision: 1, title: "Synthetic", url: "https://example.test/form",
    elements: [
      { ref: "b1", role: "checkbox", name: "Agree", checked: "mixed" },
      { ref: "b2", role: "button", name: "Bold", pressed: false },
      { ref: "b3", role: "combobox", name: "Size", expanded: true, value: "Large" },
      { ref: "b4", role: "option", name: "Small", selected: true },
      { ref: "b5", role: "textbox", name: "Password", sensitive: true },
    ],
    truncated: false,
  }
  expect(decodeClient(JSON.stringify(observation))).toMatchObject(observation)
  const result = {
    type: "result", callID: "a6", tabID: "btab_profile_wire", generation: 1, documentGeneration: 1,
    observationRevision: 1, status: "completed", title: "Synthetic", url: "https://example.test/form",
    control: { checked: true, value: "v", selected: [{ value: "s", label: "Small", index: 0 }, { label: "Aria", index: 1 }] },
    frame: "https://child.example.test/widget",
  }
  expect(decodeClient(JSON.stringify(result))).toMatchObject(result)
  expect(decodeClient(JSON.stringify({ ...result, control: { sensitive: false } }))).toBeUndefined()
  expect(decodeClient(JSON.stringify({ ...observation, elements: [{ ref: "b1", role: "textbox", name: "x", sensitive: false }] })))
    .toBeUndefined()
})

test("rejects a version 5 handshake", () => {
  const extensionID = "b".repeat(32)
  expect(decodeClient(JSON.stringify({ type: "pair", version: 5, extensionID, secret: "s".repeat(32) }))).toBeUndefined()
  expect(decodeClient(JSON.stringify({
    type: "authenticate", version: 5, extensionID, serverID: "server-identity-test", credential: "c".repeat(32),
  }))).toBeUndefined()
})

test("revoked frames carry an optional bounded reason and shared frames an optional predecessor", () => {
  const revoked = { type: "revoked", tabID: "btab_profile_wire" }
  expect(decodeClient(JSON.stringify(revoked))).toMatchObject(revoked)
  for (const reason of ["closed", "navigated", "detached", "access_revoked", "replaced"])
    expect(decodeClient(JSON.stringify({ ...revoked, reason }))).toMatchObject({ ...revoked, reason })
  expect(decodeClient(JSON.stringify({ ...revoked, reason: "detached", detachReason: "target_closed" })))
    .toMatchObject({ reason: "detached", detachReason: "target_closed" })
  expect(decodeClient(JSON.stringify({ ...revoked, reason: "vanished" }))).toBeUndefined()
  expect(decodeClient(JSON.stringify({ ...revoked, reason: "detached", detachReason: "x".repeat(65) }))).toBeUndefined()
  const shared = { type: "shared", mode: "profile", tabID: "btab_profile_next", title: "Synthetic",
    url: "https://example.test/", documentGeneration: 1, active: false }
  expect(decodeClient(JSON.stringify({ ...shared, replaces: "btab_profile_wire" })))
    .toMatchObject({ replaces: "btab_profile_wire" })
  expect(decodeClient(JSON.stringify({ ...shared, replaces: "not-a-tab" }))).toBeUndefined()
})
