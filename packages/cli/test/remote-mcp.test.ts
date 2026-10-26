import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import { RemoteLimits, remoteOperations } from "@ycoding-ai/remote"
import { LocalFailure, type LocalServer } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions, successFrames } from "../src/remote-operations"
import { createRemoteMcp, toolResult } from "../src/remote-mcp"
import { RemoteMcpSchemas } from "../src/remote-mcp-schemas"
import { RemoteMcpForms } from "../src/remote-mcp-forms"

const resource = "https://relay.example.com/api/mcp/devices/dev_1"
const context = {
  requestID: "request_fixture",
  epoch: "epoch_1",
  principal: { ownerID: "own_1", deviceID: "dev_1", clientID: "client_1" },
}
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
}

const expectedTools = [
  "session_dots_decision_form",
  "session_dots_exchange_create",
  "session_dots_exchange_read",
  "provider_auth_list",
  "provider_auth_key",
  "provider_auth_begin",
  "provider_auth_status",
  "provider_auth_complete",
  "provider_auth_cancel",
  "workspace_list",
  "workspace_catalog",
  "workspace_file_find",
  "session_list",
  "session_active",
  "session_get",
  "session_delete",
  "session_messages",
  "session_captured_changes_list",
  "session_compaction_list",
  "session_compact",
  "session_snapshot",
  "session_pending_list",
  "session_attachment_read",
  "session_todo_list",
  "session_subagent_list",
  "session_pin",
  "session_unpin",
  "session_subagent_cancel",
  "session_team_economics",
  "session_team_shell_list",
  "session_team_shell_kill",
  "session_side_chat_list",
  "session_side_chat_create",
  "session_family_activity",
  "session_log",
  "session_prompt",
  "session_interrupt",
  "session_prediction",
  "session_prompt_generate",
  "session_permission_list",
  "session_guardrail_status",
  "session_guardrail_request_list",
  "session_review_list",
  "session_form_list",
  "session_shell_output",
  "session_autonomy_get",
  "session_autonomy_set",
  "session_goal_set",
  "session_goal_stop",
  "session_create",
  "session_status",
  "session_catalog",
  "session_file_find",
  "session_switch_model",
  "session_switch_agent",
  "session_command",
  "session_skill",
  "usage_providers",
  "usage_summary",
  "usage_report",
  "session_usage_report",
  "session_prompt_costs",
  "session_task_costs",
  "usage_forecast",
  "incident_report",
  "incident_recent",
  "incident_guidance",
  "incident_guidance_clear",
  "machine_keep_awake_get",
  "machine_keep_awake_set",
  "artifact_demo_preview",
  "artifact_demo_export",
  "coordination_settings",
  "coordination_list",
  "coordination_create",
  "coordination_get",
  "coordination_update",
  "coordination_delete",
  "local_app_register",
  "local_app_list",
  "local_app_revoke",
  "local_app_open",
  "local_app_status",
  "local_app_http",
  "session_create_in_directory",
]
const excludedOperations = [
  "session.subscribe",
  "session.unsubscribe",
  "session.message.stream",
  "session.attachment.upload",
  "machine.telemetry.consent.get",
  "machine.telemetry.consent.set",
  "machine.latency.append",
  "machine.latency.list",
  "session.dots.targets",
  "session.dots.status",
  "session.dots.bind",
  "session.dots.unbind",
  "session.dots.send",
  "session.dots.pause",
  "session.dots.resume",
  "session.subagent.answer",
  "session.permission.reply",
  "session.guardrail.reply",
  "session.review.decide",
  "session.form.reply",
  "session.form.cancel",
]

function sessionInfo(id: string, directory = "/work"): SessionInfo {
  return {
    id,
    projectID: "prj_1",
    model: { providerID: "test", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    title: id,
    location: { directory, workspaceID: undefined },
  } as unknown as SessionInfo
}

type Call = { readonly method: string; readonly args: readonly unknown[] }
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function fixture(
  results: Partial<Record<keyof LocalServer, unknown>> = {},
  sessions = [sessionInfo("ses_1"), sessionInfo("ses_2")],
  verification: { verifyWindowMs?: number } = {},
) {
  results.listPage ??= async () => ({ data: sessions })
  results.getSession ??= async (sessionID: string) => sessions.find((info) => info.id === sessionID)
  results.outstandingSessions ??= { data: [], running: [], failed: [], lost: [] }
  const calls: Call[] = []
  const local = new Proxy({} as LocalServer, {
    get:
      (_target, property: PropertyKey) =>
      (...args: unknown[]) => {
        calls.push({ method: String(property), args })
        const result = results[property as keyof LocalServer]
        if (typeof result === "function") return Promise.resolve((result as (...a: unknown[]) => unknown)(...args))
        if (result instanceof Error) return Promise.reject(result)
        return Promise.resolve(result)
      },
  })
  const registry = createSessionRegistry({ local, ...verification })
  await registry.refresh()
  calls.length = 0
  const state = { allowed: true, now: 1000, onAdmission: () => {} }
  const holds: boolean[] = []
  const observations: unknown[] = []
  const subscriptions = createSubscriptions()
  const create = () => {
    const created = createRemoteMcp({
      local,
      sessions: registry,
      subscriptions,
      resource,
      allowed: (epoch) => state.allowed && epoch === context.epoch,
      now: () => state.now,
      onLaneHold: (held) => holds.push(held),
      onCapabilities: (value) => {
        observations.push(value)
        if (value !== undefined) state.onAdmission()
      },
    })
    closers.push(() => created.close())
    return created
  }
  const mcp = create()
  let current = mcp
  const restart = async () => {
    await current.close()
    current = create()
  }
  const request = (
    method: string,
    params: Record<string, unknown>,
    init: { name?: string; signal?: AbortSignal; body?: BodyInit; url?: string; verb?: string } = {},
  ) =>
    current.fetch(
      new Request(init.url ?? resource, {
        method: init.verb ?? "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(init.name === undefined ? {} : { "mcp-name": init.name }),
        },
        body: init.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      }),
      context,
    )
  const tool = (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
    request("tools/call", { name, arguments: args }, { name, ...(signal === undefined ? {} : { signal }) })
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await tool(name, args)
    expect(response.status).toBe(200)
    return (
      (await response.json()) as {
        result: { isError?: boolean; structuredContent?: unknown; content: { text: string }[] }
      }
    ).result
  }
  return { mcp, calls, state, request, tool, run, results, holds, restart, observations }
}

