import { fileURLToPath } from "node:url"
const { Schema } = await import(
  Bun.resolveSync("effect", fileURLToPath(new URL("../../../../../packages/schema/", import.meta.url)))
)
import type { DescEnum, DescField, DescMessage } from "@bufbuild/protobuf"
const { create } = await import(
  Bun.resolveSync("@bufbuild/protobuf", fileURLToPath(new URL("../../../../../packages/protocol/", import.meta.url)))
)
import { SessionEvent } from "../../../../../packages/schema/src/session-event.ts"
import {
  encodeLossless,
  encodeStrict,
  schemas,
  SessionLogItemSchema,
} from "../../../../../packages/protocol/src/v5/index.ts"

const sessionID = "ses_wire_events"
const messageID = "msg_wire_events"
const lossless = "\ud800😀\udfff"
const opaque = { "": null, "\ud800": { text: lossless, empty: [], zero: 0, no: false } }
const model = { providerID: "openai", id: "fixture" }
const tokens = { input: 0, output: 1, reasoning: 2, cache: { read: 3, write: 4 } }
const error = { type: "fixture.error", message: lossless }
const artifact = {
  scopeID: "pas_fixture",
  versionID: "pav_fixture",
  kind: "skill",
  id: "fixture",
  sourceScope: "project",
}
const shell = {
  id: "sh_fixture",
  status: "running",
  command: lossless,
  cwd: "/project",
  shell: "/bin/sh",
  file: "/project/output",
  metadata: {},
  time: { started: 0 },
}
const base = { sessionID }
const assistant = { ...base, assistantMessageID: messageID }
const tool = { ...assistant, callID: lossless }
const text = { ...assistant, ordinal: 0 }
const job = { ...base, jobID: "cmp_fixture" }
const definitions = SessionEvent.PublicDurableDefinitions
const variants = [
  "created",
  "agent.selected",
  "model.selected",
  "daybreak.set",
  "project-artifacts-ended",
  "moved",
  "renamed",
  "deleted",
  "archived",
  "unarchived",
  "pinned",
  "unpinned",
  "forked",
  "input.promoted",
  "input.admitted",
  "input.consumed",
  "execution.started",
  "execution.succeeded",
  "execution.failed",
  "execution.interrupted",
  "work.completed",
  "instructions.updated",
  "context.observed",
  "task.updated",
  "synthetic",
  "skill.activated",
  "skill.deactivated",
  "shell.started",
  "shell.ended",
  "step.started",
  "step.ended",
  "step.failed",
  "text.started",
  "text.ended",
  "reasoning.started",
  "reasoning.ended",
  "tool.input.started",
  "tool.input.ended",
  "tool.called",
  undefined,
  "tool.success",
  "tool.failed",
  "file-change.recorded",
  "retry.scheduled",
  "compaction.admitted",
  "compaction.started",
  "compaction.ended",
  "compaction.failed",
  "revert.staged",
  "revert.cleared",
  "revert.committed",
  undefined,
  "guardrail.dismissed",
  "guardrail.escalated",
  "guardrail.decided",
  "review.deferred",
  "review.decided",
  "review.withdrawn",
  "review.consumed",
  "step.rerouted",
  "decision.audited",
  "permission.assessed",
  "dots.exchange.created",
  "dots.instruction.rejected",
  "dots.report.recorded",
  "tool.invocation-settled",
  "dots.access.changed",
  "dots.binding.bound",
  "dots.binding.unbound",
  "dots.device-delegation.created",
  "dots.device-delegation.revoked",
  "dots.decision.settled",
  "input.withdrawn",
  "input.steered",
]
const itemID = "rvw_fixture"
const fingerprint = "a".repeat(64)
const source = { messageID, callID: lossless }
const grades = [
  { choice: "approve_all", confidence: 0, evidence: lossless },
  { choice: "escalate", confidence: 1, evidence: "fixture" },
]
const permissionPayload = {
  type: "permission",
  action: "read",
  resources: [lossless],
  fingerprint,
  fingerprintVersion: 2,
  requestID: "per_fixture",
}
const minimal: (Record<string, unknown> | undefined)[] = [
  { ...base, projectID: "prj_fixture", scope: "bound", location: { directory: "/project" }, title: lossless, created: 0 },
  { ...base, agent: "build" },
  { ...base, model },
  { ...base },
  { ...base, oldProjectID: "prj_old", newProjectID: "prj_new" },
  { ...base, location: { directory: "/project" } },
  { ...base, title: lossless },
  { ...base },
  { ...base },
  { ...base },
  { ...base },
  { ...base },
  { ...base, parentID: "ses_parent", parentSeq: -1 },
  { ...base, inputID: messageID },
  { ...base, inputID: messageID, input: { type: "user", data: { text: lossless }, delivery: "steer" } },
  { ...base, inputIDs: [messageID] },
  { ...base },
  { ...base },
  { ...base, error },
  { ...base, reason: "user" },
  { ...assistant, inputID: messageID },
  { ...base, delta: { "core/a": "a".repeat(64), "core/b": "removed" } },
  { ...base, source: "session-state", text: lossless },
  { ...base, change: { type: "started" } },
  { ...base, text: lossless },
  { ...base, id: lossless, name: lossless, text: lossless },
  { ...base, id: lossless, activationMessageID: messageID, reason: "conflict_resolved" },
  { ...base, shell },
  { ...base, shell, output: { output: lossless, cursor: 0, size: 0, truncated: false } },
  { ...assistant, agent: "build", model },
  { ...assistant, finish: "stop", cost: 0, tokens },
  { ...assistant, error },
  { ...text },
  { ...text, text: lossless },
  { ...text },
  { ...text, text: lossless },
  { ...tool, name: lossless },
  { ...tool, text: lossless },
  { ...tool, input: {}, executed: false },
  undefined,
  { ...tool, structured: {}, content: [], executed: false },
  { ...tool, error, executed: false },
  { ...base, change: { path: "file.ts", patch: lossless, additions: 0, deletions: 0 } },
  { ...assistant, attempt: 1, at: 0, error },
  { ...job },
  { ...job },
  {
    ...job,
    revision: 0,
    boundary: { messageID, seq: 0 },
    metrics: { excludedMessages: 0, excludedParts: 0, inputTokens: 0, retainedTokens: 0 },
  },
  { ...job, code: "cancelled", error },
  { ...base, revert: { messageID } },
  { ...base },
  { ...base, to: messageID },
  undefined,
  { ...base, reviewSessionID: "ses_review", ruleID: "standard.review.fixture", confidence: 0.9 },
  { ...base, requestID: "grq_fixture" },
  { ...base, reviewSessionID: "ses_review", requestID: "grq_fixture", reply: "once" },
  {
    ...base,
    itemID,
    kind: "permission",
    reason: "disabled",
    origin: { requestID: "per_fixture" },
    payload: permissionPayload,
  },
  { ...base, itemID, decision: { kind: "permission", reply: "once" } },
  { ...base, itemID, reason: "reverted" },
  { ...base, itemID },
  { ...assistant, model, error },
  { ...base, purpose: "advisory", agent: "decision", outcome: "succeeded", fingerprint, attempts: 0 },
  { ...base, requestID: "per_fixture", outcome: "allow", via: "auto-permission" },
]
const extra: Record<number, Record<string, unknown>> = {
  1: {
    parentID: "ses_parent",
    agent: "build",
    model: { ...model, variant: "high", profile: "fixture" },
    permissionCeiling: [],
    subpath: "src",
    origin: "dots-executor",
  },
  2: { artifact },
  3: { model: { ...model, variant: lossless, profile: "fixture" } },
  4: { daybreak: "daybreak_blue" },
  6: { location: { directory: "/project", workspaceID: "wrk_fixture" }, projectID: "prj_fixture", subpath: "src" },
  13: { parentSeq: 9007199254740991, from: messageID },
  15: {
    input: { type: "user", delivery: "queue", data: { text: "", files: [], agents: [], metadata: opaque } },
    causedBy: { sessionID: `ses_${lossless}`, inputID: messageID },
  },
  25: { description: "", metadata: opaque },
  26: { conflicts: { skills: [], instructions: [] }, artifact },
  28: {
    shell: {
      ...shell,
      status: "exited",
      pid: 0,
      exit: 0,
      metadata: opaque,
      toolCallID: "call_fixture",
      time: { started: 0, completed: 1 },
    },
  },
  29: {
    shell: {
      ...shell,
      status: "memory-limit",
      pid: 1,
      exit: -1,
      metadata: opaque,
      toolCallID: "call_fixture",
      time: { started: 0, completed: 1 },
    },
    output: { output: "", cursor: 2, size: 2, truncated: true },
  },
  30: { model: { ...model, variant: "high", profile: "fixture" }, snapshot: "snap_fixture" },
  31: {
    contextLimit: 0,
    contextBreakdown: { system: 0, tools: 1, user: 2, assistant: 3, reasoning: 4, toolCalls: 5, other: 6 },
    providerCache: { mechanism: "none", readReported: false, writeReported: true },
    snapshot: "snap_fixture",
    files: [],
  },
  32: {
    cost: 0,
    tokens,
    contextLimit: 0,
    contextBreakdown: { system: 6, tools: 5, user: 4, assistant: 3, reasoning: 2, toolCalls: 1, other: 0 },
    providerCache: { mechanism: "anthropic-cache-control", readReported: true, writeReported: false },
    snapshot: "snap_fixture",
    files: ["file.ts"],
  },
  33: { phase: "commentary" },
  34: { phase: "final_answer" },
  35: { state: opaque },
  36: { state: {} },
  39: { input: opaque, executed: true, state: opaque },
  41: { structured: opaque, content: [{ type: "text", text: "" }], result: null, executed: true, resultState: opaque },
  42: { result: { lossless, zero: 0 }, executed: true, resultState: {} },
  45: {
    pressure: { estimatedInputTokens: 0, safeInputTokens: 0 },
    usageAnchor: { sessionID: `ses_${lossless}`, inputID: messageID },
  },
  49: { revert: { messageID, snapshot: "snap_fixture", files: [] } },
  53: { confidence: 1, source },
  54: { choice: "escalate", confidence: 0.5, grades, ruleIDs: [lossless, ""], source },
  55: { reply: "always", choice: "approve", grades, confidence: 0.95, ruleIDs: ["standard.review.fixture"], source },
  56: {
    choice: lossless,
    confidence: 0,
    grades,
    payload: { ...permissionPayload, resources: [], save: [lossless] },
  },
  57: { decision: { kind: "permission", reply: "reject" } },
  58: { reason: "task_closed" },
  60: { model: { ...model, variant: "high", profile: "fixture" } },
  61: {
    purpose: "permission",
    authority: "yolo",
    agent: "yolo-permission",
    model,
    route: "openai-responses",
    outcome: "failed",
    reason: "timeout",
    invocationKey: "sha256:0123456789abcdef",
    attempts: 3,
    answers: [
      { name: "sha256:0123456789abcdef", type: "choice", confidence: 0.9, choice: "sha256:fedcba9876543210" },
      { name: "sha256:1111111111111111", type: "choice", confidence: 1, choice: false },
      { name: "sha256:2222222222222222", type: "predicate", confidence: 0, answer: false },
      { name: "sha256:3333333333333333", type: "score", confidence: 0.5, score: 2 },
      { name: "sha256:4444444444444444", type: "text", confidence: 0.8, length: 0 },
      { name: "sha256:5555555555555555", type: "refusal", confidence: 0 },
    ],
  },
  62: {
    outcome: "escalate",
    via: "yolo",
    reply: "once",
    authority: "yolo",
    reason: "conflicting_grades",
    choice: "allow",
    confidence: 0.85,
    grades: [
      { choice: "allow", confidence: 0.85, evidence: lossless },
      { choice: "deny", confidence: 0.8, evidence: "fixture" },
      { choice: "escalate", confidence: 0, evidence: "fixture" },
    ],
    source,
  },
}

