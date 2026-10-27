import { expect, test } from "bun:test"
import { parseClientMessage, remoteOperationAccess, remoteDotsPeerLabel } from "../src/index"

test("attributes completed turnless room replies and rejects an empty turn identity", () => {
  const dots = {
    origin: "dots-peer",
    profile: "synthetic",
    dotID: "dot-1",
    threadID: "thread-1",
    itemID: "room-message",
  }
  expect(remoteDotsPeerLabel({ dots })).toBe("Dot dot-1 · external peer · thread-1")
  expect(remoteDotsPeerLabel({ dots: { ...dots, turnID: "" } })).toBeUndefined()
})

const target = {
  profile: "synthetic",
  dotID: "dot-1",
  threadID: "thread-1",
  generation: "generation-1",
  label: "V / conversation",
}
const parse = (operation: string, input?: unknown, sessionID: string | null = "ses_test") =>
  parseClientMessage(JSON.stringify({ type: "request", id: "req_test", operation, sessionID, input }))

test("routine delegation uses the existing exchange operation and never exposes native grant administration", () => {
  const input = { exchangeID: "routine", expectedAttachment: target, targetSessionID: "ses_target", channel: "task", delivery: "queue", delegation: { id: "proposal", revision: 1 }, taskInputID: "msg_human", instruction: { operation: "continue" } }
  expect(parse("session.dots.exchange.create", input).ok).toBe(true)
  expect(parse("session.dots.exchange.create", { ...input, instruction: { operation: "presentation", preferences: { format: "bullets", detail: "concise" } } }).ok).toBe(true)
  for (const invalid of [{ ...input, text: "New scope" }, { ...input, command: "synthetic" }, { ...input, instruction: { operation: "approve" } }, { ...input, instruction: { operation: "presentation", preferences: {} } }, { ...input, instruction: { operation: "presentation", preferences: { format: "table" } } }]) expect(parse("session.dots.exchange.create", invalid).ok).toBe(false)
  for (const operation of ["status", "create", "revoke"]) expect(parse(`session.dots.delegation.${operation}`, {}).ok).toBe(false)
})

test("session-basis delegated exchanges accept only closed task and decision instructions", () => {
  const base = { exchangeID: "delegated", expectedAttachment: target, targetSessionID: "ses_target", channel: "task", delivery: "queue", delegation: { id: "proposal", revision: 1 } }
  expect(parse("session.dots.exchange.create", { ...base, instruction: { operation: "task", text: "Inspect" } }).ok).toBe(true)
  expect(parse("session.dots.exchange.create", { ...base, instruction: { operation: "decision", target: { kind: "permission", requestID: "per_1", fingerprint: "f".repeat(64) }, reply: "once" } }).ok).toBe(true)
  expect(parse("session.dots.exchange.create", { ...base, instruction: { operation: "decision", target: { kind: "question", requestID: "que_1", fingerprint: "a".repeat(64) }, answers: [["main"]] } }).ok).toBe(true)
  for (const invalid of [
    { ...base, taskInputID: "msg_human", instruction: { operation: "task", text: "Inspect" } },
    { ...base, instruction: { operation: "task", text: "" } },
    { ...base, instruction: { operation: "decision", target: { kind: "permission", requestID: "per_1", fingerprint: "f".repeat(64) }, reply: "always" } },
    { ...base, instruction: { operation: "decision", target: { kind: "recovery", requestID: "rvw_1", fingerprint: "f".repeat(64) }, reply: "once" } },
    { ...base, instruction: { operation: "decision", target: { kind: "form", formID: "frm_1", fingerprint: "short" }, answers: {} } },
    { ...base, instruction: { operation: "execute", command: "synthetic" } },
  ]) expect(parse("session.dots.exchange.create", invalid).ok).toBe(false)
})

test("typed exchanges reject caller provenance, missing recipients and non-task channels", () => {
  const input = { exchangeID: "exchange_1", expectedAttachment: target, targetSessionID: "ses_target", channel: "task", delivery: "queue", text: "Synthetic task" }
  expect(parse("session.dots.exchange.create", input).ok).toBe(true)
  expect(parse("session.dots.exchange.read", { exchangeID: "exchange_1" }).ok).toBe(true)
  for (const changed of [{ ...input, channel: "human" }, { ...input, targetSessionID: undefined }, { ...input, origin: "human" }, { ...input, remoteSource: {} }])
    expect(parse("session.dots.exchange.create", changed).ok).toBe(false)
  expect(remoteOperationAccess["session.dots.exchange.create"]).toBe("mutation")
  expect(remoteOperationAccess["session.dots.exchange.read"]).toBe("read")
})

test("Dots controls require a Session and stay in the closed operation set", () => {
  for (const [operation, input] of [
    ["session.dots.targets", { profile: "synthetic" }],
    ["session.dots.status", undefined],
    ["session.dots.bind", target],
    ["session.dots.unbind", { expectedTarget: target }],
    ["session.dots.send", { id: "msg_test", text: "hello", expectedTarget: target }],
    ["session.dots.pause", { expectedTarget: target }],
    ["session.dots.resume", { expectedTarget: target }],
  ] as const) {
    expect(parse(operation, input).ok).toBe(true)
    expect(parse(operation, input, null).ok).toBe(false)
  }
  expect(remoteOperationAccess["session.dots.send"]).toBe("mutation")
  expect(remoteOperationAccess["session.dots.bind"]).toBe("mutation")
  expect(remoteOperationAccess["session.dots.unbind"]).toBe("mutation")
  expect(remoteOperationAccess["session.dots.status"]).toBe("read")
  expect(remoteOperationAccess["session.dots.pause"]).toBe("mutation")
  expect(remoteOperationAccess["session.dots.resume"]).toBe("mutation")
  expect(parse("session.dots.cancel", { turnID: "turn-1" }).ok).toBe(false)
})