describe("delegated MRTR forms", () => {
  const target = { kind: "permission", requestID: "per_fixture", fingerprint: "f".repeat(64) }
  const input = { exchangeID: "form_decision", taskExchangeID: "source_task", expectedAttachment: { profile: "fixture", dotID: "dot", threadID: "thread", generation: "1", label: "V" }, targetSessionID: "ses_1", channel: "task", delivery: "queue", delegation: { id: "proposal", revision: 1 }, instruction: { operation: "decision", target } }
  const envelope = { coordinator: context.principal, scope: { epoch: context.epoch, grantID: "grant_fixture" }, exchangeID: "source_task", messageID: "msg_fixture", targetSessionID: "ses_1", origin: "plugin", kind: "task" }
  const exchange = { sessionID: "ses_1", targetSessionID: "ses_1", exchangeID: "source_task", inputID: "msg_fixture", channel: "task", state: "running", envelope, progress: [] }
  const capabilities = { elicitation: {} }
  async function setup(candidate: unknown = { target, action: "edit", resources: ["src/synthetic.ts"] }) {
    const f = await fixture({ dotsExchangeRead: { ...exchange, decisions: [candidate] }, dotsExchangeCreate: { ...exchange, exchangeID: "form_decision", decisionOutcome: { target, state: "settled", reply: "once" } } })
    const call = async (extra: Record<string, unknown> = {}, args: Record<string, unknown> = { sessionID: "ses_1", input }, caps: unknown = capabilities, principal = context, signal?: AbortSignal) => {
      const response = await f.mcp.fetch(new Request(resource, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-method": "tools/call", "mcp-name": "session_dots_decision_form", "mcp-protocol-version": "2026-07-28" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session_dots_decision_form", arguments: args, _meta: { ...meta, "io.modelcontextprotocol/clientCapabilities": caps }, ...extra } }), ...(signal ? { signal } : {}),
      }), principal)
      return response.json()
    }
    return { ...f, call }
  }
  test("MRTR standard form capability matrix never borrows another request's declaration", async () => {
    const f = await setup()
    for (const [caps, parent, form, url, supported] of [
      [{}, "absent", "absent", "absent", false],
      [{ elicitation: null }, "malformed", "malformed", "malformed", false],
      [{ elicitation: false }, "malformed", "malformed", "malformed", false],
      [{ elicitation: true }, "malformed", "malformed", "malformed", false],
      [{ elicitation: { form: null } }, "declared-object", "malformed", "absent", false],
      [{ elicitation: { form: false } }, "declared-object", "malformed", "absent", false],
      [{ elicitation: { url: {} } }, "declared-object", "absent", "declared-object", false],
      [{ elicitation: { unknown: {} } }, "declared-object", "absent", "absent", false],
      [{ extensions: { "openai/elicitation": { form: {} } } }, "absent", "absent", "absent", false],
      [{ elicitation: {} }, "declared-object", "implied-by-empty-object", "absent", true],
      [{ elicitation: { form: {} } }, "declared-object", "declared-object", "absent", true],
    ] as const) {
      expect(RemoteMcpForms.capabilities({ ...meta, "io.modelcontextprotocol/clientCapabilities": caps })).toEqual({ protocolVersion: "2026-07-28", elicitation: parent, form, url })
      const value = await f.call({}, undefined, caps)
      if (supported) expect(value.result).toMatchObject({ resultType: "input_required", requestState: expect.any(String) })
      if (!supported) expect(value.result?.isError === true || value.error !== undefined).toBe(true)
    }
    expect((await f.call({}, undefined, {})).result.isError).toBe(true)
    expect(f.calls.filter((c) => c.method === "dotsExchangeCreate")).toHaveLength(0)
  })
  test("MRTR malformed arguments and protocol disagreement issue no form state", async () => {
    const f = await setup()
    const malformed = await f.call({}, { sessionID: "ses_1", input: { ...input, extra: true } })
    expect(malformed.result.isError).toBe(true)
    expect(malformed.result.requestState).toBeUndefined()
    const protocol = await f.call({ _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "2025-11-25", "io.modelcontextprotocol/clientCapabilities": capabilities } })
    expect(protocol.error).toBeDefined()
    expect(f.calls.filter((c) => c.method === "dotsExchangeRead")).toHaveLength(0)
  })
  test("MRTR accepted client reply dispatches once, preserves native rejection, and consumes opaque state", async () => {
    for (const reply of ["once", "reject"]) {
      const f = await setup()
      const first = (await f.call()).result
      expect(first).toMatchObject({ resultType: "input_required", inputRequests: { decision: { method: "elicitation/create", params: { mode: "form" } } } })
      const result = await f.call({ requestState: first.requestState, inputResponses: { decision: { action: "accept", content: { reply } } } })
      expect(result.result.isError).toBeUndefined()
      const create = f.calls.filter((c) => c.method === "dotsExchangeCreate")
      expect(create).toHaveLength(1)
      expect(create[0]?.args).toContainEqual(expect.objectContaining({ instruction: { operation: "decision", target, reply } }))
      expect((await f.call({ requestState: first.requestState, inputResponses: { decision: { action: "accept", content: { reply } } } })).error.code).toBe(-32602)
      expect(f.calls.filter((c) => c.method === "dotsExchangeCreate")).toHaveLength(1)
    }
  })
  test("MRTR decline cancel missing dropped and invalid content never dispatch a native rejection", async () => {
    for (const response of [{ action: "decline" }, { action: "cancel" }, undefined, { method: "elicitation/create", result: { action: "accept", content: { reply: "once" } } }, { action: "accept", content: {} }, { action: "accept", content: { reply: "always" } }]) {
      const f = await setup()
      const first = (await f.call()).result
      const value = await f.call({ requestState: first.requestState, inputResponses: response === undefined ? {} : { decision: response } })
      expect(value.result?.resultType).not.toBe("input_required")
      expect(f.calls.filter((c) => c.method === "dotsExchangeCreate")).toHaveLength(0)
    }
  })
  test("MRTR rejects a valid client decision alongside an SDK-dropped wrapped response", async () => {
    const f = await setup()
    const first = (await f.call()).result
    const decision = { action: "accept", content: { reply: "once" } }
    const value = await f.call({ requestState: first.requestState, inputResponses: { decision, wrapped: { method: "elicitation/create", result: decision } } })
    expect(f.calls.filter((call) => call.method === "dotsExchangeCreate")).toHaveLength(0)
    expect(value.result).toMatchObject({ isError: true, structuredContent: { error: { code: "invalid_message" } } })
    expect((await f.call({ requestState: first.requestState, inputResponses: { decision } })).error.code).toBe(-32602)
  })
  test("MRTR validates every representable Form type and preserves false versus absent without defaults", async () => {
    const formTarget = { kind: "form", formID: "frm_fixture", fingerprint: target.fingerprint }
    const fields = [
      { key: "name", type: "string", required: true, minLength: 1, maxLength: 12, pattern: "^[a-z]+$", default: "invented" },
      { key: "count", type: "integer", minimum: 1, maximum: 3, required: true },
      { key: "ratio", type: "number", minimum: 0, maximum: 1, required: true },
      { key: "enabled", type: "boolean", required: true, default: true },
      { key: "branch", type: "string", options: [{ value: "main", label: "Main" }], required: true },
      { key: "tags", type: "multiselect", options: [{ value: "safe", label: "Safe" }], minItems: 1, maxItems: 2, required: true },
      { key: "custom", type: "string", options: [{ value: "option", label: "Option" }], custom: true },
      { key: "optional", type: "boolean", default: true },
      { key: "free", type: "string", options: [], custom: true },
    ]
    const f = await setup({ target: formTarget, title: "Synthetic choices", fields })
    const args = { sessionID: "ses_1", input: { ...input, instruction: { operation: "decision", target: formTarget } } }
    const first = (await f.call({}, args)).result
    const schema = first.inputRequests.decision.params.requestedSchema
    expect(JSON.stringify(schema)).not.toContain('"default"')
    expect(schema.properties.enabled.type).toBe("boolean")
    const answer = { name: "safe", count: 2, ratio: 0.5, enabled: false, branch: "main", tags: ["safe"], custom__custom: "other", free: "synthetic" }
    expect((await f.call({ requestState: first.requestState, inputResponses: { decision: { action: "accept", content: answer } } }, args)).result.isError).toBeUndefined()
    expect(f.calls.filter((c) => c.method === "dotsExchangeCreate")[0]?.args).toContainEqual(expect.objectContaining({ instruction: { operation: "decision", target: formTarget, answers: { name: "safe", count: 2, ratio: 0.5, enabled: false, branch: "main", tags: ["safe"], custom: "other", free: "synthetic" } } }))
    const second = (await f.call({}, args)).result
    expect((await f.call({ requestState: second.requestState, inputResponses: { decision: { action: "accept", content: { ...answer, enabled: undefined } } } }, args)).result.isError).toBe(true)
    expect(f.calls.filter((c) => c.method === "dotsExchangeCreate")).toHaveLength(1)
  })
  test("MRTR questions map single multiple and custom text without nested schemas", async () => {
    const questionTarget = { kind: "question", requestID: "que_fixture", fingerprint: target.fingerprint }
    const questions = [{ question: "Branch?", header: "Branch", options: [{ label: "main", description: "Main" }], custom: false }, { question: "Tags?", header: "Tags", options: [{ label: "safe", description: "Safe" }], multiple: true, custom: false }, { question: "Name?", header: "Name", options: [] }]
    const f = await setup({ target: questionTarget, questions })
    const args = { sessionID: "ses_1", input: { ...input, instruction: { operation: "decision", target: questionTarget } } }
    const first = (await f.call({}, args)).result
    expect((await f.call({ requestState: first.requestState, inputResponses: { decision: { action: "accept", content: { q0: "main", q1: ["safe"], q2: "synthetic" } } } }, args)).result.isError).toBeUndefined()
    expect(f.calls.filter((c) => c.method === "dotsExchangeCreate")[0]?.args).toContainEqual(expect.objectContaining({ instruction: { operation: "decision", target: questionTarget, answers: [["main"], ["safe"], ["synthetic"]] } }))
  })
  test("MRTR standard-form validation rejects invalid scalar selection and custom values", async () => {
    for (const [field, value] of [
      [{ key: "value", type: "string", minLength: 2, maxLength: 3, required: true }, "x"],
      [{ key: "value", type: "integer", required: true }, 1.5],
      [{ key: "value", type: "number", minimum: 0, maximum: 1, required: true }, 2],
      [{ key: "value", type: "boolean", required: true }, "false"],
      [{ key: "value", type: "string", options: [{ value: "listed", label: "Listed" }], required: true }, "other"],
      [{ key: "value", type: "multiselect", options: [{ value: "listed", label: "Listed" }], maxItems: 1, required: true }, ["other"]],
      [{ key: "value", type: "string", format: "email", required: true }, "invalid"],
    ] as const) {
      const formTarget = { kind: "form", formID: "frm_fixture", fingerprint: target.fingerprint }
      const f = await setup({ target: formTarget, fields: [field] })
      const args = { sessionID: "ses_1", input: { ...input, instruction: { operation: "decision", target: formTarget } } }
      const round = (await f.call({}, args)).result
      expect(round.resultType).toBe("input_required")
      expect((await f.call({ requestState: round.requestState, inputResponses: { decision: { action: "accept", content: { value } } } }, args)).result.isError).toBe(true)
      expect(f.calls.filter((c) => c.method === "dotsExchangeCreate")).toHaveLength(0)
    }
  })
  test("MRTR ordinary guardrail form returns only a one-time or reject client instruction", async () => {
    const guardrailTarget = { kind: "guardrail", requestID: "grq_fixture", fingerprint: target.fingerprint }
    const f = await setup({ target: guardrailTarget, ruleIDs: ["standard.review.synthetic"] })
    const args = { sessionID: "ses_1", input: { ...input, instruction: { operation: "decision", target: guardrailTarget } } }
    const round = (await f.call({}, args)).result
    expect(round.inputRequests.decision.params.requestedSchema.properties.reply.oneOf.map((option: { const: string }) => option.const)).toEqual(["once", "reject"])
    expect((await f.call({ requestState: round.requestState, inputResponses: { decision: { action: "accept", content: { reply: "once" } } } }, args)).result.isError).toBeUndefined()
    expect(f.calls.filter((c) => c.method === "dotsExchangeCreate")[0]?.args).toContainEqual(expect.objectContaining({ instruction: { operation: "decision", target: guardrailTarget, reply: "once" } }))
  })
  test("MRTR unsupported fields and stale candidates fail before minting state", async () => {
    for (const fields of [[{ key: "conditional", type: "boolean", when: [{ key: "x", op: "eq", value: true }] }], [{ key: "external", type: "external", url: "https://example.invalid" }], [{ key: "custom", type: "multiselect", options: [], custom: true }], [{ key: "name", type: "string", options: [{ value: "listed", label: "Listed" }], custom: true }, { key: "name__custom", type: "string" }]]) {
      const formTarget = { kind: "form", formID: "frm_fixture", fingerprint: target.fingerprint }
      const f = await setup({ target: formTarget, fields })
      const value = await f.call({}, { sessionID: "ses_1", input: { ...input, instruction: { operation: "decision", target: formTarget } } })
      expect(value.result.isError).toBe(true)
      expect(value.result.requestState).toBeUndefined()
    }
    const f = await setup({ target: { ...target, fingerprint: "e".repeat(64) } })
    expect((await f.call()).result.isError).toBe(true)
  })
  test("MRTR state rejects tamper principal arguments expiry revocation and shutdown", async () => {
    for (const kind of ["tamper", "principal", "epoch", "arguments", "expiry", "revocation", "shutdown", "disconnect"]) {
      const f = await setup()
      const first = (await f.call()).result
      if (kind === "expiry") f.state.now += 300_001
      if (kind === "revocation") f.state.allowed = false
      if (kind === "shutdown") await f.mcp.close()
      if (kind === "disconnect") f.mcp.clearAccess()
      const extra = { requestState: kind === "tamper" ? "forged" : first.requestState, inputResponses: { decision: { action: "accept", content: { reply: "once" } } } }
      const result = await f.call(extra, kind === "arguments" ? { sessionID: "ses_1", input: { ...input, exchangeID: "other" } } : undefined, capabilities, kind === "principal" ? { ...context, principal: { ...context.principal, clientID: "other" } } : kind === "epoch" ? { ...context, epoch: "other_epoch" } : context)
      expect(result.error !== undefined || result.result?.isError === true).toBe(true)
      expect(f.calls.filter((c) => c.method === "dotsExchangeCreate")).toHaveLength(0)
    }
  })
  test("MRTR revalidates source candidate grant and native errors before applying client data", async () => {
    for (const change of ["grant", "candidate", "missing", "native"]) {
      const f = await setup()
      const first = (await f.call()).result
      if (change === "grant") f.results.dotsExchangeRead = { ...exchange, envelope: { ...envelope, scope: { ...envelope.scope, grantID: "changed" } }, decisions: [{ target }] }
      if (change === "candidate") f.results.dotsExchangeRead = { ...exchange, decisions: [{ target, action: "changed" }] }
      if (change === "missing") f.results.dotsExchangeRead = { ...exchange, decisions: [] }
      if (change === "native") f.results.dotsExchangeCreate = new LocalFailure("invalid", "Native validator rejected the synthetic answer")
      const result = await f.call({ requestState: first.requestState, inputResponses: { decision: { action: "accept", content: { reply: "once" } } } })
      expect(result.result.isError).toBe(true)
      expect(f.calls.filter((c) => c.method === "dotsExchangeCreate")).toHaveLength(change === "native" ? 1 : 0)
      expect(f.holds).toEqual([])
    }
  })
  test("MRTR form capacity expires without eviction and observations stay bounded and private", async () => {
    const f = await setup()
    for (let index = 0; index < 256; index++) expect((await f.call()).result.resultType).toBe("input_required")
    expect((await f.call()).result.isError).toBe(true)
    f.state.now += 300_001
    expect((await f.call()).result.resultType).toBe("input_required")
    for (let index = 0; index < 257; index++) await f.call({}, undefined, {}, { ...context, principal: { ...context.principal, clientID: `synthetic_${index}` } })
    const last = f.observations.at(-1)
    expect(Array.isArray(last) && last.length).toBe(256)
    expect(JSON.stringify(last)).not.toMatch(/synthetic_|clientInfo|clientID|grantID/)
    expect(f.calls.filter((c) => c.method === "dotsExchangeCreate")).toHaveLength(0)
  }, 60000)
  test("MRTR unknown settlement retains the lane until the existing exact settled read and never replays", async () => {
    const f = await setup()
    f.results.dotsExchangeCreate = new LocalFailure("transport", "Unknown settlement")
    const first = (await f.call()).result
    const extra = { requestState: first.requestState, inputResponses: { decision: { action: "accept", content: { reply: "once" } } } }
    expect((await f.call(extra)).result.isError).toBe(true)
    expect(f.holds).toEqual([true])
    expect((await f.call(extra)).error.code).toBe(-32602)
    f.results.dotsExchangeRead = { ...exchange, exchangeID: input.exchangeID, decisionOutcome: { target, state: "pending", reply: "once" } }
    await f.run("session_dots_exchange_read", { sessionID: "ses_1", input: { exchangeID: input.exchangeID } })
    expect(f.holds).toEqual([true])
    f.results.dotsExchangeRead = { ...exchange, exchangeID: input.exchangeID, decisionOutcome: { target, state: "settled", reply: "once" } }
    await f.run("session_dots_exchange_read", { sessionID: "ses_1", input: { exchangeID: input.exchangeID } })
    expect(f.holds).toEqual([true, false])
    expect(f.calls.filter((c) => c.method === "dotsExchangeCreate")).toHaveLength(1)
  })
  test("MRTR capabilities are allowlisted bounded diagnostics cleared on close", async () => {
    const f = await setup()
    expect(f.observations).toEqual([])
    await f.call({}, undefined, {})
    await f.call()
    expect(f.observations.at(-1)).toEqual(expect.arrayContaining([{ protocolVersion: "2026-07-28", elicitation: true, form: true, url: false, observedAt: 1000 }]))
    expect(JSON.stringify(f.observations)).not.toMatch(/clientInfo|client_1|own_1|grant_fixture|request_fixture/)
    await f.mcp.close()
    expect(f.observations.at(-1)).toBeUndefined()
  })
  test("MRTR disconnect during candidate read cannot mint a token", async () => {
    const f = await setup()
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    f.results.dotsExchangeRead = async () => { entered.resolve(); await released.promise; return { ...exchange, decisions: [{ target }] } }
    const pending = f.call()
    await entered.promise
    f.mcp.clearAccess()
    released.resolve()
    expect((await pending).result.isError).toBe(true)
    expect(f.observations.at(-1)).toBeUndefined()
    expect(f.calls.filter((c) => c.method === "dotsExchangeCreate")).toHaveLength(0)
  })
})