function enumeration(schema: DescEnum, value: unknown) {
  if (typeof value !== "string") throw new Error(`${schema.typeName}: expected enum string`)
  const suffix = `_${value.toUpperCase().replace(/[.-]/g, "_")}`
  const found = schema.values.find((item) => item.name.endsWith(suffix))
  if (!found) throw new Error(`${schema.typeName}: ${value}`)
  return found.number
}

function field(field: DescField, value: unknown): unknown {
  if (field.fieldKind === "message") return wire(field.message, value)
  if (field.fieldKind === "enum") return enumeration(field.enum, value)
  if (field.scalar === 3 || field.scalar === 4) return BigInt(value as number)
  return value
}

function value(input: unknown): Record<string, unknown> {
  if (input === null) return { kind: { case: "null", value: {} } }
  if (typeof input === "boolean") return { kind: { case: "boolean", value: input } }
  if (typeof input === "number") return { kind: { case: "number", value: input } }
  if (typeof input === "string") return { kind: { case: "string", value: encodeLossless(input) } }
  if (Array.isArray(input)) return { kind: { case: "list", value: { items: input.map(value) } } }
  return {
    kind: {
      case: "object",
      value: {
        entries: Object.entries(input as object).map(([key, item]) => ({
          key: encodeLossless(key),
          value: value(item),
        })),
      },
    },
  }
}