test("runtime controls reject missing targets, stale target shapes and caller-selected paths", () => {
  for (const operation of ["session.dots.pause", "session.dots.resume", "session.dots.unbind"]) {
    for (const input of [undefined, {}, { turnID: "turn" }, { expectedTarget: { ...target, generation: "" } },
      { expectedTarget: target, path: "/other" }, { expectedTarget: target, directory: "/tmp" }, { expectedTarget: target, turnID: "turn" }])
      expect(parse(operation, input).ok).toBe(false)
  }
})

test("the relay rejects target guessing and ambient context fields", () => {
  expect(parse("session.dots.bind", { profile: "synthetic", label: "V" }).ok).toBe(false)
  expect(parse("session.dots.send", { text: "missing client identity" }).ok).toBe(false)
  for (const extra of [
    { history: ["ambient"] },
    { editor: "selection" },
    { accessToken: "synthetic-not-a-secret" },
    { target },
  ])
    expect(parse("session.dots.send", { id: "msg_test", text: "hello", expectedTarget: target, ...extra }).ok).toBe(
      false,
    )
})

test("device delegation operations are closed, session-scoped, and exclude caller authority", () => {
  const exchangeID = "grant-create"
  const grant = {
    id: "device-grant",
    exchangeID,
    bindingID: "binding-1",
    expectedAttachment: target,
    scope: { target: "device", operations: ["task", "decision"] },
  }
  const revoke = {
    id: grant.id,
    revision: 1,
    exchangeID: "grant-revoke",
    bindingID: grant.bindingID,
    expectedAttachment: target,
  }
  const operations = [
    ["session.dots.delegation.device.create", grant, "mutation"],
    ["session.dots.delegation.device.read", { limit: 20 }, "read"],
    ["session.dots.delegation.device.revoke", revoke, "mutation"],
  ] as const
  for (const [operation, input, access] of operations) {
    expect(parse(operation, input).ok).toBe(true)
    expect(parse(operation, input, null).ok).toBe(false)
    expect(Reflect.get(remoteOperationAccess, operation)).toBe(access)
  }
  for (const extra of [
    { expiresAt: 9_999_999 },
    { principal: { ownerID: "owner", deviceID: "device", clientID: "client", grantID: "grant", epoch: "epoch" } },
    { remoteSource: { requestID: "request", epoch: "epoch", principal: { ownerID: "owner", deviceID: "device", clientID: "client" } } },
  ]) expect(parse("session.dots.delegation.device.create", { ...grant, ...extra }).ok).toBe(false)
  expect(parse("session.dots.delegation.device.create", { ...grant, scope: { target: "device", operations: ["task", "task"] } }).ok).toBe(false)
  expect(parse("session.dots.delegation.device.create", { ...grant, scope: { target: "device", operations: [] } }).ok).toBe(false)
})

test("Dots decision inventory is scoped by confirmed device binding and grant", () => {
  const input = {
    bindingID: "binding-1",
    expectedAttachment: target,
    delegation: { id: "device-grant", revision: 1 },
    limit: 20,
  }
  expect(parse("session.dots.decisions.list", input).ok).toBe(true)
  expect(parse("session.dots.decisions.list", input, null).ok).toBe(false)
  expect(Reflect.get(remoteOperationAccess, "session.dots.decisions.list")).toBe("read")
  for (const invalid of [
    { ...input, principal: { ownerID: "owner", deviceID: "device", clientID: "client" } },
    { ...input, exchangeID: "caller-selected-exchange" },
    { ...input, limit: 101 },
    { ...input, delegation: { ...input.delegation, revision: 0 } },
  ]) expect(parse("session.dots.decisions.list", invalid).ok).toBe(false)
})

test("device decision exchanges cover all native decision candidates with strict typed choices", () => {
  const base = {
    exchangeID: "decision-exchange",
    expectedAttachment: target,
    targetSessionID: "ses_target",
    channel: "task",
    delivery: "queue",
    delegation: { id: "device-grant", revision: 1 },
  }
  const fingerprint = "a".repeat(64)
  const accepted = [
    { operation: "decision", target: { kind: "subagent_question", questionID: "qst_child", fingerprint }, text: "Answer" },
    { operation: "decision", target: { kind: "subagent_question", questionID: "qst_child", fingerprint }, dismissed: true },
    { operation: "decision", target: { kind: "review", itemID: "rvw_review", fingerprint }, decision: { kind: "recovery", choice: "continue" } },
    { operation: "decision", target: { kind: "review", itemID: "rvw_review", fingerprint }, decision: { kind: "permission", reply: "once" } },
    { operation: "decision", target: { kind: "form", formID: "frm_form", fingerprint }, cancelled: true },
    { operation: "decision", target: { kind: "question", requestID: "que_question", fingerprint }, cancelled: true },
  ]
  for (const instruction of accepted) expect(parse("session.dots.exchange.create", { ...base, instruction }).ok).toBe(true)
  for (const instruction of [
    { operation: "decision", target: { kind: "subagent_question", questionID: "qst_child", fingerprint } },
    { operation: "decision", target: { kind: "review", itemID: "rvw_review", fingerprint }, decision: { kind: "guardrail", reply: "always" } },
    { operation: "decision", target: { kind: "review", itemID: "rvw_review", fingerprint }, decision: { kind: "review", reply: "once" } },
    { operation: "decision", target: { kind: "review", itemID: "rvw_review", fingerprint }, decision: { kind: "recovery", choice: "approve" } },
  ]) expect(parse("session.dots.exchange.create", { ...base, instruction }).ok).toBe(false)
})
