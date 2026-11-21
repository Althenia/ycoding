import { fileURLToPath } from "node:url"
const { Schema } = await import(
  Bun.resolveSync("effect", fileURLToPath(new URL("../../../../../packages/schema/", import.meta.url)))
)
const { create } = await import(
  Bun.resolveSync("@bufbuild/protobuf", fileURLToPath(new URL("../../../../../packages/protocol/", import.meta.url)))
)
import type { DescEnum, DescField, DescMessage } from "@bufbuild/protobuf"
import { EventManifest } from "../../../../../packages/schema/src/event-manifest.ts"
import {
  encodeLossless,
  encodeStrict,
  PublicEventSchema,
  schemas,
} from "../../../../../packages/protocol/src/v5/index.ts"

const lossless = "\ud800😀\udfff"
const opaque = { "\ud800": { text: lossless, zero: 0, no: false, empty: [], value: null } }
const sessionID = "ses_prompt"
const assistantMessageID = "msg_fixture"
const tokens = { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }
const model = { providerID: "openai", id: "fixture" }
const diagnostics = {
  model,
  context: { total: 0 },
  tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  cache: { eligible: 0, mechanism: "none", readReported: false, writeReported: false },
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
const pty = {
  id: "pty_fixture",
  title: lossless,
  command: "sh",
  args: [],
  cwd: "/project",
  sessionID,
  status: "running",
  pid: 1,
  generation: 1,
  size: { rows: 1, cols: 1 },
  control: { owner: "agent", fence: 1 },
  output: { startOffset: 0, endOffset: 0, truncated: false },
  limits: { maxRuntimeSeconds: 10, maxRetainedBytes: 65536, maxInputBytes: 4096 },
}
const samples: Record<string, Record<string, unknown>> = {
  "models-dev.refreshed": {},
  "integration.updated": {},
  "integration.connection.updated": { integrationID: "fixture" },
  "catalog.updated": {},
  "agent.updated": {},
  "session.usage.updated": { sessionID, cost: 0, tokens },
  "session.prediction.updated": { sessionID, sourceMessageID: assistantMessageID, text: lossless },
  "session.diagnostics.updated": { sessionID, diagnostics },
  "session.text.delta": { sessionID, assistantMessageID, ordinal: 0, delta: lossless },
  "session.reasoning.delta": { sessionID, assistantMessageID, ordinal: 0, delta: lossless },
  "session.tool.input.delta": { sessionID, assistantMessageID, callID: lossless, delta: "" },
  "session.tool.progress": { sessionID, assistantMessageID, callID: lossless, structured: {}, content: [] },
  "session.compaction.delta": { sessionID, text: lossless },
  "filesystem.changed": { file: lossless, event: "add" },
  "reference.updated": {},
  "permission.asked": { id: "per_fixture", sessionID, action: "read", resources: ["/project"] },
  "permission.replied": { sessionID, requestID: "per_fixture", reply: "once" },
  "permission.deferred": { sessionID, requestID: "per_fixture", itemID: "rvw_fixture" },
  "guardrail.asked": {
    id: "grq_fixture",
    rootSessionID: sessionID,
    sessionID,
    action: "shell",
    resources: [],
    ruleIDs: [],
    reason: lossless,
    standard: true,
  },
  "guardrail.replied": { rootSessionID: sessionID, sessionID, requestID: "grq_fixture", reply: "once" },
  "guardrail.decided": { rootSessionID: sessionID, sessionID, action: "shell", ruleIDs: [], decision: "allow" },
  "guardrail.deferred": { rootSessionID: sessionID, sessionID, requestID: "grq_fixture", itemID: "rvw_fixture" },
  "plugin.added": { id: lossless },
  "plugin.updated": {},
  "project.directories.updated": { projectID: "prj_one" },
  "command.updated": {},
  "config.updated": {},
  "skill.updated": {},
  "pty.created": { info: pty },
  "pty.updated": { info: pty },
  "pty.exited": { id: "pty_fixture", exitCode: 0, reason: "exit" },
  "pty.deleted": { id: "pty_fixture" },
  "shell.created": { info: shell },
  "shell.exited": { id: "sh_fixture", status: "exited" },
  "shell.deleted": { id: "sh_fixture" },
  "question.asked": { id: "que_fixture", sessionID, questions: [{ question: lossless, header: "", options: [] }] },
  "question.replied": { sessionID, requestID: "que_fixture", answers: [[]] },
  "question.rejected": { sessionID, requestID: "que_fixture" },
  "question.timed_out": { sessionID, requestID: "que_fixture" },
  "question.deferred": { sessionID, requestID: "que_fixture", itemID: "rvw_fixture" },
  "form.created": { form: { id: "frm_fixture", sessionID, title: lossless, fields: [{ key: "ok", type: "boolean" }] } },
  "form.replied": { id: "frm_fixture", sessionID, answer: {} },
  "form.cancelled": { id: "frm_fixture", sessionID },
  "form.timed_out": { id: "frm_fixture", sessionID },
  "form.deferred": { id: "frm_fixture", sessionID, itemID: "rvw_fixture" },
  "todo.updated": { sessionID, todos: [] },
  "provider.quota.pace": {
    providerID: "anthropic",
    windowID: "five-hour",
    milestone: "will-run-out",
    resetAt: 1_800_000_300_000,
    title: "Will run out",
    body: "Quota use is at its limit or projected to exceed it before reset.",
  },
  "session.status": { sessionID, status: { type: "idle" } },
  "session.idle": { sessionID },
  "tui.prompt.append": { text: lossless },
  "tui.command.execute": { command: "session.list" },
  "tui.toast.show": { message: lossless, variant: "info", duration: 1 },
  "tui.session.select": { sessionID },
  "installation.updated": { version: lossless },
  "installation.update-available": { version: lossless },
  "vcs.branch.updated": {},
  "mcp.status.changed": { server: lossless },
  "mcp.resources.changed": { server: lossless },
}
const speed = { model, tokens: 1, durationNs: 1000000000, tokensPerSecond: 1 }
const extra: Record<string, Record<string, unknown>> = {
  "session.tool.progress": {
    structured: opaque,
    content: [
      { type: "text", text: lossless },
      { type: "file", uri: "file:///fixture", mime: "text/plain", name: "" },
    ],
  },
  "permission.asked": {
    save: [],
    metadata: opaque,
    source: { type: "tool", messageID: assistantMessageID, callID: lossless },
  },
  "guardrail.asked": {
    hardReview: false,
    risk: { level: 1, label: "", score: 0.5, metric: "confidence" },
    metadata: opaque,
    escalation: {
      choice: "escalate",
      confidence: 0.25,
      grades: [
        { choice: "approve", confidence: 0.25, evidence: lossless },
        { choice: "escalate", confidence: 0.75, evidence: "fixture" },
      ],
    },
  },
  "guardrail.replied": {
    decidedBy: "decision-model",
    choice: "approve_all",
    confidence: 0.95,
    grades: [{ choice: "approve_all", confidence: 0.95, evidence: lossless }],
  },
  "question.asked": {
    questions: [
      {
        question: "",
        header: lossless,
        options: [{ label: "", description: lossless }],
        multiple: false,
        custom: false,
      },
    ],
    tool: { messageID: assistantMessageID, callID: lossless },
  },
  "question.replied": { answers: [["", lossless], []] },
  "form.created": {
    form: {
      id: "frm_fixture",
      sessionID,
      title: "",
      metadata: opaque,
      fields: [{ key: "ok", type: "boolean", required: false }],
    },
  },
  "form.replied": { answer: { text: lossless, number: 0, no: false, list: ["", lossless], empty: [] } },
  "todo.updated": { todos: [{ content: lossless, priority: "low", status: "in_progress" }] },
  "pty.created": { info: { ...pty, status: "exited", exitCode: 0, exitReason: "exit", args: [lossless], title: "" } },
  "pty.updated": { info: { ...pty, status: "exited", exitCode: 1, exitReason: "timeout" } },
  "shell.created": {
    info: {
      ...shell,
      status: "exited",
      pid: 0,
      exit: 0,
      toolCallID: "call_fixture",
      metadata: opaque,
      time: { started: 0, completed: 1 },
    },
  },
  "shell.exited": { exit: 0, status: "killed" },
  "session.status": {
    status: {
      type: "retry",
      attempt: 0,
      message: lossless,
      next: 0,
      action: { reason: "", provider: "", title: "", message: lossless, label: "", link: "" },
    },
  },
  "tui.toast.show": { title: "", variant: "error", duration: 9007199254740991 },
  "tui.command.execute": { command: lossless },
  "vcs.branch.updated": { branch: "" },
  "session.diagnostics.updated": {
    diagnostics: {
      ...diagnostics,
      contextBreakdown: { system: 0, tools: 1, user: 2, assistant: 3, reasoning: 4, toolCalls: 5, other: 6 },
      context: { total: 0, limit: 0, remaining: 0, percent: 0 },
      cache: { ...diagnostics.cache, hitRatio: 0, minimumTokens: 0, belowMinimum: false },
      estimatedCost: 0,
      requests: {
        logical: 0,
        physical: 0,
        helpers: 0,
        continued: 0,
        fallback: 0,
        cacheReadReported: false,
        cost: 0,
        models: [],
        tokens,
        latestInvalidation: "stable-hit",
        latestNamespace: "fixture0",
        latestTiming: { firstOutputMs: 0, totalMs: 0, generatedTokens: 1, generationDurationNs: 1000000000 },
      },
      generationSpeed: { latest: speed, recent: [speed] },
    },
  },
}

function enumeration(schema: DescEnum, input: unknown) {
  if (typeof input !== "string") throw new Error("enum string")
  const value = schema.values.find((value) => value.name.endsWith(`_${input.toUpperCase().replace(/[.-]/g, "_")}`))
  if (!value) throw new Error(`${schema.typeName}: ${input}`)
  return value.number
}
function field(schema: DescField, input: unknown): unknown {
  if (schema.fieldKind === "message") return wire(schema.message, input)
  if (schema.fieldKind === "enum") return enumeration(schema.enum, input)
  if (schema.scalar === 3 || schema.scalar === 4) return BigInt(input as number)
  return input
}
function value(input: unknown): unknown {
  if (input === null) return { kind: { case: "null", value: {} } }
  if (typeof input === "string") return { kind: { case: "string", value: encodeLossless(input) } }
  if (typeof input === "number") return { kind: { case: "number", value: input } }
  if (typeof input === "boolean") return { kind: { case: "boolean", value: input } }
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
function wire(schema: DescMessage, input: unknown): unknown {
  if (schema.typeName === "ycoding.v5.LosslessString") return encodeLossless(input as string)
  if (schema.typeName === "ycoding.v5.Value") return value(input)
  if (schema.oneofs.length) {
    const selected = schema.fields.find((candidate) => {
      if (candidate.fieldKind === "enum")
        return (
          typeof input === "string" &&
          candidate.enum.values.some((value) => value.name.endsWith(`_${input.toUpperCase().replace(/[.-]/g, "_")}`))
        )
      if (candidate.fieldKind === "scalar")
        return typeof input === "number" ? candidate.scalar === 1 : typeof input === "boolean" && candidate.scalar === 8
      if (candidate.fieldKind !== "message") return false
      if (candidate.message.typeName === "ycoding.v5.LosslessString") return typeof input === "string"
      if (Array.isArray(input)) return candidate.message.fields.some((field) => field.name === "items")
      const type = candidate.message.fields.find((field) => field.name === "type")
      return (
        type?.fieldKind === "enum" &&
        typeof input === "object" &&
        input !== null &&
        "type" in input &&
        type.enum.values.some((value) =>
          value.name.endsWith(`_${String(input.type).toUpperCase().replace(/[.-]/g, "_")}`),
        )
      )
    })
    if (!selected) throw new Error(`${schema.typeName}: union branch`)
    return { kind: { case: selected.localName, value: field(selected, input) } }
  }
  if (schema.fields.length === 1 && schema.fields[0]!.name === "items") {
    const item = schema.fields[0]!
    if (item.fieldKind !== "list") throw new Error("items")
    return {
      items: (input as unknown[]).map((itemValue) =>
        item.listKind === "message" ? wire(item.message, itemValue) : itemValue,
      ),
    }
  }
  if (schema.fields.length === 1 && schema.fields[0]!.name === "entries") {
    const item = schema.fields[0]!
    if (item.fieldKind !== "list" || item.listKind !== "message") throw new Error("entries")
    const target = item.message.fields.find((field) => field.name === "value")!
    return {
      entries: Object.entries(input as object).map(([key, itemValue]) => ({
        key: encodeLossless(key),
        value: field(target, itemValue),
      })),
    }
  }
  const object = input as Record<string, unknown>
  return Object.fromEntries(
    schema.fields.flatMap((fieldSchema) =>
      fieldSchema.name in object ? [[fieldSchema.localName, field(fieldSchema, object[fieldSchema.name])]] : [],
    ),
  )
}

const cases: { name: string; type: string; event: unknown; hex: string }[] = []
function add(type: string, name: string, data: Record<string, unknown>, enriched = false) {
  const definition = EventManifest.ServerDefinitions.find((definition) => definition.type === type)
  if (!definition || definition.durability !== "ephemeral") throw new Error(`missing ephemeral TS schema: ${type}`)
  const event = {
    id: `evt_ephemeral_${cases.length}`,
    created: 42,
    sourceEpoch: "source-epoch-test",
    type,
    data,
    ...(enriched ? { location: { directory: "/project", workspaceID: "wrk_fixture" }, metadata: opaque } : {}),
  }
  Schema.decodeUnknownSync(definition)(event)
  const branch = PublicEventSchema.fields.find((field) => field.name === type.replace(/[.-]/g, "_"))!
  if (branch.fieldKind !== "message") throw new Error(`missing public branch: ${type}`)
  const encoded = create(PublicEventSchema, {
    kind: { case: branch.localName, value: create(branch.message, wire(branch.message, event)) },
  })
  cases.push({
    name: `${type}/${name}`,
    type,
    event,
    hex: Buffer.from(encodeStrict(PublicEventSchema, encoded)).toString("hex"),
  })
}
for (const [type, sample] of Object.entries(samples)) {
  add(type, "absent", sample)
  add(type, "present", { ...sample, ...extra[type] }, true)
}
add("session.status", "busy", { sessionID, status: { type: "busy" } })
add("form.replied", "global", { id: "frm_fixture", sessionID: "global", answer: {} })
add("form.cancelled", "global", { id: "frm_fixture", sessionID: "global" })
add("form.created", "global", {
  form: { id: "frm_fixture", sessionID: "global", title: "", fields: [{ key: "ok", type: "boolean" }] },
})
add("filesystem.changed", "change", { file: "", event: "change" })
add("filesystem.changed", "unlink", { file: "", event: "unlink" })
add("permission.replied", "always", { sessionID, requestID: "per_fixture", reply: "always" })
add("permission.replied", "reject", { sessionID, requestID: "per_fixture", reply: "reject" })
add("guardrail.replied", "always", { rootSessionID: sessionID, sessionID, requestID: "grq_fixture", reply: "always" })
add("guardrail.replied", "reject", { rootSessionID: sessionID, sessionID, requestID: "grq_fixture", reply: "reject" })
add("guardrail.replied", "decided-reject", {
  rootSessionID: sessionID,
  sessionID,
  requestID: "grq_fixture",
  reply: "reject",
  decidedBy: "decision-model",
  choice: "reject",
})
add("guardrail.asked", "escalation-empty", { ...samples["guardrail.asked"], escalation: {} })
add("form.timed_out", "global", { id: "frm_fixture", sessionID: "global" })
add("form.deferred", "global", { id: "frm_fixture", sessionID: "global", itemID: "rvw_fixture" })
add("guardrail.decided", "deny", { rootSessionID: sessionID, sessionID, action: "", ruleIDs: [], decision: "deny" })
add("guardrail.decided", "ask", { rootSessionID: sessionID, sessionID, action: "", ruleIDs: [], decision: "ask" })
add("guardrail.decided", "cap_exceeded", {
  rootSessionID: sessionID,
  sessionID,
  action: "",
  ruleIDs: [],
  decision: "cap_exceeded",
})
const expected = EventManifest.ServerDefinitions.filter((definition) => definition.durability === "ephemeral")
  .map((definition) => definition.type)
  .sort()
if (JSON.stringify(Object.keys(samples).sort()) !== JSON.stringify(expected))
  throw new Error("TS ephemeral inventory differs")
await Bun.write(
  new URL("expectations.json", import.meta.url),
  JSON.stringify({ variants: expected, cases }, null, 2) + "\n",
)
console.log(`Validated and TS-v5 encoded ${cases.length} cases for ${expected.length} ephemeral variants`)