describe("inventory and discovery", () => {
  test("uncertain routine exchanges reconcile only the exact task, delegation and presentation instruction", async () => {
    const input = { exchangeID: "routine", expectedAttachment: { profile: "fixture", dotID: "dot", threadID: "thread", generation: "1", label: "V" }, targetSessionID: "ses_1", channel: "task", delivery: "queue", delegation: { id: "proposal", revision: 1 }, taskInputID: "msg_human", instruction: { operation: "presentation", preferences: { format: "bullets", detail: "concise" } } }
    for (const changed of [
      { ...input, taskInputID: "msg_other" }, { ...input, delegation: { id: "other", revision: 1 } }, { ...input, delegation: { id: "proposal", revision: 2 } },
      { ...input, instruction: { operation: "continue" } }, { ...input, instruction: { operation: "presentation", preferences: { format: "prose", detail: "concise" } } },
      { ...input, instruction: { operation: "presentation", preferences: { format: "bullets", detail: "detailed" } } },
    ]) {
      const held = await fixture({ dotsExchangeCreate: new LocalFailure("transport", "Synthetic unconfirmed response") })
      expect((await held.run("session_dots_exchange_create", { sessionID: "ses_1", input })).isError).toBe(true)
      expect(held.calls.filter((call) => call.method === "dotsExchangeCreate")).toHaveLength(1)
      expect((await held.run("session_dots_exchange_create", { sessionID: "ses_1", input: changed })).isError).toBe(true)
      expect(held.calls.filter((call) => call.method === "dotsExchangeRead")).toHaveLength(0)
      expect(held.calls.filter((call) => call.method === "dotsExchangeCreate")).toHaveLength(1)
    }
  })
  test("an unknown delegated decision outcome keeps the exchange lane held until an authoritative settled read", async () => {
    const envelope = { coordinator: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" }, scope: { epoch: "epoch_fixture", grantID: "grant_fixture" }, exchangeID: "decision_exchange", messageID: "msg_decision", targetSessionID: "ses_1", origin: "plugin", kind: "task" }
    const target = { kind: "permission", requestID: "per_delegated", fingerprint: "f".repeat(64) }
    const unknown = { sessionID: "ses_1", targetSessionID: "ses_1", exchangeID: "decision_exchange", inputID: "msg_decision", channel: "task", state: "pending", envelope, progress: [], decisionOutcome: { target, state: "unknown", reply: "once" } }
    const results: Partial<Record<keyof LocalServer, unknown>> = { dotsExchangeCreate: new LocalFailure("transport", "Synthetic unconfirmed response"), dotsExchangeRead: unknown }
    const held = await fixture(results)
    const input = { exchangeID: "decision_exchange", expectedAttachment: { profile: "fixture", dotID: "dot", threadID: "thread", generation: "1", label: "V" }, targetSessionID: "ses_1", channel: "task", delivery: "queue", delegation: { id: "proposal", revision: 1 }, instruction: { operation: "decision", target, reply: "once" } }
    expect((await held.run("session_dots_exchange_create", { sessionID: "ses_1", input })).isError).toBe(true)
    expect(held.holds).toEqual([true])
    const stillUnknown = await held.run("session_dots_exchange_create", { sessionID: "ses_1", input })
    expect(stillUnknown.isError).toBe(true)
    expect(stillUnknown.structuredContent).toEqual({ error: { code: "outcome_unknown", message: expect.any(String) } })
    expect(held.calls.filter((call) => call.method === "dotsExchangeCreate")).toHaveLength(1)
    expect((await held.run("session_dots_exchange_read", { sessionID: "ses_1", input: { exchangeID: "decision_exchange" } })).isError).toBeUndefined()
    expect(held.holds).toEqual([true])
    expect((await held.run("session_interrupt", { sessionID: "ses_1" })).isError).toBe(true)
    results.dotsExchangeRead = { ...unknown, decisionOutcome: { target, state: "settled", reply: "once" } }
    const reconciled = await held.run("session_dots_exchange_create", { sessionID: "ses_1", input })
    expect(reconciled.isError).toBeUndefined()
    expect(held.holds).toEqual([true, false])
    expect(held.calls.filter((call) => call.method === "dotsExchangeCreate")).toHaveLength(1)
  })
  test("only an exact settled delegated decision receipt releases the exchange lane", async () => {
    const envelope = { coordinator: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" }, scope: { epoch: "epoch_fixture", grantID: "grant_fixture" }, exchangeID: "decision_exchange", messageID: "msg_decision", targetSessionID: "ses_1", origin: "plugin", kind: "task" }
    const target = { kind: "permission", requestID: "per_delegated", fingerprint: "f".repeat(64) }
    const base = { sessionID: "ses_1", targetSessionID: "ses_1", exchangeID: "decision_exchange", inputID: "msg_decision", channel: "task", state: "pending", envelope, progress: [] }
    const input = { exchangeID: "decision_exchange", expectedAttachment: { profile: "fixture", dotID: "dot", threadID: "thread", generation: "1", label: "V" }, targetSessionID: "ses_1", channel: "task", delivery: "queue", delegation: { id: "proposal", revision: 1 }, instruction: { operation: "decision", target, reply: "once" } }
    const formTarget = { kind: "form", formID: "frm_delegated", fingerprint: "f".repeat(64) }
    const formInput = { ...input, instruction: { operation: "decision", target: formTarget, answers: { branch: "safe" } } }
    const settled = { ...base, decisionOutcome: { target, state: "settled", reply: "once" } }
    const variants: Array<{ name: string; read: unknown; readError?: boolean; input?: typeof input | typeof formInput; settled?: unknown; viaRead?: boolean }> = [
      { name: "pending", read: { ...base, decisionOutcome: { target, state: "pending", reply: "once" } } },
      { name: "stale", read: { ...base, decisionOutcome: { target, state: "stale", reply: "once" } } },
      { name: "absent", read: base },
      { name: "malformed", read: { sessionID: "ses_1" }, readError: true },
      { name: "settled-wrong-fingerprint", read: { ...base, decisionOutcome: { target: { ...target, fingerprint: "e".repeat(64) }, state: "settled", reply: "once" } } },
      { name: "settled-wrong-reply", read: { ...base, decisionOutcome: { target, state: "settled", reply: "reject" } } },
      { name: "settled-wrong-anchor", read: { ...settled, sessionID: "ses_other" } },
      { name: "settled-wrong-exchange", read: { ...settled, exchangeID: "other_exchange" } },
      { name: "settled-wrong-request", read: { ...base, decisionOutcome: { target: { ...target, requestID: "per_other" }, state: "settled", reply: "once" } } },
      { name: "settled-wrong-kind", read: { ...base, decisionOutcome: { target: { kind: "guardrail", requestID: "grq_delegated", fingerprint: target.fingerprint }, state: "settled", reply: "once" } } },
      { name: "settled-direct-read", read: settled, viaRead: true },
      { name: "form-no-reply", input: formInput, read: { ...base, decisionOutcome: { target: formTarget, state: "pending" } }, settled: { ...base, decisionOutcome: { target: formTarget, state: "settled" } } },
    ]
    for (const variant of variants) {
      const variantInput = variant.input ?? input
      const results: Partial<Record<keyof LocalServer, unknown>> = { dotsExchangeCreate: new LocalFailure("transport", "Synthetic unconfirmed response"), dotsExchangeRead: variant.read }
      const held = await fixture(results)
      expect((await held.run("session_dots_exchange_create", { sessionID: "ses_1", input: variantInput })).isError, variant.name).toBe(true)
      expect(held.holds, variant.name).toEqual([true])
      const read = await held.run("session_dots_exchange_read", { sessionID: "ses_1", input: { exchangeID: "decision_exchange" } })
      expect(read.isError, variant.name).toBe(variant.readError ? true : undefined)
      if (variant.viaRead) {
        expect(held.holds, variant.name).toEqual([true, false])
        expect(held.calls.filter((call) => call.method === "dotsExchangeCreate"), variant.name).toHaveLength(1)
        continue
      }
      expect(held.holds, variant.name).toEqual([true])
      expect((await held.run("session_dots_exchange_create", { sessionID: "ses_1", input: variantInput })).isError, variant.name).toBe(true)
      expect(held.holds, variant.name).toEqual([true])
      expect(held.calls.filter((call) => call.method === "dotsExchangeCreate"), variant.name).toHaveLength(1)
      results.dotsExchangeRead = variant.settled ?? settled
      expect((await held.run("session_dots_exchange_create", { sessionID: "ses_1", input: variantInput })).isError, variant.name).toBeUndefined()
      expect(held.holds, variant.name).toEqual([true, false])
      expect(held.calls.filter((call) => call.method === "dotsExchangeCreate"), variant.name).toHaveLength(1)
    }
  })
  test("Dots report text reaches the MCP response with a program-stamped visible header", async () => {
    const envelope = { coordinator: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" }, scope: { epoch: "epoch_fixture", grantID: "grant_fixture" }, exchangeID: "exchange_fixture", messageID: "msg_report", replyToMessageID: "msg_input", sourceSessionID: "ses_1", origin: "agent", kind: "blocker" }
    const value = { sessionID: "ses_1", targetSessionID: "ses_1", exchangeID: "exchange_fixture", inputID: "msg_input", channel: "task", state: "running", envelope: { coordinator: envelope.coordinator, scope: envelope.scope, exchangeID: envelope.exchangeID, messageID: envelope.replyToMessageID, targetSessionID: "ses_1", origin: "plugin", kind: "task" }, progress: [{ deliveryID: "report_fixture", messageID: "msg_report", text: "Synthetic blocker", envelope }] }
    const { run } = await fixture({ dotsExchangeRead: value })
    const result = await run("session_dots_exchange_read", { sessionID: "ses_1", input: { exchangeID: value.exchangeID } })
    expect(result.isError).toBeUndefined()
    expect(result.content.map((item) => item.text).join("\n")).toContain("[Dots | from=ses_1 | to=owner_fixture/device_fixture/client_fixture | exchange=exchange_fixture | msg=msg_report | reply=msg_input | kind=blocker]\nSynthetic blocker")
    expect(result.structuredContent).toEqual({ data: value })
    for (const text of ["", "[Dots | from=forged]", "Synthetic\u001b[2Koverride"]) {
      const invalid = await fixture({ dotsExchangeRead: { ...value, progress: [{ ...value.progress[0], text }] } })
      const rejected = await invalid.run("session_dots_exchange_read", { sessionID: "ses_1", input: { exchangeID: value.exchangeID } })
      expect(rejected.isError).toBe(true)
      expect(rejected.content.map((item) => item.text).join("\n")).toContain("invalid")
    }
    const held = await fixture({ dotsExchangeCreate: new LocalFailure("transport", "Unconfirmed response"), dotsExchangeRead: value })
    const input = { exchangeID: value.exchangeID, expectedAttachment: { profile: "fixture", dotID: "dot_fixture", threadID: "thread_fixture", generation: "1", label: "V" }, targetSessionID: "ses_1", channel: "task", delivery: "queue", text: "Synthetic task" }
    expect((await held.run("session_dots_exchange_create", { sessionID: "ses_1", input })).isError).toBe(true)
    const reconciled = await held.run("session_dots_exchange_create", { sessionID: "ses_1", input })
    expect(reconciled.content.map((item) => item.text).join("\n")).toContain("kind=blocker]\nSynthetic blocker")
    expect(held.calls.filter((call) => call.method === "dotsExchangeCreate")).toHaveLength(1)
  })

  test("routing envelope verifies the intended device recipient and preserves managed-child ownership", async () => {
    const target = { profile: "fixture", dotID: "dot", threadID: "thread", generation: "generation", label: "V" }
    const input = { exchangeID: "routing_exchange", expectedAttachment: target, targetSessionID: "ses_2", channel: "task", delivery: "queue", text: "Synthetic task" }
    const { run, calls } = await fixture({ dotsExchangeCreate: { exchangeID: "routing_exchange", state: "pending" } }, [
      sessionInfo("ses_1"), sessionInfo("ses_2"), { ...sessionInfo("ses_child"), parentID: "ses_1" },
    ])
    expect((await run("session_dots_exchange_create", { sessionID: "ses_1", input: { ...input, targetSessionID: "ses_unknown" } })).isError).toBe(true)
    expect((await run("session_dots_exchange_create", { sessionID: "ses_1", input: { ...input, targetSessionID: "ses_child" } })).isError).toBe(true)
    expect(calls.filter((call) => call.method === "dotsExchangeCreate")).toEqual([])
    expect((await run("session_dots_exchange_create", { sessionID: "ses_1", input })).isError).toBeUndefined()
    expect(calls.filter((call) => call.method === "dotsExchangeCreate")).toHaveLength(1)
  })

  test("serves discovery and lists exactly the closed mapping with full typed schemas", async () => {
    const { request } = await fixture()
    const discovered = await request("server/discover", {})
    expect(discovered.status).toBe(200)
    const listed = (await (await request("tools/list", {})).json()) as {
      result: { tools: { name: string; inputSchema: Record<string, unknown> }[] }
    }
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(expectedTools)
    for (const tool of listed.result.tools) {
      expect(tool.inputSchema.type).toBe("object")
      if (tool.name !== "usage_forecast") expect(tool.inputSchema.additionalProperties).toBe(false)
    }
    const operations = RemoteMcpSchemas.tools.filter((tool) => tool.name !== "session_dots_decision_form")
      .map((tool) => tool.operation)
      .filter((operation) => operation !== "session.createInDirectory")
    expect(operations.map(String).toSorted()).toEqual(
      remoteOperations
        .filter((operation) => !excludedOperations.includes(operation))
        .map(String)
        .toSorted(),
    )
    expect(RemoteMcpSchemas.tools.at(-1)?.operation).toBe("session.createInDirectory")
    expect(new Set(expectedTools).size).toBe(85)
  })

  test("human-only decision tools are unpublished and calling them never reaches the local server", async () => {
    const { request, tool, calls } = await fixture()
    const listed = (await (await request("tools/list", {})).json()) as { result: { tools: { name: string; description: string }[] } }
    const names = listed.result.tools.map((item) => item.name)
    const removed = {
      session_permission_reply: { sessionID: "ses_1", input: { requestID: "per_1", reply: "once" } },
      session_guardrail_reply: { sessionID: "ses_1", input: { requestID: "grq_1", reply: "once" } },
      session_form_reply: { sessionID: "ses_1", input: { formID: "frm_1", answer: { approved: true } } },
      session_form_cancel: { sessionID: "ses_1", input: { formID: "frm_1" } },
      session_review_decide: { sessionID: "ses_1", input: { itemID: "rvw_1", decision: { kind: "recovery", choice: "continue" } } },
      session_subagent_answer: { sessionID: "ses_1", input: { childID: "ses_2", questionID: "qst_1", text: "approved", humanAttestation: true } },
    }
    for (const name of Object.keys(removed)) expect(names).not.toContain(name)
    for (const name of ["session_permission_list", "session_guardrail_request_list", "session_review_list", "session_form_list", "session_subagent_list", "session_subagent_cancel", "session_interrupt", "session_dots_exchange_create", "session_dots_exchange_read"])
      expect(names).toContain(name)
    expect(listed.result.tools.map((item) => item.description).join("\n")).not.toMatch(/permission_reply|guardrail_reply|form_reply|form_cancel|review_decide|subagent_answer/)
    for (const [name, args] of Object.entries(removed)) {
      const response = await tool(name, args)
      const body = (await response.json().catch(() => undefined)) as { result?: { isError?: boolean }; error?: unknown } | undefined
      expect(response.status !== 200 || body?.error !== undefined || body?.result?.isError === true).toBe(true)
    }
    expect(calls.filter((call) => /Reply|Cancel|Decide|Answer/.test(call.method))).toEqual([])
  })

  test("session-scoped tools require sessionID and parameterless ones publish no input", async () => {
    type InputSchema = {
      required?: string[]
      properties?: Record<string, InputSchema>
      oneOf?: InputSchema[]
      allOf?: InputSchema[]
    }
    const schemas = new Map(RemoteMcpSchemas.tools.map((tool) => [tool.name, tool.inputSchema as InputSchema]))
    expect(schemas.get("session_get")).toMatchObject({
      required: ["sessionID"],
      properties: { sessionID: { type: "string" } },
    })
    expect(schemas.get("session_get")?.properties?.input).toBeUndefined()
    expect(schemas.get("session_prompt")?.required).toEqual(["sessionID", "input"])
    expect(schemas.get("session_prompt")?.properties?.input?.required).toEqual(["id", "text"])
    expect(schemas.get("session_create")?.required).toEqual(["input"])
    expect(schemas.get("session_create")?.properties?.input?.required).toEqual(["id", "workspace"])
    for (const name of ["session_create", "session_create_in_directory"])
      expect(schemas.get(name)?.properties?.input?.properties?.title).toMatchObject({
        type: "string",
        minLength: 1,
        maxLength: 120,
      })
    expect(schemas.get("provider_auth_key")?.properties?.sessionID).toBeUndefined()
    expect(schemas.get("provider_auth_key")?.properties?.input?.properties?.target?.oneOf).toHaveLength(2)
    expect(schemas.get("incident_guidance")?.required).toEqual(["input"])
    expect(schemas.get("incident_guidance")?.properties?.sessionID).toBeDefined()
    expect(schemas.get("workspace_list")?.required).toBeUndefined()
    expect(schemas.get("usage_forecast")?.allOf).toHaveLength(1)
  })
})

describe("fixed artifact demo over authorized Relay MCP", () => {
  test("discovers only fixed resources and exports original PNG bytes without accessing a Session", async () => {
    const { request, run, calls } = await fixture()
    const catalog = (await (await request("tools/list", {})).json()) as {
      result: { tools: { name: string; _meta?: unknown; outputSchema?: unknown }[] }
    }
    expect(catalog.result.tools.find((tool) => tool.name === "artifact_demo_preview")).toMatchObject({
      _meta: { ui: { resourceUri: "ui://ycoding/artifact-demo/v1.html" } },
    })
    expect(catalog.result.tools.find((tool) => tool.name === "artifact_demo_export")?._meta).toBeUndefined()
    expect(
      catalog.result.tools
        .filter((tool) => tool.name.startsWith("artifact_demo_"))
        .every((tool) => tool.outputSchema !== undefined),
    ).toBe(true)
    expect((await run("artifact_demo_preview")).structuredContent).toMatchObject({
      variants: ["list", "cards"],
      hostVerification: "required",
    })
    const exported = await run("artifact_demo_export")
    expect(exported.structuredContent).toMatchObject({
      filename: "ycoding-demo.png",
      mime: "image/png",
      size: 79,
      sha256: "d3a97d031a3094c93d334c8e01e97c5a235ae1f44d5aab476d51311f16f0bce5",
      expiresAt: 901000,
    })
    const link = exported.content[0] as unknown as { type: string; uri: string }
    expect(link.type).toBe("resource_link")
    const read = async (uri: string) =>
      (await (await request("resources/read", { uri }, { name: uri })).json()) as {
        result: { contents: { uri: string; mimeType: string; blob?: string; text?: string; _meta?: unknown }[] }
      }
    const png = (await read(link.uri)).result.contents[0]
    const bytes = Buffer.from(png.blob ?? "", "base64")
    expect(bytes.length).toBe(79)
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "d3a97d031a3094c93d334c8e01e97c5a235ae1f44d5aab476d51311f16f0bce5",
    )
    expect(JSON.stringify(exported)).not.toContain(png.blob!)
    expect((await read(link.uri)).result.contents[0]).toEqual(png)
    const html = (await read("ui://ycoding/artifact-demo/v1.html")).result.contents[0]
    expect(html).toMatchObject({
      mimeType: "text/html;profile=mcp-app",
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } },
    })
    expect(html.text).toContain("ui/initialize")
    const listed = (await (await request("resources/list", {})).json()) as { result: { resources: { uri: string }[] } }
    expect(listed.result.resources.map((item) => item.uri)).toEqual([html.uri, png.uri])
    expect(await (await request("resources/templates/list", {})).json()).toMatchObject({
      result: { resourceTemplates: [] },
    })
    expect(calls.every((call) => call.method === "mcpEventsStatus")).toBe(true)
  })

  test("rejects paths, caller-selected Sessions and unknown resources; expiry never renews on retry", async () => {
    const { run, request, state, calls } = await fixture()
    for (const name of ["artifact_demo_preview", "artifact_demo_export"])
      for (const args of [{ path: "/etc/passwd" }, { sessionID: "ses_1" }, { input: { uri: "file:///etc/passwd" } }])
        expect((await run(name, args)).isError).toBe(true)
    for (const uri of [
      "file:///etc/passwd",
      "ui://ycoding/artifact-demo/../../secret",
      "artifact://ycoding-demo/unknown",
    ])
      expect(await (await request("resources/read", { uri }, { name: uri })).json()).toMatchObject({
        error: { code: -32602, data: { uri } },
      })
    const exported = await run("artifact_demo_export")
    const uri = (exported.content[0] as unknown as { uri: string }).uri
    state.now = 901000
    expect((await run("artifact_demo_export")).isError).toBe(true)
    expect(await (await request("resources/read", { uri }, { name: uri })).json()).toMatchObject({
      error: { code: -32602, data: { uri } },
    })
    expect(await (await request("resources/list", {})).json()).toMatchObject({
      result: { resources: [{ uri: "ui://ycoding/artifact-demo/v1.html" }] },
    })
    expect(calls.every((call) => call.method === "mcpEventsStatus")).toBe(true)
  })

  test.each(["tools/list", "resources/list", "resources/templates/list", "resources/read", "tools/call"])(
    "rechecks authority after asynchronous admission for %s",
    async (method) => {
      const { request, state, calls } = await fixture()
      const started = Promise.withResolvers<void>()
      const body = Promise.withResolvers<void>()
      const params =
        method === "resources/read"
          ? { uri: "ui://ycoding/artifact-demo/v1.html" }
          : method === "tools/call"
            ? { name: "artifact_demo_export", arguments: {} }
            : {}
      const target = "uri" in params ? params.uri : "name" in params ? params.name : undefined
      const pending = request(method, params, {
        ...(target === undefined ? {} : { name: target }),
        body: new ReadableStream({
          async start(controller) {
            started.resolve()
            await body.promise
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
              ),
            )
            controller.close()
          },
        }),
      })
      await started.promise
      state.allowed = false
      body.resolve()
      expect((await pending).status).toBe(503)
      expect(calls).toEqual([])
    },
  )

  test("cancelled and closed resource reads disclose no bytes, and a safe read retry retains identity", async () => {
    const { request, run, mcp } = await fixture()
    const exported = await run("artifact_demo_export")
    const uri = (exported.content[0] as unknown as { uri: string }).uri
    const controller = new AbortController()
    controller.abort()
    expect((await request("resources/read", { uri }, { name: uri, signal: controller.signal })).status).toBe(503)
    const retry = await request("resources/read", { uri }, { name: uri })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ result: { contents: [{ uri, mimeType: "image/png" }] } })
    await mcp.close()
    expect((await request("resources/read", { uri }, { name: uri })).status).toBe(503)
  })
})

