import { expect, test } from "bun:test"
import { parseRelayToAgentMessage, remoteOperationAccess, remoteOperations, requireSession } from "../src/index"

const operations = ["local.app.register", "local.app.list", "local.app.revoke", "local.app.open", "local.app.status", "local.app.http"] as const

test("registered HTTP apps use closed Session-scoped operations", () => {
  for (const operation of operations) {
    expect(remoteOperations).toContain(operation)
    expect(requireSession(operation)).toBe(true)
    expect(parseRelayToAgentMessage(JSON.stringify({ type: "request", id: "request_fixture", operation })).ok).toBe(false)
    expect(parseRelayToAgentMessage(JSON.stringify({ type: "request", id: "request_fixture", operation, sessionID: "ses_fixture" }))).toMatchObject({ ok: true, value: { operation, sessionID: "ses_fixture" } })
  }
  expect(parseRelayToAgentMessage(JSON.stringify({ type: "request", id: "request_fixture", operation: "local.app.proxyUrl", sessionID: "ses_fixture" })).ok).toBe(false)
})

test("only listing and status are read-only app operations", () => {
  expect(remoteOperationAccess["local.app.list"]).toBe("read")
  expect(remoteOperationAccess["local.app.status"]).toBe("read")
  for (const operation of ["local.app.register", "local.app.revoke", "local.app.open", "local.app.http"] as const)
    expect(remoteOperationAccess[operation]).toBe("mutation")
})
