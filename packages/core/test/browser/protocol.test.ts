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

test("rejects a connected pre-grant extension protocol before accepting its handshake", () => {
  const extensionID = "b".repeat(32)
  expect(decodeClient(JSON.stringify({ type: "pair", version: 2, extensionID, secret: "s".repeat(32) }))).toBeUndefined()
  expect(decodeClient(JSON.stringify({
    type: "authenticate", version: 2, extensionID, serverID: "server-identity-test", credential: "c".repeat(32),
  }))).toBeUndefined()
})