function tagged(message: DescMessage, input: Record<string, unknown>, tag: string) {
  const discriminator = message.fields.find((field) => field.name === tag)
  if (discriminator?.fieldKind !== "enum") return true
  return (
    tag in input &&
    discriminator.enum.values.some((item) =>
      item.name.endsWith(`_${String(input[tag]).toUpperCase().replace(/[.-]/g, "_")}`),
    )
  )
}

function enumsAgree(message: DescMessage, input: Record<string, unknown>): boolean {
  return message.fields.every((item) => {
    if (!(item.name in input)) return true
    const held = input[item.name]
    if (item.fieldKind === "enum")
      return (
        typeof held === "string" &&
        item.enum.values.some((entry) => entry.name.endsWith(`_${held.toUpperCase().replace(/[.-]/g, "_")}`))
      )
    if (
      item.fieldKind === "message" &&
      item.message.oneofs.length === 0 &&
      item.message.typeName !== "ycoding.v5.Value" &&
      typeof held === "object" &&
      held !== null &&
      !Array.isArray(held)
    )
      return enumsAgree(item.message, held as Record<string, unknown>)
    return true
  })
}

function structural(candidate: DescField, input: unknown, entries: boolean): boolean {
  if (candidate.fieldKind === "scalar")
    return (
      (typeof input === "number" && candidate.scalar === 1) || (typeof input === "boolean" && candidate.scalar === 8)
    )
  if (candidate.fieldKind !== "message") return false
  const fields = candidate.message.fields
  if (fields.length === 1 && fields[0]!.name === "items") return Array.isArray(input)
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  if (fields.length === 1 && fields[0]!.name === "entries") return entries
  const names = new Set(fields.map((field) => field.name))
  const object = input as Record<string, unknown>
  return (
    Object.keys(object).every((key) => names.has(key)) &&
    tagged(candidate.message, object, "kind") &&
    enumsAgree(candidate.message, object)
  )
}