describe("tool calls run the connector operations", () => {
  test("provider_auth_list accepts only its target and reaches the connector listing", async () => {
    const { run, calls } = await fixture({ providerIntegrations: [], integrationList: [] })
    const result = await run("provider_auth_list", { input: { target: { sessionID: "ses_1" } } })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ data: [] })
    expect(calls.filter((call) => call.method === "integrationList")).toHaveLength(1)
    expect(
      (await run("provider_auth_list", { input: { target: { sessionID: "ses_1" }, integrationID: "extra" } })).isError,
    ).toBe(true)
  })

  test("returns the complete connector value as structured content and matching text", async () => {
    const { run } = await fixture()
    const result = await run("session_get", { sessionID: "ses_1" })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ data: { id: "ses_1" } })
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent)
  })

  test("refuses inputs the published schema does not allow before Session operations", async () => {
    const { run, calls } = await fixture()
    for (const args of [
      {},
      { sessionID: "ses_1", input: {} },
      { sessionID: "ses_1", extra: 1 },
      { sessionID: "bad id" },
    ]) {
      expect((await run("session_get", args)).isError).toBe(true)
    }
    expect((await run("session_prompt", { sessionID: "ses_1", input: { text: "hi" } })).isError).toBe(true)
    expect((await run("session_create", { input: { workspace: "wsp_1" } })).isError).toBe(true)
    expect((await run("session_list", { sessionID: "ses_1" })).isError).toBe(true)
    expect(
      (await run("provider_auth_list", { sessionID: "ses_1", input: { target: { sessionID: "ses_1" } } })).isError,
    ).toBe(true)
    expect(calls.every((call) => call.method === "mcpEventsStatus")).toBe(true)
  })

  test("session_prompt stamps the authenticated remote source and never accepts a caller origin", async () => {
    const { run, calls } = await fixture({ prompt: { id: "msg_remote_source" } })
    const result = await run("session_prompt", { sessionID: "ses_1", input: { id: "msg_remote_source", text: "Remote plugin input" } })
    expect(result.isError).toBeUndefined()
    expect(calls.find((call) => call.method === "prompt")?.args).toEqual([
      "ses_1",
      { directory: "/work" },
      { id: "msg_remote_source", text: "Remote plugin input", remoteSource: context },
    ])
    expect((await run("session_prompt", { sessionID: "ses_1", input: { id: "msg_forged", text: "Forged origin", origin: "human" } })).isError).toBe(true)
    expect(calls.filter((call) => call.method === "prompt")).toHaveLength(1)
  })

  test("an unknown exchange admission reconciles through read without a second write", async () => {
    const value = { exchangeID: "exchange_unknown", expectedAttachment: { profile: "fixture", dotID: "dot", threadID: "thread", generation: "generation", label: "V" }, targetSessionID: "ses_2", channel: "task", delivery: "queue", text: "Synthetic task" }
    const { run, calls } = await fixture({
      dotsExchangeCreate: new LocalFailure("transport", "Unconfirmed response"),
      dotsExchangeRead: { exchangeID: value.exchangeID, sessionID: "ses_1", targetSessionID: "ses_2", inputID: "msg_exchange", channel: "task", state: "pending", progress: [], envelope: {
        coordinator: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" }, scope: { epoch: "epoch_fixture", grantID: "grant_fixture" },
        exchangeID: value.exchangeID, messageID: "msg_exchange", targetSessionID: "ses_2", kind: "task", origin: "plugin",
      } },
    })
    expect((await run("session_dots_exchange_create", { sessionID: "ses_1", input: value })).isError).toBe(true)
    expect((await run("session_dots_exchange_create", { sessionID: "ses_1", input: value })).isError).toBeUndefined()
    expect(calls.filter((call) => call.method === "dotsExchangeCreate")).toHaveLength(1)
    expect(calls.filter((call) => call.method === "dotsExchangeRead")).toHaveLength(1)
  })

  test("an unreconciled exchange remains read-only and rejects changed retry content", async () => {
    const value = { exchangeID: "exchange_unknown", expectedAttachment: { profile: "fixture", dotID: "dot", threadID: "thread", generation: "generation", label: "V" }, targetSessionID: "ses_2", channel: "task", delivery: "queue", text: "Synthetic task" }
    const { run, calls } = await fixture({ dotsExchangeCreate: new LocalFailure("transport", "Unconfirmed response"), dotsExchangeRead: new LocalFailure("not_found", "No authoritative record") })
    await run("session_dots_exchange_create", { sessionID: "ses_1", input: value })
    expect((await run("session_dots_exchange_create", { sessionID: "ses_1", input: { ...value, text: "Changed" } })).isError).toBe(true)
    expect((await run("session_dots_exchange_create", { sessionID: "ses_1", input: value })).isError).toBe(true)
    expect(calls.filter((call) => call.method === "dotsExchangeCreate")).toHaveLength(1)
  })

  test("session_prompt passes the client id unchanged and reports an unconfirmed outcome without replay", async () => {
    const { run, calls, results } = await fixture({ prompt: { id: "msg_one" } })
    const sent = await run("session_prompt", { sessionID: "ses_1", input: { id: "msg_one", text: "hi" } })
    expect(sent.structuredContent).toEqual({ data: { id: "msg_one" } })
    expect(calls.find((call) => call.method === "prompt")?.args).toEqual([
      "ses_1",
      { directory: "/work" },
      { id: "msg_one", text: "hi", remoteSource: context },
    ])
    results.prompt = new LocalFailure("transport", "no response")
    const unknown = await run("session_prompt", { sessionID: "ses_1", input: { id: "msg_two", text: "hi" } })
    expect(unknown.isError).toBe(true)
    expect(unknown.structuredContent).toEqual({ error: { code: "outcome_unknown", message: expect.any(String) } })
    expect(unknown.content[0]!.text).toContain("Inspect the Session's current state")
    expect(calls.filter((call) => call.method === "prompt")).toHaveLength(2)
  })

  test("usage_forecast ties the Location scope to sessionID", async () => {
    const { run, calls } = await fixture({ usageForecast: { data: { ok: true } } })
    expect((await run("usage_forecast", { input: { localScope: "backend" } })).structuredContent).toEqual({
      data: { ok: true },
    })
    expect(
      (await run("usage_forecast", { sessionID: "ses_1", input: { localScope: "location" } })).isError,
    ).toBeUndefined()
    expect((await run("usage_forecast", { input: { localScope: "location" } })).isError).toBe(true)
    expect((await run("usage_forecast", { sessionID: "ses_1", input: { localScope: "backend" } })).isError).toBe(true)
    expect(calls.filter((call) => call.method === "usageForecast").map((call) => call.args)).toEqual([
      ["backend"],
      ["location", { directory: "/work" }],
    ])
  })

  test("incident guidance keeps its optional Session and resolves its Location through the connector", async () => {
    const { run, calls } = await fixture({ incidentGuidance: { guidance: null } })
    await run("incident_guidance", { input: { provider: "p", model: "m" } })
    await run("incident_guidance", { sessionID: "ses_1", input: { provider: "p", model: "m" } })
    expect(calls.filter((call) => call.method === "incidentGuidance").map((call) => call.args)).toEqual([
      [{ provider: "p", model: "m" }],
      [{ provider: "p", model: "m" }, { directory: "/work" }],
    ])
  })

  test("create tools require the client id and keep the existing workspace rule", async () => {
    const { run, calls } = await fixture({ projectList: [], projectDirectories: [] })
    const result = await run("session_create", { input: { id: "ses_new", workspace: "wsp_missing" } })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: "invalid_message" } })
    expect(calls.some((call) => call.method === "createSession")).toBe(false)
  })
})

