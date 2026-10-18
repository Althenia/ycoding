import { expect, test } from "bun:test"
import {
  RemoteProtocolVersion,
  RemoteWebSocketPath,
  parseEnrollRequest,
  parseChallengeRequest,
  parseDeviceTokenRequest,
  parseDeviceRefreshRequest,
  parseBearerToken,
  parsePushEndpoint,
  parsePushSubscription,
  parsePushTestResponse,
  deviceSignaturePayload,
  noticeSequence,
} from "../src/index"

test("only exact binary-v5 socket routes are exported", () => {
  expect(RemoteProtocolVersion).toBe(5)
  expect(RemoteWebSocketPath).toEqual({ client: "/ws/v5/client", agent: "/ws/v5/agent" })
})

test("HTTP enrollment, challenge and credential inputs remain strict and bounded", () => {
  const value = {
    enrollmentID: "enr_1",
    code: "ABCD-1234-EFGH-5678-IJKL",
    name: " Device ",
    publicKey: { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) },
  }
  expect(parseEnrollRequest(value)).toMatchObject({ ok: true, value: { name: "Device" } })
  for (const change of [
    { extra: true },
    { name: " " },
    { name: "x".repeat(101) },
    { code: "ABCD" },
    { publicKey: { ...value.publicKey, d: "private" } },
    { publicKey: { ...value.publicKey, x: "A=" } },
  ])
    expect(parseEnrollRequest({ ...value, ...change }).ok).toBe(false)
  expect(parseChallengeRequest({ deviceID: "dev_1" }).ok).toBe(true)
  expect(parseChallengeRequest({ deviceID: "dev_1", url: "https://example.invalid" }).ok).toBe(false)
  expect(parseDeviceTokenRequest({ deviceID: "dev_1", challengeID: "chl_1", signature: "AAAA" }).ok).toBe(true)
  expect(parseDeviceTokenRequest({ deviceID: "dev_1", challengeID: "chl_1", signature: "A".repeat(513) }).ok).toBe(
    false,
  )
  expect(parseDeviceRefreshRequest({ deviceID: "dev_1", refreshToken: "test" }).ok).toBe(true)
  expect(parseDeviceRefreshRequest({ deviceID: "dev_1", refreshToken: "test", ownerID: "forged" }).ok).toBe(false)
  expect(parseBearerToken(`Bearer ${"a".repeat(16)}`)).toBe("a".repeat(16))
  for (const value of [null, "bearer abc", "Bearer abc", `Bearer ${"a".repeat(257)}`, `Bearer ${"a".repeat(16)} extra`])
    expect(parseBearerToken(value)).toBeUndefined()
  expect(deviceSignaturePayload("chl", "nonce")).toBe("ycoding-device-v1\nchl\nnonce")
})

test("push HTTP contracts retain endpoint, key, renewal, category and outcome bounds", () => {
  const endpoint = "https://fcm.googleapis.com/fcm/send/synthetic"
  const keys = {
    p256dh: btoa(String.fromCharCode(4) + "a".repeat(64))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", ""),
    auth: "A".repeat(22),
  }
  const categories = { "agent-completed": true, "approval-requested": false, "machine-offline": true, "quota-pace": true }
  expect(parsePushSubscription({ endpoint, keys, categories }).ok).toBe(true)
  expect(parsePushSubscription({ endpoint, keys, replaces: endpoint }).ok).toBe(true)
  for (const value of [
    { endpoint, keys, categories, extra: true },
    { endpoint, keys, categories: {} },
    { endpoint, keys: { ...keys, auth: "A" }, categories },
  ])
    expect(parsePushSubscription(value).ok).toBe(false)
  for (const endpoint of [
    "http://fcm.googleapis.com/",
    "https://user:secret@fcm.googleapis.com/",
    "https://example.invalid/",
    "https://fcm.googleapis.com/#x",
  ])
    expect(parsePushEndpoint({ endpoint }).ok).toBe(false)
  for (const outcome of ["accepted", "rejected", "expired"])
    expect(parsePushTestResponse({ outcome, status: 200 }).ok).toBe(true)
  expect(parsePushTestResponse({ outcome: "unreachable" }).ok).toBe(true)
  expect(parsePushTestResponse({ outcome: "unreachable", status: 200 }).ok).toBe(false)
})

test("notice storage cursor rejects unsafe integer and malformed identities", () => {
  expect(noticeSequence("ntc_1")).toBe(1)
  for (const id of ["ntc_0", "ntc_01", "ntc_-1", "ntc_9007199254740992", "ntc_1x"])
    expect(noticeSequence(id)).toBeUndefined()
})