function wire(schema: DescMessage, input: unknown): unknown {
  if (schema.typeName === "ycoding.v5.LosslessString") return encodeLossless(input as string)
  if (schema.typeName === "ycoding.v5.Value") return value(input)
  if (schema.oneofs.length) {
    const selected = schema.fields.find((candidate) => {
      if (candidate.fieldKind === "enum") {
        return (
          typeof input === "string" &&
          candidate.enum.values.some((item) => item.name.endsWith(`_${input.toUpperCase()}`))
        )
      }
      if (candidate.fieldKind !== "message") return false
      if (candidate.message.typeName === "ycoding.v5.LosslessString")
        return typeof input === "string" && input !== "removed"
      const type = candidate.message.fields.find((field) => field.name === "type")
      if (type?.fieldKind !== "enum" || typeof input !== "object" || input === null || !("type" in input)) return false
      return type.enum.values.some((item) =>
        item.name.endsWith(`_${String(input.type).toUpperCase().replace(/[.-]/g, "_")}`),
      )
    })
    const fallback =
      selected ?? schema.fields.find((candidate) => structural(candidate, input, false)) ??
      schema.fields.find((candidate) => structural(candidate, input, true)) ??
      schema.fields.find(
        (candidate) =>
          candidate.fieldKind === "message" &&
          candidate.message.oneofs.length > 0 &&
          candidate.message.fields.some((inner) => structural(inner, input, false)),
      )
    if (!fallback) throw new Error(`${schema.typeName}: missing union branch`)
    return { kind: { case: fallback.localName, value: field(fallback, input) } }
  }
  if (schema.fields.length === 1 && schema.fields[0]!.name === "items") {
    const item = schema.fields[0]!
    if (item.fieldKind !== "list") throw new Error("items field")
    return {
      items: (input as unknown[]).map((value) =>
        item.listKind === "message"
          ? wire(item.message, value)
          : item.listKind === "enum"
            ? enumeration(item.enum, value)
            : value,
      ),
    }
  }
  if (schema.fields.length === 1 && schema.fields[0]!.name === "entries") {
    const item = schema.fields[0]!
    if (item.fieldKind !== "list" || item.listKind !== "message") throw new Error("entries field")
    const target = item.message.fields.find((field) => field.name === "value")!
    return {
      entries: Object.entries(input as object).map(([key, value]) => ({
        key: encodeLossless(key),
        value: field(target, value),
      })),
    }
  }
  const object = input as Record<string, unknown>
  return Object.fromEntries(
    schema.fields.flatMap((item) => {
      if (!(item.name in object)) return []
      return [[item.localName, field(item, object[item.name])]]
    }),
  )
}