describe("routing descriptors", () => {
  const tool = (name: string) => RemoteMcpSchemas.tools.find((item) => item.name === name)!
  test.each([
    ["session_prompt", { sessionID: "ses_1", input: {} }, "session:ses_1"],
    ["session_get", { sessionID: "ses_1" }, undefined],
    ["session_create", { input: { id: "ses_new", workspace: "w" } }, "session:ses_new"],
    ["session_create_in_directory", { input: { id: "ses_dir", directory: "/x" } }, "session:ses_dir"],
    ["session_side_chat_create", { sessionID: "ses_1", input: { id: "ses_side" } }, "session:ses_1"],
    ["provider_auth_key", { input: { target: { sessionID: "ses_9" } } }, "session:ses_9"],
    ["provider_auth_key", { input: { target: { workspace: "wsp_1" } } }, "backend"],
    ["incident_guidance_clear", { sessionID: "ses_1", input: {} }, "session:ses_1"],
    ["incident_guidance_clear", { input: {} }, "backend"],
    ["machine_keep_awake_set", { input: { enabled: true } }, "backend"],
    ["machine_keep_awake_get", {}, undefined],
    ["session_interrupt", { sessionID: "ses_1" }, "session:ses_1"],
  ])("%s -> %p lane %p", (name, args, lane) => {
    expect(RemoteMcpSchemas.laneOf(tool(name), args)).toBe(lane)
  })
})

