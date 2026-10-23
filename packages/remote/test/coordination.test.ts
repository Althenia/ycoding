import { expect, test } from "bun:test"
import {
  coordinationPushAllows,
  parseClientMessage,
  parsePushSubscription,
  remoteOperationAccess,
  remoteOperations,
  requireSession,
  type RemoteOperation,
} from "../src/index"

export const coordinationOperations = [
  "coordination.settings",
  "coordination.list",
  "coordination.create",
  "coordination.get",
  "coordination.update",
  "coordination.delete",
] as const

const reads = ["coordination.settings", "coordination.list", "coordination.get"]

function frame(operation: string, input?: Record<string, unknown>, sessionID?: string) {
  return JSON.stringify({ type: "request", id: "req_1", operation, ...(sessionID === undefined ? {} : { sessionID }), ...(input === undefined ? {} : { input }) })
}

const create = { name: "Project", masterSessionID: "ses_master", memberSessionIDs: ["ses_member"] }

test("coordination operations form a classified sessionless part of the closed remote set", () => {
  expect(remoteOperations.filter((operation) => operation.startsWith("coordination."))).toEqual([...coordinationOperations])
  for (const operation of coordinationOperations) {
    expect(requireSession(operation as RemoteOperation)).toBe(false)
    expect(remoteOperationAccess[operation as RemoteOperation]).toBe(reads.includes(operation) ? "read" : "mutation")
  }
})

test("coordination requests accept only bounded ordinary-object inputs without a Session or Location selector", () => {
  expect(parseClientMessage(frame("coordination.settings")).ok).toBe(true)
  expect(parseClientMessage(frame("coordination.list")).ok).toBe(true)
  expect(parseClientMessage(frame("coordination.list", undefined, "ses_coord")).ok).toBe(false)
  expect(parseClientMessage(frame("coordination.get", { groupID: "cgrp_1" })).ok).toBe(true)
  expect(parseClientMessage(frame("coordination.get", { groupID: "grp_1" })).ok).toBe(false)
  expect(parseClientMessage(frame("coordination.get", { groupID: "cgrp_1", directory: "/tmp" })).ok).toBe(false)
  for (const memberSessionIDs of [[], ["ses_member"], Array.from({ length: 64 }, (_, i) => `ses_${i}`)])
    expect(parseClientMessage(frame("coordination.create", { ...create, memberSessionIDs })).ok).toBe(true)
  for (const fields of [{ name: "" }, { name: "x".repeat(121) }, { masterSessionID: "bad" }, { memberSessionIDs: ["bad"] }, { memberSessionIDs: Array(65).fill("ses_member") }, { directory: "/tmp" }])
    expect(parseClientMessage(frame("coordination.create", { ...create, ...fields })).ok).toBe(false)
  const update = { groupID: "cgrp_1", revision: 0 }
  for (const fields of [{}, { name: "Renamed" }, { masterSessionID: "ses_other" }, { memberSessionIDs: [] }, { settings: { concurrency: null } }, { settings: { concurrency: 2, delegatedDecisions: { categories: ["question"], actions: [], resources: [], expiresAt: 1 } } }])
    expect(parseClientMessage(frame("coordination.update", { ...update, ...fields })).ok).toBe(true)
  for (const fields of [{ revision: -1 }, { revision: 0.5 }, { settings: {} }, { settings: { concurrency: 0 } }, { settings: { concurrency: null, notifications: {} } }, { settings: { concurrency: null, delegatedDecisions: { categories: ["invalid"] } } }, { memberSessionIDs: ["invalid"] }])
    expect(parseClientMessage(frame("coordination.update", { ...update, ...fields })).ok).toBe(false)
  expect(parseClientMessage(frame("coordination.delete", { groupID: "cgrp_1" })).ok).toBe(true)
  expect(parseClientMessage(frame("coordination.delete", update)).ok).toBe(false)
})

test("Session deletion is a scoped mutation with no caller-provided placement", () => {
  expect(remoteOperations).toContain("session.delete")
  expect(requireSession("session.delete" as RemoteOperation)).toBe(true)
  expect(remoteOperationAccess["session.delete" as RemoteOperation]).toBe("mutation")
  expect(parseClientMessage(frame("session.delete", undefined, "ses_member")).ok).toBe(true)
  expect(parseClientMessage(frame("session.delete")).ok).toBe(false)
  expect(parseClientMessage(frame("session.delete", { directory: "/tmp" }, "ses_member")).ok).toBe(false)
})

const pushKeys = () => {
  const point = new Uint8Array(65)
  point[0] = 4
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
  return { p256dh: encode(point), auth: encode(new Uint8Array(16)) }
}
const registration = (coordinationFilter?: unknown) => ({
  endpoint: "https://fcm.googleapis.com/fcm/send/test",
  keys: pushKeys(),
  categories: { "agent-completed": true, "approval-requested": true, "machine-offline": true, "quota-pace": true },
  ...(coordinationFilter === undefined ? {} : { coordinationFilter }),
})

