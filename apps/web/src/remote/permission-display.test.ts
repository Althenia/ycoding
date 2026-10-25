import { expect, test } from "bun:test"
import { applySessionEvent, createSessionView, permissionDisplay, readPermissionRequests, readReviewItems } from "./projection"

const action = "chatgpt_connector_42_list_events_012345abcdef"
const metadata = { connector: "connector-42", connectorLabel: "Work Calendar", tool: "list_events", requireHuman: true, operationDigest: "private", unrelated: "discard" }
const request = { id: "per_calendar", sessionID: "ses_a", action, resources: ["connector-42"], save: ["connector-42"], metadata, source: { type: "tool", messageID: "msg_a", callID: "call_a" } }

test("permission event and snapshot retain display metadata and save without execution details", () => {
  const live = applySessionEvent(createSessionView("ses_a"), { type: "permission.asked", data: request }, 1).requests[0]
  const snapshot = readPermissionRequests({ data: [request] }, 1)[0]
  for (const projected of [live, snapshot]) {
    expect(projected).toEqual({ kind: "permission", id: request.id, action, resources: request.resources, save: request.save,
      metadata: { connector: "connector-42", connectorLabel: "Work Calendar", tool: "list_events", requireHuman: true }, askedAt: 1 })
  }
  expect(applySessionEvent({ ...createSessionView("ses_a"), requests: [live!] }, { type: "permission.replied", data: { requestID: "per_calendar", reply: "once" } }, 2).requests).toEqual([])
})

test("permission projection rejects malformed display metadata and save patterns", () => {
  for (const save of [undefined, [], ["safe", 1], "*"]) {
    const projected = readPermissionRequests({ data: [{ ...request, save, metadata: { connector: 1, connectorLabel: [], tool: {}, requireHuman: "true" } }] }, 1)[0]
    expect(projected).not.toHaveProperty("metadata")
    expect(projected).not.toHaveProperty("save")
  }
})

test("deferred permission projection retains canonical action, resource and save only", () => {
  expect(readReviewItems({ data: [{ itemID: "rvw_calendar", sessionID: "ses_a", rootSessionID: "ses_a", sessionTitle: "Calendar", created: 1, reason: "refused", kind: "permission",
    payload: { type: "permission", action, resources: ["connector-42"], save: ["connector-42"], requestID: "per_calendar", fingerprint: "f".repeat(64) } }] })).toEqual([
    { itemID: "rvw_calendar", sessionID: "ses_a", rootSessionID: "ses_a", sessionTitle: "Calendar", created: 1, reason: "refused", kind: "permission", action, resources: ["connector-42"], save: ["connector-42"] },
  ])
})

test("permission display escapes resources and limits remembered approval to reported patterns", () => {
  expect(permissionDisplay({ action, resources: ["connector-42"], metadata }).always).toBeUndefined()
  expect(permissionDisplay({ action, resources: ["connector-42"], save: ["*"], metadata }).always).toBeUndefined()
  expect(permissionDisplay({ action: "shell", resources: ["cmd\u202e\n"], save: ["src/\u001b*"] })).toEqual({
    action: "Shell", resources: ["cmd\\u202e\\u000a"], always: "Allow Shell for these resource patterns in this Session: src/\\u001b*",
  })
  expect(permissionDisplay({ action, resources: ["connector-42"], save: ["connector-42"] })).toEqual({
    action: "ChatGPT · List Events", resources: ["connector-42"], always: "Allow ChatGPT · List Events for these resource patterns in this Session: connector-42",
  })
  expect(permissionDisplay({ action: "read", resources: [], save: ["*"] }).always).toBe("Allow Read for all resources in this Session.")
  expect(permissionDisplay({ action: "read", resources: [], save: [] }).always).toBeUndefined()
})