describe("result conversion", () => {
  test("names the machine update for an operation an older connector does not know", () => {
    const result = toolResult([
      {
        type: "response",
        id: "r",
        ok: false,
        error: { code: "unknown_operation", message: "Operation is not proxied by this agent" },
      },
    ])
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("Update YCoding on this machine")
  })

  test("reassembles a chunked response completely", () => {
    const value = { data: "x".repeat(RemoteLimits.maxAgentMessageChars + 5_000) }
    const frames = successFrames("r", value)
    expect(frames.length).toBeGreaterThan(1)
    const result = toolResult(frames, 10_000_000)
    expect(result.structuredContent).toEqual(value)
    expect(JSON.parse(result.content[0]!.text)).toEqual(value)
  })

  test("fails explicitly past the result bound and for incomplete chunk sequences", () => {
    const frames = successFrames("r", { data: "x".repeat(RemoteLimits.maxAgentMessageChars + 5_000) })
    expect(toolResult(frames, 1_000).structuredContent).toEqual({
      error: { code: "message_too_large", message: expect.any(String) },
    })
    expect(toolResult(frames.slice(0, 1), 10_000_000).structuredContent).toEqual({
      error: { code: "internal_error", message: expect.any(String) },
    })
    expect(toolResult(successFrames("r", { data: "y".repeat(2_000) }), 1_000).structuredContent).toEqual({
      error: { code: "message_too_large", message: expect.any(String) },
    })
  })
})