const cases: { name: string; variant: number; event: Record<string, unknown>; hex: string; streamHex?: string }[] = []
function add(variant: number, suffix: string, data: Record<string, unknown>, enriched = false) {
  const type = `session.${variants[variant - 1]}`
  const definition = definitions.find((definition) => definition.type === type)
  if (!definition) throw new Error(`missing TS definition ${type}`)
  const event = {
    id: "evt_wire_fixture",
    created: 42,
    sourceEpoch: "source-epoch-test",
    type,
    durable: { aggregateID: sessionID, seq: enriched ? 9007199254740991 : 0, version: definition.durable.version },
    ...(enriched ? { metadata: opaque, location: { directory: "/project", workspaceID: "wrk_fixture" } } : {}),
    data,
  }
  Schema.decodeUnknownSync(SessionEvent.PublicDurable)(event)
  const schema = schemas.find((schema) => schema.typeName === `ycoding.v5.SessionLogItemValue${variant}`)!
  const encoded = create(SessionLogItemSchema, {
    kind: { case: `value${variant}`, value: create(schema, wire(schema, event)) },
  })
  cases.push({
    name: `${type}/${suffix}`,
    variant,
    event,
    hex: Buffer.from(encodeStrict(SessionLogItemSchema, encoded)).toString("hex"),
  })
}
for (const [index, data] of minimal.entries()) {
  if (data === undefined) {
    if (variants[index] !== undefined) throw new Error(`missing durable fixture ${index + 1}`)
    continue
  }
  add(index + 1, "absent", data)
  add(index + 1, "present", { ...data, ...extra[index + 1] }, true)
}
const changes = [
  {
    type: "launched",
    parentID: "ses_parent",
    parentAssistantMessageID: messageID,
    toolCallID: "call_fixture",
    inputID: messageID,
    description: lossless,
    agent: "build",
    model,
    promptDigest: "fixture",
    background: false,
    delivery: "queue",
    usageAnchor: { sessionID: `ses_${lossless}`, inputID: messageID },
  },
  { type: "backgrounded" },
  { type: "progressed", progress: { text: "", time: 0 } },
  { type: "question_asked", question: { id: "qst_fixture", text: "", time: 0, data: null } },
  { type: "question_answered", answer: { questionID: "qst_fixture", text: "", data: false } },
  { type: "cancel_requested" },
  { type: "cancelled" },
  { type: "completed" },
  { type: "completed", excerpt: "" },
  { type: "failed", error: "" },
  { type: "failed", error: lossless, excerpt: "" },
  { type: "lost" },
  { type: "lost", excerpt: lossless },
  { type: "question_asked", question: { id: "qst_fixture", text: lossless, time: 1, deferred: true } },
  { type: "question_timed_out", questionID: "qst_fixture" },
  { type: "resumed" },
]
changes.forEach((change, index) => add(24, `change-${index}`, { ...base, change }))
add(15, "synthetic", {
  ...base,
  inputID: messageID,
  input: { type: "synthetic", data: { text: "", description: "", metadata: opaque }, delivery: "queue" },
})
add(41, "result-value", { ...minimal[40], result: { text: lossless } })
add(42, "result-null", { ...minimal[41], result: null })
add(56, "permission-fingerprint-v1", {
  ...minimal[55],
  payload: { ...permissionPayload, fingerprintVersion: 1 },
})
add(1, "permission-rule", { ...minimal[0], permissionCeiling: [{ action: lossless, resource: "", effect: "deny" }] })
add(26, "conflicts", { ...minimal[25], conflicts: { skills: [lossless], instructions: ["core/a"] } })
add(49, "revert-files", {
  ...minimal[48],
  revert: {
    messageID,
    files: [
      {
        file: "file.ts",
        before: "before.ts",
        after: "after.ts",
        patch: lossless,
        additions: 0,
        deletions: 1,
        status: "modified",
      },
    ],
  },
})
for (const reason of ["shutdown", "superseded"]) add(20, reason, { ...base, reason })
const deferral = minimal[55]!
for (const reason of ["free_text", "refused", "low_confidence", "escalated", "error", "timeout", "sleep_entry", "restart"])
  add(56, `reason-${reason}`, { ...deferral, reason })
