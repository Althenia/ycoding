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
  "coordination.members",
  "coordination.arm",
  "coordination.stop",
  "coordination.complete",
  "coordination.claim",
  "coordination.release",
  "coordination.dispatch",
  "coordination.receipts",
  "coordination.wait",
  "coordination.cancelWait",
  "coordination.capacity",
] as const

const reads = ["coordination.settings", "coordination.list", "coordination.get", "coordination.receipts", "coordination.capacity"]

function frame(operation: string, input?: Record<string, unknown>, sessionID?: string) {
  return JSON.stringify({ type: "request", id: "req_1", operation, ...(sessionID === undefined ? {} : { sessionID }), ...(input === undefined ? {} : { input }) })
}

const policy = { concurrency: 2, queueCapacity: 10 }
const members = [
  { sessionID: "ses_coord", role: "coordinator" },
  { sessionID: "ses_worker", role: "worker", allowedTools: ["read"], resourceScopes: ["packages/remote"] },
]

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
  expect(parseClientMessage(frame("coordination.create", { name: "Project", policy, members })).ok).toBe(true)
  expect(parseClientMessage(frame("coordination.create", { name: "Project", policy, members: [] })).ok).toBe(false)
  expect(parseClientMessage(frame("coordination.create", { name: "Project", policy: { ...policy, queueCapacity: 1001 }, members })).ok).toBe(false)
  expect(parseClientMessage(frame("coordination.create", { name: "Project", policy, members: [{ sessionID: "ses_coord", role: "owner" }] })).ok).toBe(false)
  expect(parseClientMessage(frame("coordination.members", { groupID: "cgrp_1", revision: 3, name: "Renamed", members, policy })).ok).toBe(true)
  expect(parseClientMessage(frame("coordination.arm", { groupID: "cgrp_1", revision: 3 })).ok).toBe(true)
  expect(parseClientMessage(frame("coordination.arm", { groupID: "cgrp_1", revision: -1 })).ok).toBe(false)
  expect(parseClientMessage(frame("coordination.claim", { groupID: "cgrp_1", revision: 3, targetSessionID: "ses_worker", holderSessionID: "ses_coord", leaseMs: 60_000 })).ok).toBe(true)
  expect(parseClientMessage(frame("coordination.claim", { groupID: "cgrp_1", revision: 3, targetSessionID: "ses_worker", holderSessionID: "ses_coord", leaseMs: 999 })).ok).toBe(false)
  const selection = { agent: "omoikane", model: { providerID: "muse", id: "muse-wonder", variant: "high" }, reason: "Transport boundaries need the systems agent" }
  const dispatched = parseClientMessage(frame("coordination.dispatch", { groupID: "cgrp_1", revision: 3, holderSessionID: "ses_coord", generation: 1, targetSessionID: "ses_worker", text: "Do work", selection }))
  expect(dispatched.ok && "input" in dispatched.value && dispatched.value.input && "selection" in dispatched.value.input ? dispatched.value.input.selection : undefined).toEqual(selection)
  expect(parseClientMessage(frame("coordination.dispatch", { groupID: "cgrp_1", revision: 3, holderSessionID: "ses_coord", generation: 1, targetSessionID: "ses_worker", text: "Do work" })).ok).toBe(false)
  expect(parseClientMessage(frame("coordination.dispatch", { groupID: "cgrp_1", revision: 3, holderSessionID: "ses_coord", generation: 1, targetSessionID: "ses_worker", text: "", selection })).ok).toBe(false)
  expect(parseClientMessage(frame("coordination.dispatch", { groupID: "cgrp_1", revision: 3, holderSessionID: "ses_coord", generation: 1, targetSessionID: "ses_worker", text: "Do work", selection: { ...selection, reason: "line one\nline two" } })).ok).toBe(false)
  expect(parseClientMessage(frame("coordination.dispatch", { groupID: "cgrp_1", revision: 3, holderSessionID: "ses_coord", generation: 1, targetSessionID: "ses_worker", text: "Do work", selection: { ...selection, model: { providerID: "muse" } } })).ok).toBe(false)
  expect(parseClientMessage(frame("coordination.wait", { groupID: "cgrp_1", revision: 3, holderSessionID: "ses_coord", targets: ["ses_worker"], timeoutMs: 300_000, batch: 200 })).ok).toBe(true)
  expect(parseClientMessage(frame("coordination.wait", { groupID: "cgrp_1", revision: 3, holderSessionID: "ses_coord", timeoutMs: 300_001 })).ok).toBe(false)
  expect(parseClientMessage(frame("coordination.cancelWait", { groupID: "cgrp_1", revision: 3, waitID: "cwait_1", holderSessionID: "ses_coord" })).ok).toBe(true)
  expect(parseClientMessage(frame("coordination.release", { groupID: "cgrp_1", revision: 3, targetSessionID: "ses_worker", holderSessionID: "ses_coord", generation: 1 })).ok).toBe(true)
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

test("coordination push filter requires the source Session itself to be a verified coordinator, failing closed on unknown sources", () => {
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