describe("mutation ordering", () => {
  test("a missing baseline model does not prove that an uncertain explicit profile binding completed", async () => {
    const target = { providerID: "synthetic", id: "model-next", profile: "synthetic-account" }
    const selected: { model?: typeof target } = {}
    const { run, calls, holds } = await fixture({
      getSession: async (sessionID: string) => ({ ...sessionInfo(sessionID), model: selected.model }),
      switchModel: async () => {
        selected.model = target
        throw new LocalFailure("transport", "The profile binding response was lost")
      },
      interrupt: async () => {},
    })
    expect((await run("session_switch_model", { sessionID: "ses_1", input: { model: target } })).isError).toBe(true)
    expect((await run("session_interrupt", { sessionID: "ses_1" })).structuredContent).toMatchObject({
      error: { code: "outcome_unknown" },
    })
    expect(calls.filter((call) => call.method === "interrupt")).toEqual([])
    expect(holds).toEqual([true])
  })

  test("a verification failure before dispatch does not hold a mutation lane", async () => {
    const state = { unavailable: false }
    const { run, calls, holds } = await fixture({
      getSession: async (sessionID: string) => {
        if (state.unavailable) throw new LocalFailure("transport", "The verification read failed")
        return sessionInfo(sessionID)
      },
      interrupt: async () => {},
    })
    state.unavailable = true
    expect((await run("session_interrupt", { sessionID: "ses_1" })).structuredContent).toMatchObject({
      error: { code: "internal_error" },
    })
    expect(calls.filter((call) => call.method === "interrupt")).toEqual([])
    expect(holds).toEqual([])
    state.unavailable = false
    expect((await run("session_interrupt", { sessionID: "ses_1" })).isError).toBeUndefined()
    expect(calls.filter((call) => call.method === "interrupt")).toHaveLength(1)
  })

  test("an uncertain mutation blocks its lane while reads and other Sessions remain usable", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const { tool, run, calls } = await fixture({
      prompt: async (sessionID: string) => {
        if (sessionID !== "ses_1") return { id: "msg_other" }
        started.resolve()
        await release.promise
        throw new LocalFailure("transport", "Local deadline expired")
      },
      interrupt: async () => {},
    })
    const first = tool("session_prompt", { sessionID: "ses_1", input: { id: "msg_unknown", text: "Synthetic input" } })
    await started.promise
    const next = tool("session_interrupt", { sessionID: "ses_1" })
    release.resolve()
    expect((await (await first).json()).result.isError).toBe(true)
    const queued = await (await next).json()
    expect(queued.result.isError).toBe(true)
    expect(queued.result.content[0].text).toContain("Inspect")
    expect((await run("session_interrupt", { sessionID: "ses_1" })).isError).toBe(true)
    expect(calls.filter((call) => call.method === "interrupt")).toEqual([])
    expect((await run("session_get", { sessionID: "ses_1" })).isError).toBeUndefined()
    expect(
      (await run("session_prompt", { sessionID: "ses_2", input: { id: "msg_other", text: "Other Session" } })).isError,
    ).toBeUndefined()
  })

  test("holds a Session's mutation lane through settlement while other Sessions and reads proceed", async () => {
    const order: string[] = []
    const firstStarted = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<{ id: string }>()
    const { tool, run } = await fixture({
      prompt: (sessionID: string, _location: unknown, input: { id: string }) => {
        order.push(`prompt:${sessionID}:${input.id}`)
        if (input.id === "msg_slow") {
          firstStarted.resolve()
          return releaseFirst.promise
        }
        return { id: input.id }
      },
      interrupt: (sessionID: string) => {
        order.push(`interrupt:${sessionID}`)
      },
    })
    const slow = tool("session_prompt", { sessionID: "ses_1", input: { id: "msg_slow", text: "a" } })
    await firstStarted.promise
    const interrupt = tool("session_interrupt", { sessionID: "ses_1" })
    expect(
      (await run("session_prompt", { sessionID: "ses_2", input: { id: "msg_other", text: "b" } })).isError,
    ).toBeUndefined()
    expect((await run("session_get", { sessionID: "ses_1" })).isError).toBeUndefined()
    expect(order).toEqual(["prompt:ses_1:msg_slow", "prompt:ses_2:msg_other"])
    releaseFirst.resolve({ id: "msg_slow" })
    expect((await (await slow).json()) as unknown).toBeDefined()
    expect((await interrupt).status).toBe(200)
    expect(order).toEqual(["prompt:ses_1:msg_slow", "prompt:ses_2:msg_other", "interrupt:ses_1"])
  })

  test("orders same-Session mutations by arrival even when the first body is delayed", async () => {
    const order: string[] = []
    const { request } = await fixture({
      prompt: (_sessionID: string, _location: unknown, input: { id: string }) => {
        order.push(input.id)
        return { id: input.id }
      },
    })
    const body = (id: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "session_prompt", arguments: { sessionID: "ses_1", input: { id, text: "t" } }, _meta: meta },
      })
    const delayed = new TransformStream<Uint8Array>()
    const writer = delayed.writable.getWriter()
    const first = request("tools/call", {}, { name: "session_prompt", body: delayed.readable })
    const second = request("tools/call", {}, { name: "session_prompt", body: body("msg_b") })
    await Bun.sleep(10)
    expect(order).toEqual([])
    await writer.write(new TextEncoder().encode(body("msg_a")))
    await writer.close()
    await Promise.all([first, second])
    expect(order).toEqual(["msg_a", "msg_b"])
  })

  test("an aborted queued request is never dispatched and does not break the lane", async () => {
    const order: string[] = []
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<{ id: string }>()
    const { tool } = await fixture({
      prompt: (_sessionID: string, _location: unknown, input: { id: string }) => {
        order.push(input.id)
        if (input.id === "msg_a") {
          started.resolve()
          return release.promise
        }
        return { id: input.id }
      },
    })
    const args = (id: string) => ({ sessionID: "ses_1", input: { id, text: "t" } })
    const first = tool("session_prompt", args("msg_a"))
    await started.promise
    const controller = new AbortController()
    const queued = tool("session_prompt", args("msg_b"), controller.signal).catch(() => undefined)
    const third = tool("session_prompt", args("msg_c"))
    controller.abort()
    await queued
    release.resolve({ id: "msg_a" })
    await first
    expect((await third).status).toBe(200)
    expect(order).toEqual(["msg_a", "msg_c"])
  })
})