add(56, "form", {
  ...deferral,
  kind: "question",
  origin: { messageID, callID: lossless },
  payload: {
    type: "form",
    title: lossless,
    fields: [
      { key: "name", type: "string", title: lossless, required: true, minLength: 1, options: [{ value: "a", label: "A" }] },
      { key: "count", type: "integer", minimum: 0, maximum: 9, default: 1 },
      { key: "ok", type: "boolean", default: false },
      { key: "tags", type: "multiselect", options: [{ value: "x", label: lossless, description: "" }], minItems: 1 },
      { key: "ratio", type: "number", when: [{ key: "ok", op: "eq", value: true }] },
      { key: "site", type: "external", url: "https://example.invalid/fixture" },
    ],
    questionTool: true,
  },
})
add(56, "question", {
  ...deferral,
  kind: "question",
  origin: { messageID, callID: "" },
  payload: {
    type: "question",
    questions: [
      { question: lossless, header: "", options: [{ label: "One", description: lossless }], multiple: true, custom: false },
      { question: "", header: lossless, options: [] },
    ],
  },
})
add(56, "subagent-question", {
  ...deferral,
  kind: "subagent_question",
  origin: { questionID: "qst_fixture" },
  payload: { type: "subagent_question", text: lossless, data: opaque },
})
add(56, "subagent-question-plain", {
  ...deferral,
  kind: "subagent_question",
  origin: { questionID: "qst_fixture" },
  payload: { type: "subagent_question", text: "fixture" },
})
add(56, "guardrail", {
  ...deferral,
  kind: "guardrail",
  origin: { requestID: "grq_fixture" },
  payload: {
    type: "guardrail",
    action: "shell",
    resources: [lossless],
    ruleIDs: ["standard.review.fixture"],
    reason: lossless,
    hardReview: true,
    directories: ["/project"],
    fingerprint,
    requestID: "grq_fixture",
  },
})
add(56, "recovery", {
  ...deferral,
  kind: "recovery",
  reason: "restart",
  origin: { messageID, callID: lossless },
  payload: { type: "recovery", tools: [{ messageID, callID: lossless, name: "shell" }] },
})
for (const [name, decision] of Object.entries({
  "question-form": { kind: "question", answers: { name: lossless, tags: ["x", ""] } },
  "question-answers": { kind: "question", answers: [["One"], [], [lossless, ""]] },
  "subagent-question": { kind: "subagent_question", text: lossless, data: opaque },
  "subagent-question-plain": { kind: "subagent_question", text: "fixture" },
  "guardrail-once": { kind: "guardrail", reply: "once" },
  "guardrail-always": { kind: "guardrail", reply: "always" },
  "guardrail-reject": { kind: "guardrail", reply: "reject" },
  "permission-always": { kind: "permission", reply: "always" },
  "recovery-continue": { kind: "recovery", choice: "continue" },
  "recovery-stop": { kind: "recovery", choice: "stop" },
  "dismissed-question": { kind: "question", dismissed: true },
  "dismissed-subagent-question": { kind: "subagent_question", dismissed: true },
}))
  add(57, name, { ...base, itemID, decision })
for (const source of ["team-view", "step-limit"]) add(23, source, { ...base, source, text: "" })
for (const finish of ["length", "tool-calls", "content-filter", "error", "unknown"])
  add(31, finish, { ...minimal[30], finish })
for (const code of [
  "superseded",
  "invalid_manifest",
  "protected_state_changed",
  "context_limit_unresolved",
  "migration_failed",
  "provider_failed",
])
  add(48, code, { ...job, code, error })
