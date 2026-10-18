import { expect, test } from "bun:test"
import { parseAuthorizationRequest, parseAuthorizationResponse } from "../src/mcp-events"

const principal = { ownerID: "owner_test", deviceID: "dev_test", clientID: "https://client.example.invalid/client.json" }

test("MCP events authorization requests accept only the three bounded actions", () => {
  expect(parseAuthorizationRequest({ action: "capabilities" })).toEqual({ action: "capabilities" })
  expect(parseAuthorizationRequest({ action: "resolve", requestID: "req_1", principal, epoch: "epoch_1" })).toEqual({
    action: "resolve",
    requestID: "req_1",
    principal,
    epoch: "epoch_1",
  })
  expect(parseAuthorizationRequest({ action: "check", grantID: "grt_test", principal, epoch: "epoch_1" })).toEqual({
    action: "check",
    grantID: "grt_test",
    principal,
    epoch: "epoch_1",
  })
  for (const value of [
    { action: "capabilities", extra: true },
    { action: "resolve", requestID: "req_1", principal, epoch: "epoch_1", url: "https://example.invalid/hook" },
    { action: "resolve", principal, epoch: "epoch_1" },
    { action: "check", grantID: "grt_test", principal, epoch: "epoch_1", secret: "whsec_test" },
    { action: "check", grantID: "grt_test", principal: { ...principal, grantID: "nested" }, epoch: "epoch_1" },
    { action: "check", grantID: "grt_test", principal: { ...principal, clientID: "bad\r\nclient" }, epoch: "epoch_1" },
    { action: "check", grantID: "grt_test", principal: { ...principal, clientID: "x".repeat(2049) }, epoch: "epoch_1" },
    { action: "resolve", requestID: "x".repeat(65), principal, epoch: "epoch_1" },
    { action: "resolve", requestID: "req_1", principal, epoch: "" },
    { action: "subscribe", requestID: "req_1", principal, epoch: "epoch_1" },
    "capabilities",
    42,
    null,
    [],
  ]) expect(parseAuthorizationRequest(value)).toBeUndefined()
})

test("MCP events authorization responses never carry credentials, URLs, bodies, or secrets", () => {
  expect(parseAuthorizationResponse({ action: "capabilities", supported: true })).toEqual({ action: "capabilities", supported: true })
  expect(parseAuthorizationResponse({ action: "resolve", authorized: true, grantID: "grt_test", expiresAt: 1893456000000 })).toEqual({
    action: "resolve",
    authorized: true,
    grantID: "grt_test",
    expiresAt: 1893456000000,
  })
  expect(parseAuthorizationResponse({ action: "check", authorized: false, reason: "unauthorized" })).toEqual({
    action: "check",
    authorized: false,
    reason: "unauthorized",
  })
  for (const value of [
    { action: "capabilities", supported: false },
    { action: "capabilities", supported: true, url: "https://example.invalid" },
    { action: "resolve", authorized: true, grantID: "grt_test", expiresAt: 1893456000000, accessToken: "x" },
    { action: "resolve", authorized: true, grantID: "grt_test", expiresAt: 0 },
    { action: "resolve", authorized: true, grantID: "grt_test", expiresAt: 1.5 },
    { action: "resolve", authorized: true, expiresAt: 1893456000000 },
    { action: "check", authorized: false, reason: "revoked_grant" },
    { action: "check", authorized: false, reason: "unauthorized", message: "detail" },
    { action: "check", authorized: "yes", grantID: "grt_test", expiresAt: 1893456000000 },
  ]) expect(parseAuthorizationResponse(value)).toBeUndefined()
})