describe("unknown outcome holds", () => {
  type Result = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["run"]>>
  const target = { providerID: "test", id: "next", variant: "high" }
  const unknown = () => {
    throw new LocalFailure("transport", "Local deadline expired")
  }
  const sessionsWith = (model: Record<string, string>) => [
    { ...sessionInfo("ses_1"), model } as unknown as SessionInfo,
    sessionInfo("ses_2"),
  ]
  const select = (sessions: SessionInfo[], model: Record<string, string>) => {
    sessions[0] = { ...sessions[0], model } as unknown as SessionInfo
  }
  const count = (calls: Call[], method: string) => calls.filter((call) => call.method === method).length
  const codeOf = (result: Result) => (result.structuredContent as { error?: { code: string } } | null)?.error?.code
  const switchTo = (model: Record<string, string>) => ({ sessionID: "ses_1", input: { model } })
  const promptWith = (id: string) => ({ sessionID: "ses_1", input: { id, text: "Synthetic input" } })

  test("a fresh read showing the requested model after a late switch settles the hold and later mutations dispatch", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const { run, calls, holds } = await fixture({ switchModel: unknown, prompt: { id: "msg_after" } }, sessions)
    expect(codeOf(await run("session_switch_model", switchTo(target)))).toBe("outcome_unknown")
    expect(holds).toEqual([true])
    select(sessions, target)
    expect((await run("session_prompt", promptWith("msg_after"))).isError).toBeUndefined()
    expect(count(calls, "prompt")).toBe(1)
    expect(count(calls, "switchModel")).toBe(1)
    expect(holds).toEqual([true, false])
  })

  test("repeating the held switch answers only from a fresh read and never dispatches it again", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const { run, calls, holds } = await fixture({ switchModel: unknown }, sessions)
    await run("session_switch_model", switchTo(target))
    const unconfirmed = await run("session_switch_model", switchTo(target))
    expect(codeOf(unconfirmed)).toBe("outcome_unknown")
    expect(unconfirmed.content[0]!.text).toContain("not executed")
    select(sessions, target)
    const confirmed = await run("session_switch_model", switchTo(target))
    expect(confirmed.isError).toBeUndefined()
    expect(confirmed.content[0]!.text).toBe("null")
    expect(count(calls, "switchModel")).toBe(1)
    expect(holds).toEqual([true, false])
  })

  test.each([
    ["variant absent", { providerID: "test", id: "next", profile: "work" }],
    ["variant differs", { providerID: "test", id: "next", variant: "low", profile: "work" }],
    ["profile absent", { providerID: "test", id: "next", variant: "high" }],
    ["profile differs", { providerID: "test", id: "next", variant: "high", profile: "home" }],
    ["model differs", { providerID: "test", id: "other", variant: "high", profile: "work" }],
    ["provider differs", { providerID: "other", id: "next", variant: "high", profile: "work" }],
  ])("a selected model that is not exactly the target (%s) keeps the Session held", async (_name, selected) => {
    const requested = { providerID: "test", id: "next", variant: "high", profile: "work" }
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const { run, calls, holds } = await fixture({ switchModel: unknown, prompt: { id: "msg_after" } }, sessions)
    await run("session_switch_model", switchTo(requested))
    select(sessions, selected)
    const refused = await run("session_prompt", promptWith("msg_after"))
    expect(codeOf(refused)).toBe("outcome_unknown")
    expect(refused.content[0]!.text).toContain("not executed")
    expect(codeOf(await run("session_switch_model", switchTo(requested)))).toBe("outcome_unknown")
    expect(count(calls, "prompt")).toBe(0)
    expect(count(calls, "switchModel")).toBe(1)
    expect(holds).toEqual([true])
  })

  test("an explicit profile already selected before the switch is a rebind that no later read confirms", async () => {
    const requested = { providerID: "test", id: "next", profile: "work" }
    const sessions = sessionsWith(requested)
    const { run, calls, holds } = await fixture({ switchModel: unknown, prompt: { id: "msg_after" } }, sessions)
    expect(codeOf(await run("session_switch_model", switchTo(requested)))).toBe("outcome_unknown")
    expect(codeOf(await run("session_switch_model", switchTo(requested)))).toBe("outcome_unknown")
    expect(codeOf(await run("session_prompt", promptWith("msg_after")))).toBe("outcome_unknown")
    expect(count(calls, "switchModel")).toBe(1)
    expect(count(calls, "prompt")).toBe(0)
    expect(holds).toEqual([true])
  })

  test("a switch whose Session cannot be read is refused before dispatch and does not hold the Session", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const gate = { unreadable: false }
    const { run, calls, holds } = await fixture(
      {
        getSession: (sessionID: string) => {
          if (gate.unreadable) {
            gate.unreadable = false
            throw new LocalFailure("transport", "Local server unreachable")
          }
          return sessions.find((info) => info.id === sessionID)
        },
        switchModel: undefined,
        prompt: { id: "msg_after" },
      },
      sessions,
    )
    gate.unreadable = true
    const refused = await run("session_switch_model", switchTo(target))
    expect(refused.isError).toBe(true)
    expect(codeOf(refused)).toBe("internal_error")
    expect(count(calls, "switchModel")).toBe(0)
    expect((await run("session_prompt", promptWith("msg_after"))).isError).toBeUndefined()
    expect(holds).toEqual([])
  })

  test("only a retry with the held prompt's own ID passes the hold, and its admission settles the hold", async () => {
    const attempts: string[] = []
    const { run, calls, holds } = await fixture({
      prompt: (_sessionID: string, _location: unknown, input: { id: string }) => {
        attempts.push(input.id)
        if (attempts.length === 1) throw new LocalFailure("transport", "Local deadline expired")
        return { id: input.id }
      },
      interrupt: undefined,
    })
    expect(codeOf(await run("session_prompt", promptWith("msg_held")))).toBe("outcome_unknown")
    const other = await run("session_prompt", promptWith("msg_other"))
    expect(codeOf(other)).toBe("outcome_unknown")
    expect(other.content[0]!.text).toContain("msg_held")
    expect(codeOf(await run("session_interrupt", { sessionID: "ses_1" }))).toBe("outcome_unknown")
    expect((await run("session_prompt", promptWith("msg_held"))).isError).toBeUndefined()
    expect(attempts).toEqual(["msg_held", "msg_held"])
    expect((await run("session_interrupt", { sessionID: "ses_1" })).isError).toBeUndefined()
    expect(count(calls, "interrupt")).toBe(1)
    expect(holds).toEqual([true, false])
  })

  test("a held prompt retry that fails or stays unknown keeps the Session held", async () => {
    const failures = [
      new LocalFailure("transport", "Local deadline expired"),
      new LocalFailure("invalid", "Rejected"),
      new LocalFailure("transport", "Local deadline expired"),
    ]
    const attempts: string[] = []
    const { run, holds } = await fixture({
      prompt: (_sessionID: string, _location: unknown, input: { id: string }) => {
        attempts.push(input.id)
        const failure = failures.shift()
        if (failure !== undefined) throw failure
        return { id: input.id }
      },
    })
    expect(codeOf(await run("session_prompt", promptWith("msg_held")))).toBe("outcome_unknown")
    expect(codeOf(await run("session_prompt", promptWith("msg_held")))).toBe("invalid_message")
    expect(codeOf(await run("session_prompt", promptWith("msg_held")))).toBe("outcome_unknown")
    expect(codeOf(await run("session_prompt", promptWith("msg_other")))).toBe("outcome_unknown")
    expect(attempts).toEqual(["msg_held", "msg_held", "msg_held"])
    expect(holds).toEqual([true])
  })

  test("an unknown interrupt holds every other mutation of its Session, including any prompt ID, while reads and other Sessions continue", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const { run, calls, holds } = await fixture(
      {
        interrupt: (sessionID: string) => {
          if (sessionID === "ses_1") unknown()
        },
        prompt: { id: "msg_any" },
        switchModel: undefined,
      },
      sessions,
    )
    expect(codeOf(await run("session_interrupt", { sessionID: "ses_1" }))).toBe("outcome_unknown")
    select(sessions, target)
    expect(codeOf(await run("session_interrupt", { sessionID: "ses_1" }))).toBe("outcome_unknown")
    expect(codeOf(await run("session_prompt", promptWith("msg_any")))).toBe("outcome_unknown")
    expect(codeOf(await run("session_switch_model", switchTo(target)))).toBe("outcome_unknown")
    expect(count(calls, "interrupt")).toBe(1)
    expect(count(calls, "prompt")).toBe(0)
    expect(count(calls, "switchModel")).toBe(0)
    expect((await run("session_get", { sessionID: "ses_1" })).isError).toBeUndefined()
    expect((await run("session_interrupt", { sessionID: "ses_2" })).isError).toBeUndefined()
    expect(holds).toEqual([true])
  })

  test("a mutation queued behind an unknown switch runs only after a fresh read confirms the requested model", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const { tool, calls } = await fixture(
      {
        switchModel: async (_sessionID: string, _location: unknown, model: Record<string, string>) => {
          started.resolve()
          await release.promise
          select(sessions, model)
          unknown()
        },
        prompt: { id: "msg_queued" },
      },
      sessions,
    )
    const first = tool("session_switch_model", switchTo(target))
    await started.promise
    const queued = tool("session_prompt", promptWith("msg_queued"))
    release.resolve()
    expect(((await (await first).json()) as { result: Result }).result.structuredContent).toMatchObject({
      error: { code: "outcome_unknown" },
    })
    expect(((await (await queued).json()) as { result: Result }).result.isError).toBeUndefined()
    expect(count(calls, "prompt")).toBe(1)
  })

  test("revoked authorization refuses a queued mutation of a held Session before any confirmation read", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const started = Promise.withResolvers<void>()
    const admitted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const { tool, calls, state } = await fixture(
      {
        switchModel: async (_sessionID: string, _location: unknown, model: Record<string, string>) => {
          started.resolve()
          await release.promise
          select(sessions, model)
          unknown()
        },
        prompt: { id: "msg_queued" },
      },
      sessions,
    )
    const first = tool("session_switch_model", switchTo(target))
    await started.promise
    state.onAdmission = () => admitted.resolve()
    const queued = tool("session_prompt", promptWith("msg_queued"))
    await admitted.promise
    expect(state.allowed).toBe(true)
    expect(count(calls, "prompt")).toBe(0)
    state.allowed = false
    const mark = calls.length
    release.resolve()
    await first
    const response = await queued
    expect(response.status).toBe(200)
    expect(((await response.json()) as { result: Result }).result.structuredContent).toMatchObject({
      error: { code: "agent_unavailable" },
    })
    expect(calls.slice(mark).map((call) => call.method)).toEqual([])
  })

  test("the confirmation read bypasses the Session verification window", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const { run, holds } = await fixture({ switchModel: unknown, prompt: { id: "msg_after" } }, sessions, {
      verifyWindowMs: 3_600_000,
    })
    expect((await run("session_get", { sessionID: "ses_1" })).isError).toBeUndefined()
    await run("session_switch_model", switchTo(target))
    select(sessions, target)
    expect((await run("session_prompt", promptWith("msg_after"))).isError).toBeUndefined()
    expect(holds).toEqual([true, false])
  })

  test("a restarted endpoint starts without holds and never replays the earlier call", async () => {
    const sessions = sessionsWith({ providerID: "test", id: "model" })
    const { run, calls, holds, restart } = await fixture(
      { switchModel: unknown, prompt: { id: "msg_after" } },
      sessions,
    )
    await run("session_switch_model", switchTo(target))
    await restart()
    expect(holds).toEqual([true, false])
    expect((await run("session_prompt", promptWith("msg_after"))).isError).toBeUndefined()
    expect(count(calls, "switchModel")).toBe(1)
  })
})

describe("authorization gate and request shape", () => {
  test("refuses with 503 and no local call when the epoch is not allowed or the endpoint is closed", async () => {
    const { tool, state, calls, mcp } = await fixture()
    state.allowed = false
    expect((await tool("session_get", { sessionID: "ses_1" })).status).toBe(503)
    state.allowed = true
    await mcp.close()
    expect((await tool("session_get", { sessionID: "ses_1" })).status).toBe(503)
    expect(calls).toEqual([])
  })

  test("rechecks authorization when a queued mutation reaches dispatch", async () => {
    const started = Promise.withResolvers<void>()
    const admitted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<{ id: string }>()
    const { tool, state, calls } = await fixture({
      prompt: (_sessionID: string, _location: unknown, input: { id: string }) => {
        if (input.id === "msg_a") {
          started.resolve()
          return release.promise
        }
        return { id: input.id }
      },
    })
    const args = (id: string) => ({ sessionID: "ses_1", input: { id, text: "t" } })
    const first = tool("session_prompt", args("msg_a"))
    await started.promise
    state.onAdmission = () => admitted.resolve()
    const second = tool("session_prompt", args("msg_b"))
    await admitted.promise
    expect(state.allowed).toBe(true)
    expect(calls.filter((call) => call.method === "prompt")).toHaveLength(1)
    state.allowed = false
    release.resolve({ id: "msg_a" })
    await first
    const response = await second
    expect(response.status).toBe(200)
    const refused = ((await response.json()) as { result: { isError: boolean; structuredContent: unknown } })
      .result
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({ error: { code: "agent_unavailable" } })
    expect(calls.filter((call) => call.method === "prompt")).toHaveLength(1)
  })

  test("revocation while reading the body refuses admission with 503 and no local call", async () => {
    const reading = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const { request, state, calls, observations } = await fixture()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        reading.resolve()
        await release.promise
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session_prompt", arguments: { sessionID: "ses_1", input: { id: "msg_before_admission", text: "t" } }, _meta: meta } })))
        controller.close()
      },
    }, { highWaterMark: 0 })
    const pending = request("tools/call", {}, { name: "session_prompt", body })
    await reading.promise
    state.allowed = false
    release.resolve()
    const response = await pending
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "unavailable" })
    expect(observations).toEqual([])
    expect(calls).toEqual([])
  })

  test("serves only POST at the fixed resource, with bounded bodies and no caching", async () => {
    const { request, tool } = await fixture()
    expect((await request("tools/list", {}, { verb: "GET", body: undefined })).status).toBe(405)
    expect((await request("tools/list", {}, { url: "https://relay.example.com/api/mcp/devices/other" })).status).toBe(
      404,
    )
    expect((await request("tools/list", {}, { url: `${resource}?x=1` })).status).toBe(404)
    expect((await request("tools/call", {}, { name: "session_get", body: "x".repeat(200_000) })).status).toBe(413)
    expect((await tool("session_get", { sessionID: "ses_1" })).headers.get("cache-control")).toBe("no-store")
  })
})