const principal = { ownerID: "owner", deviceID: "device", clientID: "client", grantID: "grant", epoch: "epoch" }
const dotsTarget = { profile: "work", dotID: "dot", threadID: "thread", generation: "g1", label: lossless }
const requestContext = {
  requestID: "req",
  principal: { ownerID: "owner", deviceID: "device", clientID: "client" },
  epoch: "epoch",
}
const exchange = {
  ...base,
  exchangeID: "ex",
  targetSessionID: "ses_target",
  inputID: messageID,
  expectedAttachment: dotsTarget,
  accountDigest: "digest",
  fingerprint,
  source: requestContext,
  grantID: "grant",
  scope: { rootSessionID: "ses_target" },
}
const routine = {
  delegation: { id: "del", revision: 2 },
  taskInputID: messageID,
  instruction: { operation: "presentation", preferences: { format: "bullets", detail: "concise" } },
}
const delegation = { id: "del", revision: 1 }
const targets = {
  permission: { kind: "permission", requestID: "per_fixture", fingerprint },
  guardrail: { kind: "guardrail", requestID: "grq_fixture", fingerprint },
  form: { kind: "form", formID: "frm_fixture", fingerprint },
  question: { kind: "question", requestID: "que_fixture", fingerprint },
  subagentQuestion: { kind: "subagent_question", questionID: "qst_fixture", fingerprint },
  review: { kind: "review", itemID, fingerprint },
}
const delegated = (instruction: Record<string, unknown>) => ({ delegation, instruction })
const instructions: Record<string, Record<string, unknown>> = {
  task: { operation: "task", text: lossless },
  permission: { operation: "decision", target: targets.permission, reply: "once" },
  guardrail: { operation: "decision", target: targets.guardrail, reply: "reject" },
  "form-answers": {
    operation: "decision",
    target: targets.form,
    answers: { name: lossless, tags: ["x", ""] },
  },
  "question-answers": {
    operation: "decision",
    target: targets.question,
    answers: [["One"], [], [lossless, ""]],
  },
  "form-cancelled": { operation: "decision", target: targets.form, cancelled: true },
  "question-cancelled": { operation: "decision", target: targets.question, cancelled: true },
  "subagent-question-text": { operation: "decision", target: targets.subagentQuestion, text: lossless },
  "subagent-question-data": { operation: "decision", target: targets.subagentQuestion, data: opaque },
  "subagent-question-dismissed": { operation: "decision", target: targets.subagentQuestion, dismissed: true },
  "review-permission": {
    operation: "decision",
    target: targets.review,
    decision: { kind: "permission", reply: "reject" },
  },
  "review-guardrail": {
    operation: "decision",
    target: targets.review,
    decision: { kind: "guardrail", reply: "once" },
  },
  "review-recovery": {
    operation: "decision",
    target: targets.review,
    decision: { kind: "recovery", choice: "stop" },
  },
  "review-question-dismissed": {
    operation: "decision",
    target: targets.review,
    decision: { kind: "question", dismissed: true },
  },
  "review-subagent-question": {
    operation: "decision",
    target: targets.review,
    decision: { kind: "subagent_question", text: lossless, data: opaque },
  },
}
add(63, "absent", exchange)
add(63, "present", { ...exchange, scope: { rootSessionID: "ses_target", groupID: "grp_fixture", ownerSessionID: "ses_owner" } }, true)
add(63, "routine-continue", {
  ...exchange,
  routine: { delegation: { id: "del", revision: 1 }, taskInputID: messageID, instruction: { operation: "continue" } },
})
add(63, "routine-presentation", { ...exchange, routine })
for (const [name, instruction] of Object.entries(instructions))
  add(63, `delegated-${name}`, { ...exchange, delegated: delegated(instruction) })
add(64, "absent", {
  ...base,
  inputID: messageID,
  anchorSessionID: "ses_anchor",
  exchangeID: "ex",
  delegationID: "del",
  reason: "delegation_invalid",
})
add(
  64,
  "present",
  {
    ...base,
    inputID: messageID,
    anchorSessionID: "ses_anchor",
    exchangeID: "ex",
    delegationID: "del",
    reason: "delegation_invalid",
  },
  true,
)
const report = (kind: string) => ({
  ...base,
  deliveryID: "delivery",
  messageID: "msg_report",
  text: lossless,
  envelope: {
    coordinator: { ownerID: "owner", deviceID: "device", clientID: "client" },
    scope: { epoch: "epoch", grantID: "grant" },
    exchangeID: "ex",
    messageID: "msg_report",
    kind,
    origin: "agent",
    sourceSessionID: "ses_target",
    replyToMessageID: messageID,
  },
  callID: lossless,
})
add(65, "present", report("completion"), true)
for (const kind of ["progress", "blocker", "decision_request", "completion"]) add(65, kind, report(kind))
const settledInvocation = { id: lossless, index: 0, name: lossless, tool: "shell", status: "completed" }
add(66, "absent", { ...tool, invocation: settledInvocation })
add(
  66,
  "present",
  {
    ...tool,
    invocation: { ...settledInvocation, index: 9007199254740991, status: "error", input: opaque, structured: opaque },
  },
  true,
)
add(66, "falsy-input", { ...tool, invocation: { ...settledInvocation, input: null, structured: 0 } })
add(67, "disabled", { ...base, enabled: false, revision: 0 })
add(67, "enabled", { ...base, enabled: true, revision: 9007199254740991 }, true)
add(68, "absent", { ...base, binding: { id: "binding", target: dotsTarget, accountDigest: "digest" } })
add(69, "absent", { ...base, bindingID: "binding" })
add(69, "present", { ...base, bindingID: "binding" }, true)
const deviceGrant = {
  id: "delegation",
  revision: 1,
  basis: "device",
  anchorSessionID: sessionID,
  bindingID: "binding",
  principal,
  scope: { target: "device", operations: ["task", "decision"] },
  expiresAt: 1,
  active: true,
}
add(70, "absent", { ...base, exchangeID: "exchange", fingerprint, grant: deviceGrant })
add(
  70,
  "present",
  {
    ...base,
    exchangeID: "exchange",
    fingerprint,
    grant: { ...deviceGrant, revision: 9007199254740991, scope: { target: "device", operations: ["decision"] }, expiresAt: 9007199254740991, active: false },
  },
  true,
)
add(71, "absent", { ...base, exchangeID: "exchange", fingerprint, delegationID: "delegation", revision: 1, principal })
add(71, "present", { ...base, exchangeID: "exchange", fingerprint, delegationID: "delegation", revision: 9007199254740991, principal }, true)
const delegationSource = { kind: "dots-delegation", anchorSessionID: "ses_anchor", delegationID: "del", revision: 1, exchangeID: "ex" }
const clientSource = {
  kind: "dots-client",
  anchorSessionID: "ses_anchor",
  bindingID: "binding",
  delegationID: "del",
  revision: 1,
  exchangeID: "ex",
  principal,
}
const nativeSource = {
  kind: "dots-native",
  profile: "fixture",
  credentialID: "credential",
  accountID: "account",
  accountGeneration: 0,
  environmentID: "environment",
  connectionID: "connection",
  clientID: "client",
  streamID: "stream",
  rootSessionID: "ses_anchor",
  accessRevision: 9007199254740991,
  requestID: "request",
}
for (const [name, source] of Object.entries({
  delegation: delegationSource,
  client: clientSource,
  native: nativeSource,
}))
  add(72, `source-${name}`, { ...base, source, target: targets.permission })
