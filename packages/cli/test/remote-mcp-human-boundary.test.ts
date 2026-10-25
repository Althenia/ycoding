import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import { requireSession, type RemoteRequest } from "@ycoding-ai/remote"
import type { LocalServer } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"

const appContext = {
  requestID: "request_fixture",
  epoch: "epoch_fixture",
  principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" },
}

const reviewBase = { sessionID: "ses_child", rootSessionID: "ses_1", sessionTitle: "Child", created: 1, reason: "escalated" }
const reviewItems = [
  { ...reviewBase, itemID: "rvw_hard", kind: "guardrail", origin: { requestID: "grq_hard" }, payload: { type: "guardrail", action: "shell", resources: ["synthetic"], ruleIDs: ["standard.hard.delete"], reason: "delete", hardReview: true, directories: [], fingerprint: "a".repeat(64), requestID: "grq_hard" } },
  { ...reviewBase, itemID: "rvw_custom", kind: "guardrail", origin: { requestID: "grq_custom" }, payload: { type: "guardrail", action: "shell", resources: ["synthetic"], ruleIDs: ["custom.synthetic"], reason: "custom", hardReview: true, directories: [], fingerprint: "c".repeat(64), requestID: "grq_custom" } },
  { ...reviewBase, itemID: "rvw_ordinary", kind: "guardrail", reason: "disabled", origin: { requestID: "grq_ordinary" }, payload: { type: "guardrail", action: "shell", resources: ["synthetic"], ruleIDs: ["standard.review.outside-repo"], reason: "outside", directories: ["/synthetic"], fingerprint: "d".repeat(64), requestID: "grq_ordinary" } },
  { ...reviewBase, itemID: "rvw_question", kind: "question", reason: "free_text", origin: { messageID: "msg_1", callID: "call_1" }, payload: { type: "form", title: "Scope", fields: [{ key: "q0", type: "string" }], questionTool: true } },
  { ...reviewBase, itemID: "rvw_child", kind: "subagent_question", reason: "low_confidence", origin: { questionID: "qst_1" }, payload: { type: "subagent_question", text: "Which branch?" } },
  { ...reviewBase, itemID: "rvw_permission", kind: "permission", reason: "sleep_entry", origin: { requestID: "per_1" }, payload: { type: "permission", action: "edit", resources: ["src/a.ts"], fingerprint: "b".repeat(64), requestID: "per_1" } },
  { ...reviewBase, itemID: "rvw_recovery", kind: "recovery", reason: "restart", origin: { sessionID: "ses_child" }, payload: { type: "recovery" } },
]
const form = { id: "frm_1", sessionID: "ses_1", title: "Approval", metadata: { kind: "question" }, fields: [{ key: "approved", type: "boolean", title: "Approve?", required: true }] }

const humanDecisions: ReadonlyArray<readonly [RemoteRequest["operation"], Record<string, unknown>]> = [
  ["session.permission.reply", { requestID: "per_1", reply: "once" }],
  ["session.permission.reply", { requestID: "per_1", reply: "always", message: "approved" }],
  ["session.guardrail.reply", { requestID: "grq_hard", reply: "once" }],
  ["session.guardrail.reply", { requestID: "grq_ordinary", reply: "always" }],
  ["session.form.reply", { formID: "frm_1", answer: { approved: true } }],
  ["session.form.cancel", { formID: "frm_1" }],
  ["session.review.decide", { itemID: "rvw_hard", decision: { kind: "guardrail", reply: "once" } }],
  ["session.review.decide", { itemID: "rvw_custom", decision: { kind: "guardrail", reply: "once" } }],
  ["session.review.decide", { itemID: "rvw_ordinary", decision: { kind: "guardrail", reply: "always" } }],
  ["session.review.decide", { itemID: "rvw_permission", decision: { kind: "permission", reply: "once" } }],
  ["session.review.decide", { itemID: "rvw_question", decision: { kind: "question", answers: { q0: "main" } } }],
  ["session.review.decide", { itemID: "rvw_question", decision: { kind: "question", dismissed: true } }],
  ["session.review.decide", { itemID: "rvw_child", decision: { kind: "subagent_question", text: "main" } }],
  ["session.review.decide", { itemID: "rvw_recovery", decision: { kind: "recovery", choice: "continue" } }],
  ["session.review.decide", { itemID: "rvw_recovery", decision: { kind: "recovery", choice: "stop" } }],
  ["session.subagent.answer", { childID: "ses_child", questionID: "qst_1", text: "staging" }],
]

const forgedAuthority = [
  { humanAttestation: true },
  { origin: "human" },
  { approvedBy: "owner_fixture" },
  { delegatedDecision: { categories: ["question", "permission", "review"] } },
  { appContext: null },
]

type Call = { readonly method: string; readonly args: readonly unknown[] }