test("push registrations accept only the bounded coordination filter DTO", () => {
  expect(parsePushSubscription(registration()).ok).toBe(true)
  const parsed = parsePushSubscription(registration({ scope: "selected", sessionIDs: ["ses_coord"], categories: ["question", "completion"] }))
  expect(parsed.ok && "coordinationFilter" in parsed.value ? parsed.value.coordinationFilter : undefined).toEqual({ scope: "selected", sessionIDs: ["ses_coord"], categories: ["question", "completion"] })
  expect(parsePushSubscription(registration({ scope: "workers" })).ok).toBe(false)
  expect(parsePushSubscription(registration({ scope: "selected", sessionIDs: Array.from({ length: 129 }, (_, index) => `ses_${index}`) })).ok).toBe(false)
  expect(parsePushSubscription(registration({ scope: "all", categories: ["unknown"] })).ok).toBe(false)
  expect(parsePushSubscription(registration({ scope: "all", directory: "/tmp" })).ok).toBe(false)
  expect(parsePushSubscription(registration({ scope: "all", categories: [] })).ok).toBe(true)
})

test("coordination push filter requires the source Session itself to be a verified Master, failing closed on unknown sources", () => {
  const workerEvent = { category: "approval-requested" as const, need: "question" as const, sessionID: "ses_worker", coordinatorSessionIDs: ["ses_coord"] }
  const observerEvent = { ...workerEvent, sessionID: "ses_observer" }
  const coordinatorEvent = { category: "approval-requested" as const, need: "question" as const, sessionID: "ses_coord", coordinatorSessionIDs: ["ses_coord"] }
  expect(coordinationPushAllows(undefined, workerEvent)).toBe(true)
  expect(coordinationPushAllows({ scope: "all" }, workerEvent)).toBe(true)
  expect(coordinationPushAllows({ scope: "all", categories: [] }, workerEvent)).toBe(false)
  expect(coordinationPushAllows({ scope: "all", categories: ["permission"] }, workerEvent)).toBe(false)
  expect(coordinationPushAllows({ scope: "all", categories: ["question"] }, workerEvent)).toBe(true)
  expect(coordinationPushAllows({ scope: "coordinators" }, workerEvent)).toBe(false)
  expect(coordinationPushAllows({ scope: "coordinators" }, observerEvent)).toBe(false)
  expect(coordinationPushAllows({ scope: "selected", sessionIDs: ["ses_coord"] }, workerEvent)).toBe(false)
  expect(coordinationPushAllows({ scope: "selected", sessionIDs: ["ses_worker"] }, workerEvent)).toBe(false)
  expect(coordinationPushAllows({ scope: "selected", sessionIDs: ["ses_observer"] }, observerEvent)).toBe(false)
  expect(coordinationPushAllows({ scope: "coordinators" }, coordinatorEvent)).toBe(true)
  expect(coordinationPushAllows({ scope: "selected", sessionIDs: ["ses_coord"] }, coordinatorEvent)).toBe(true)
  expect(coordinationPushAllows({ scope: "selected", sessionIDs: ["ses_other"] }, coordinatorEvent)).toBe(false)
  expect(coordinationPushAllows({ scope: "selected", sessionIDs: [] }, coordinatorEvent)).toBe(false)
  expect(coordinationPushAllows({ scope: "coordinators" }, { ...coordinatorEvent, coordinatorSessionIDs: [] })).toBe(false)
  expect(coordinationPushAllows({ scope: "coordinators" }, { category: "agent-completed", sessionID: "ses_solo" })).toBe(false)
  expect(coordinationPushAllows({ scope: "selected", sessionIDs: ["ses_coord"] }, { category: "agent-completed", sessionID: "ses_coord" })).toBe(false)
  expect(coordinationPushAllows({ scope: "all", categories: ["completion"] }, { category: "agent-completed", sessionID: "ses_coord", coordinatorSessionIDs: ["ses_coord"] })).toBe(true)
  expect(coordinationPushAllows({ scope: "all", categories: ["failure"] }, { category: "approval-requested", need: "failed", sessionID: "ses_worker", coordinatorSessionIDs: ["ses_coord"] })).toBe(true)
  expect(coordinationPushAllows({ scope: "all", categories: ["review"] }, { category: "approval-requested", need: "blocked", sessionID: "ses_coord", coordinatorSessionIDs: ["ses_coord"] })).toBe(true)
  expect(coordinationPushAllows({ scope: "all", categories: ["failure"] }, { category: "approval-requested", need: "blocked", sessionID: "ses_coord", coordinatorSessionIDs: ["ses_coord"] })).toBe(false)
  expect(coordinationPushAllows({ scope: "coordinators" }, { category: "machine-offline" })).toBe(true)
  expect(coordinationPushAllows({ scope: "selected", sessionIDs: [], categories: [] }, { category: "machine-offline" })).toBe(true)
})