for (const [name, target] of Object.entries({
  guardrail: targets.guardrail,
  form: targets.form,
  question: targets.question,
  "subagent-question": targets.subagentQuestion,
  review: targets.review,
}))
  add(72, `target-${name}`, { ...base, source: delegationSource, target })
for (const reply of ["once", "reject"])
  add(72, `reply-${reply}`, { ...base, source: clientSource, target: targets.permission, reply })
add(72, "present", { ...base, source: nativeSource, target: targets.review, reply: "once" }, true)
const coordinated = { ...base, requestID: "per_fixture", outcome: "allow", via: "coordination", reply: "once" }
add(62, "coordination", {
  ...coordinated,
  confidence: 0.75,
  actor: "coordinator",
  coordinatorSessionID: "ses_coordinator",
  groupID: lossless,
  rationale: lossless,
})
add(62, "coordination-actor-only", {
  ...coordinated,
  outcome: "deny",
  reply: "reject",
  actor: "coordinator",
  coordinatorSessionID: "ses_coordinator",
})
add(62, "coordination-group-only", { ...coordinated, outcome: "escalate", groupID: "grp_fixture" }, true)
add(62, "coordination-rationale-only", { ...coordinated, rationale: "r".repeat(500) })
add(1, "standalone", {
  ...minimal[0],
  scope: "standalone",
  location: { directory: "/state/standalone-sessions/fixture" },
})
add(73, "absent", { ...base, inputID: messageID })
add(74, "absent", { ...base, inputID: messageID })
const mapping = variants.flatMap((name, index) =>
  name === undefined
    ? []
    : [
        {
          variant: index + 1,
          type: `session.${name}`,
          tests: cases.filter((item) => item.variant === index + 1).map((item) => item.name),
        },
      ],
)
for (const [index, item] of cases.entries()) {
  const schema = schemas.find((schema) => schema.typeName === `ycoding.v5.SessionLogItemValue${item.variant}`)!
  const event = {
    ...item.event,
    id: `evt_wire_stream_${index}`,
    metadata: undefined,
    location: undefined,
    durable: { aggregateID: sessionID, seq: index, version: (item.event.durable as { version: number }).version },
  }
  delete event.metadata
  delete event.location
  const encoded = create(SessionLogItemSchema, {
    kind: { case: `value${item.variant}`, value: create(schema, wire(schema, event)) },
  })
  item.streamHex = Buffer.from(encodeStrict(SessionLogItemSchema, encoded)).toString("hex")
}
const synced = [undefined, 0, 9007199254740991].map((seq) => {
  const schema = schemas.find((schema) => schema.typeName === "ycoding.v5.SessionLogItemValue52")!
  const domain = {
    type: "log.synced",
    aggregateID: sessionID,
    ...(seq === undefined ? {} : { seq }),
    sourceEpoch: "source-epoch-test",
  }
  const encoded = create(SessionLogItemSchema, {
    kind: { case: "value52", value: create(schema, wire(schema, domain)) },
  })
  return { seq: seq ?? null, hex: Buffer.from(encodeStrict(SessionLogItemSchema, encoded)).toString("hex") }
})
await Bun.write(
  new URL("expectations.json", import.meta.url),
  JSON.stringify({ mapping, cases, synced }, null, 2) + "\n",
)
console.log(`TS schema validated and v5 encoded ${cases.length} durable cases and ${synced.length} synced cases`)