function sessionInfo(id: string, parentID?: string): SessionInfo {
  return {
    id,
    ...(parentID === undefined ? {} : { parentID, agent: "general" }),
    projectID: "prj_1",
    model: { providerID: "test", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    title: id,
    location: { directory: "/work", workspaceID: undefined },
  } as unknown as SessionInfo
}

async function harness() {
  const sessions = [sessionInfo("ses_1"), sessionInfo("ses_child", "ses_1")]
  const results: Partial<Record<keyof LocalServer, unknown>> = {
    listPage: async () => ({ data: sessions }),
    getSession: async (sessionID: string) => sessions.find((info) => info.id === sessionID),
    permissionRequests: [{ id: "per_1", sessionID: "ses_1" }],
    guardrailRequestList: [{ id: "grq_hard" }, { id: "grq_ordinary" }],
    formList: [form],
    formRequests: [form],
    reviewList: async () => reviewItems,
    subagentPage: async () => ({ data: [{ sessionID: "ses_child", parentID: "ses_1", stoppedRecovery: { itemID: "rvw_recovery" } }] }),
    subagentAnswer: async () => ({ sessionID: "ses_child", state: "running" }),
    subagentCancel: async () => ({ sessionID: "ses_child", state: "cancelling" }),
  }
  const calls: Call[] = []
  const local = new Proxy({} as LocalServer, {
    get(_target, property: PropertyKey) {
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args })
        const result = results[property as keyof LocalServer]
        if (typeof result === "function") return Promise.resolve((result as (...a: unknown[]) => unknown)(...args))
        return Promise.resolve(result)
      }
    },
  })
  const registry = createSessionRegistry({ local })
  await registry.refresh()
  calls.length = 0
  const subscriptions = createSubscriptions()
  const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>, context?: typeof appContext) =>
    executeRemoteOperation({
      request: { type: "request", id: "req_boundary", operation, ...(requireSession(operation) ? { sessionID: "ses_1" } : {}), ...(input === undefined ? {} : { input }) },
      local,
      sessions: registry,
      subscriptions,
      ...(context === undefined ? {} : { appContext: context }),
    })
  return { calls, run }
}

function errorOf(frames: readonly { ok: boolean }[]) {
  expect(frames).toHaveLength(1)
  const frame = frames[0] as { ok: false; error: { code: string; message: string } }
  expect(frame.ok).toBe(false)
  return frame.error
}

function okOf(frames: readonly { ok: boolean }[]) {
  expect(frames).toHaveLength(1)
  const frame = frames[0] as { ok: true; value: unknown }
  expect(frame.ok).toBe(true)
  return frame.value
}

describe("automation cannot settle human-only decisions", () => {
  test("every human decision operation refuses an authenticated MCP context before any local call", async () => {
    for (const [operation, input] of humanDecisions) {
      const fixture = await harness()
      const error = errorOf(await fixture.run(operation, input, appContext))
      expect(error.code).toBe("forbidden")
      expect(error.message.length).toBeLessThanOrEqual(256)
      expect(error.message).not.toContain(appContext.principal.clientID)
      expect(error.message).not.toContain(String(Object.values(input)[0]))
      expect(fixture.calls).toEqual([])
    }
  })

  test("forged authority fields and malformed payloads never reach validation or the local server", async () => {
    for (const [operation, input] of humanDecisions)
      for (const forged of [...forgedAuthority, { requestID: "malformed" }]) {
        const fixture = await harness()
        expect(errorOf(await fixture.run(operation, { ...input, ...forged }, appContext)).code).toBe("forbidden")
        expect(fixture.calls).toEqual([])
      }
  })

  test("hard, custom, ordinary, deferred, and recovery items stay open and readable after automation attempts", async () => {
    const fixture = await harness()
    for (const [operation, input] of humanDecisions.filter(([operation]) => operation === "session.review.decide"))
      expect(errorOf(await fixture.run(operation, input, appContext)).code).toBe("forbidden")
    expect(okOf(await fixture.run("session.review.list", undefined, appContext))).toEqual({ data: reviewItems })
    expect(okOf(await fixture.run("session.guardrail.request.list", undefined, appContext))).toEqual({ data: [{ id: "grq_hard" }, { id: "grq_ordinary" }] })
    expect(okOf(await fixture.run("session.form.list", undefined, appContext))).toEqual([form])
    expect(fixture.calls.map((call) => call.method).filter((method) => /Reply|Cancel|Decide|Answer/.test(method))).toEqual([])
  })

  test("listed non-decision controls still forward with an authenticated MCP context", async () => {
    const fixture = await harness()
    expect(okOf(await fixture.run("session.interrupt", undefined, appContext))).toBeNull()
    expect(okOf(await fixture.run("session.subagent.cancel", { childID: "ses_child" }, appContext))).toMatchObject({ data: { state: "cancelling" } })
    expect(fixture.calls.filter((call) => call.method === "interrupt" || call.method === "subagentCancel")).toEqual([
      { method: "interrupt", args: ["ses_1", { directory: "/work" }] },
      { method: "subagentCancel", args: ["ses_1", "ses_child", { directory: "/work" }] },
    ])
  })
})

describe("native and browser decisions keep their authenticated paths", () => {
  test("each human decision forwards unchanged when no MCP context is present", async () => {
    const expected: Record<string, string> = {
      "session.permission.reply": "permissionReply",
      "session.guardrail.reply": "guardrailReply",
      "session.form.reply": "formReply",
      "session.form.cancel": "formCancel",
      "session.review.decide": "reviewDecide",
      "session.subagent.answer": "subagentAnswer",
    }
    for (const [operation, input] of humanDecisions) {
      const fixture = await harness()
      const frames = await fixture.run(operation, input)
      expect(frames[0]?.ok).toBe(true)
      expect(fixture.calls.filter((call) => call.method === expected[operation])).toHaveLength(1)
    }
  })
})
