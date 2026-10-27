export * as RemoteMcpSchemas from "./remote-mcp-schemas"

import { RemoteLimits, remoteOperationAccess, requireSession, type RemoteOperation } from "@ycoding-ai/remote"
import { RemoteMcpApps } from "./remote-mcp-apps"

type Schema = { [key: string]: unknown }

export const excludedOperations = [
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
] as const satisfies readonly RemoteOperation[]

export type ToolOperation = Exclude<RemoteOperation, (typeof excludedOperations)[number]> | "session.createInDirectory"

export type Tool = {
  readonly name: string
  readonly operation: ToolOperation
  readonly description: string
  readonly inputSchema: { type: "object" } & Schema
  readonly mutation: boolean
  readonly annotations: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
    readonly openWorldHint: false
  }
}

type Spec = {
  readonly description: string
  readonly input?: Schema
  readonly optional?: true
  readonly session?: "optional"
}

const maxSafeInteger = Number.MAX_SAFE_INTEGER

const text = (maxLength: number, minLength = 1): Schema => ({ type: "string", minLength, maxLength })
const nonblank = (maxLength: number): Schema => ({
  type: "string",
  minLength: 1,
  maxLength,
  pattern: "^[\\s\\S]*\\S[\\s\\S]*$",
})
const line = (maxLength: number): Schema => ({
  type: "string",
  minLength: 1,
  maxLength,
  pattern: "^[^\\u0000\\r\\n]*\\S[^\\u0000\\r\\n]*$",
})
const titleCharacter = "\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069"
const sessionTitle: Schema = {
  type: "string",
  minLength: 1,
  maxLength: RemoteLimits.maxSessionTitleChars,
  pattern: `^[^\\s${titleCharacter}](?:[^${titleCharacter}]*[^\\s${titleCharacter}])?$`,
}
const prefixed = (pattern: string, maxLength: number): Schema => ({ type: "string", minLength: 1, maxLength, pattern })
const integer = (minimum: number, maximum: number): Schema => ({ type: "integer", minimum, maximum })
const boolean: Schema = { type: "boolean" }
const choice = (...values: readonly string[]): Schema => ({ type: "string", enum: values })
const array = (items: Schema, minItems: number, maxItems: number, uniqueItems = false): Schema => ({
  type: "array",
  items,
  minItems,
  maxItems,
  ...(uniqueItems ? { uniqueItems } : {}),
})
const object = (properties: Record<string, Schema>, required: readonly string[] = []): { type: "object" } & Schema => ({
  type: "object",
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties: false,
})

const sessionID = prefixed("^ses[A-Za-z0-9_-]+$", 128)
const messageID = prefixed("^msg_[A-Za-z0-9_-]+$", 128)
const shellID = prefixed("^sh_[A-Za-z0-9]+$", 128)
const memory = array(choice("repository", "knowledge"), 0, 2, true)
const delivery = choice("steer", "queue")
const dotsAttachment = object({ profile: text(512), dotID: text(512), threadID: text(512), generation: text(512), label: text(512) }, ["profile", "dotID", "threadID", "generation", "label"])
const dotsDecisionTarget: Schema = { oneOf: [
  object({ kind: { const: "permission" }, requestID: prefixed("^per[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "requestID", "fingerprint"]),
  object({ kind: { const: "guardrail" }, requestID: prefixed("^grq_[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "requestID", "fingerprint"]),
  object({ kind: { const: "form" }, formID: prefixed("^frm_[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "formID", "fingerprint"]),
  object({ kind: { const: "question" }, requestID: prefixed("^que[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "requestID", "fingerprint"]),
  object({ kind: { const: "subagent_question" }, questionID: prefixed("^qst_[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "questionID", "fingerprint"]),
  object({ kind: { const: "review" }, itemID: prefixed("^rvw_[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "itemID", "fingerprint"]),
] }
const dotsAnswerValue = { anyOf: [{ type: "string", maxLength: 8192 }, { type: "number" }, { type: "boolean" }, { type: "array", maxItems: 64, items: { type: "string", maxLength: 4096 } }] }
const dotsFormAnswers: Schema = { type: "object", maxProperties: 64, additionalProperties: dotsAnswerValue }
const dotsQuestionAnswers: Schema = { type: "array", maxItems: 64, items: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4096 } } }
const nativeFormAnswers: Schema = { type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "array", items: { type: "string" } }] } }
const nativeQuestionAnswers: Schema = { type: "array", items: { type: "array", items: { type: "string" } } }
const nativeReviewDecision: Schema = { oneOf: [
  object({ kind: choice("permission", "guardrail"), reply: choice("once", "always", "reject") }, ["kind", "reply"]),
  object({ kind: { const: "recovery" }, choice: choice("continue", "stop") }, ["kind", "choice"]),
  object({ kind: { const: "question" }, answers: { anyOf: [nativeFormAnswers, nativeQuestionAnswers] } }, ["kind", "answers"]),
  object({ kind: { const: "subagent_question" }, text: text(65_536) }, ["kind", "text"]),
  object({ kind: choice("question", "subagent_question"), dismissed: { const: true } }, ["kind", "dismissed"]),
] }
const dotsReviewDecision: Schema = { oneOf: [
    object({ kind: choice("permission", "guardrail"), reply: choice("once", "reject") }, ["kind", "reply"]),
    object({ kind: { const: "recovery" }, choice: choice("continue", "stop") }, ["kind", "choice"]),
    object({ kind: { const: "question" }, answers: { anyOf: [dotsFormAnswers, dotsQuestionAnswers] } }, ["kind", "answers"]),
    object({ kind: { const: "subagent_question" }, text: text(65_536) }, ["kind", "text"]),
    object({ kind: { const: "question" }, dismissed: { const: true } }, ["kind", "dismissed"]),
    object({ kind: { const: "subagent_question" }, dismissed: { const: true } }, ["kind", "dismissed"]),
  ] }
const dotsDecisionInstruction: Schema = { oneOf: [
  object({ operation: { const: "decision" }, target: { oneOf: [
    object({ kind: { const: "permission" }, requestID: prefixed("^per[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "requestID", "fingerprint"]),
    object({ kind: { const: "guardrail" }, requestID: prefixed("^grq_[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "requestID", "fingerprint"]),
  ] }, reply: choice("once", "reject") }, ["operation", "target", "reply"]),
  object({ operation: { const: "decision" }, target: object({ kind: { const: "form" }, formID: prefixed("^frm_[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "formID", "fingerprint"]), answers: dotsFormAnswers }, ["operation", "target", "answers"]),
  object({ operation: { const: "decision" }, target: object({ kind: { const: "form" }, formID: prefixed("^frm_[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "formID", "fingerprint"]), cancelled: { const: true } }, ["operation", "target", "cancelled"]),
  object({ operation: { const: "decision" }, target: object({ kind: { const: "question" }, requestID: prefixed("^que[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "requestID", "fingerprint"]), answers: dotsQuestionAnswers }, ["operation", "target", "answers"]),
  object({ operation: { const: "decision" }, target: object({ kind: { const: "question" }, requestID: prefixed("^que[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "requestID", "fingerprint"]), cancelled: { const: true } }, ["operation", "target", "cancelled"]),
  object({ operation: { const: "decision" }, target: object({ kind: { const: "subagent_question" }, questionID: prefixed("^qst_[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "questionID", "fingerprint"]), text: text(65_536) }, ["operation", "target", "text"]),
  object({ operation: { const: "decision" }, target: object({ kind: { const: "subagent_question" }, questionID: prefixed("^qst_[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "questionID", "fingerprint"]), dismissed: { const: true } }, ["operation", "target", "dismissed"]),
  object({ operation: { const: "decision" }, target: object({ kind: { const: "review" }, itemID: prefixed("^rvw_[A-Za-z0-9_-]+$", 256), fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["kind", "itemID", "fingerprint"]), decision: dotsReviewDecision }, ["operation", "target", "decision"]),
] }
const maxNoProgress = { anyOf: [integer(0, 1_000), { type: "null" }] }

const model = object({ providerID: text(128), id: text(128), variant: text(128), profile: text(128) }, [
  "providerID",
  "id",
])
const mention = object({ start: integer(0, 1_000_000), end: integer(0, 1_000_000), text: text(1_024, 0) }, [
  "start",
  "end",
  "text",
])
const files = array(object({ uri: text(2_048), name: text(256), description: text(1_024), mention }, ["uri"]), 0, 64)
const agents = array(object({ name: text(256), mention }, ["name"]), 0, 64)
const providerTarget: Schema = {
  oneOf: [
    object({ sessionID: prefixed("^ses_[A-Za-z0-9_-]+$", 128) }, ["sessionID"]),
    object({ workspace: line(256) }, ["workspace"]),
  ],
}
const integrationID = line(128)
const attemptID = prefixed("^con_[A-Za-z0-9_-]+$", 128)
const providerInput = (properties: Record<string, Schema>, required: readonly string[]) =>
  object({ target: providerTarget, integrationID, ...properties }, ["target", "integrationID", ...required])

const coordinationGroupID = prefixed("^cgrp_[A-Za-z0-9_-]+$", 96)
const coordinationRevision = integer(0, maxSafeInteger)
const coordinationScopeText = text(512)
const coordinationDelegated = object(
  {
    categories: array(choice("question", "permission", "review"), 0, 3),
    actions: array(coordinationScopeText, 0, 32),
    resources: array(coordinationScopeText, 0, 32),
    expiresAt: integer(0, maxSafeInteger),
  },
  ["categories"],
)
const coordinationSettings = object(
  {
    concurrency: { anyOf: [integer(1, maxSafeInteger), { type: "null" }] },
    delegatedDecisions: coordinationDelegated,
  },
  ["concurrency"],
)

const usageReport = object(
  {
    group: choice(
      "model",
      "hour",
      "day",
      "month",
      "session",
      "project",
      "agent",
      "provider",
      "provider-profile-model",
      "provider-model",
      "model-id",
      "profile",
      "prompt",
      "task",
    ),
    timeZone: text(128),
    from: integer(0, maxSafeInteger),
    to: integer(0, maxSafeInteger),
    offset: integer(0, maxSafeInteger),
    limit: integer(1, 200),
    sort: choice("key", "tokens", "cost", "steps", "input", "output", "reasoning", "cacheRead", "cacheWrite"),
    order: choice("asc", "desc"),
    providerID: text(128),
    profile: text(128),
    modelID: text(128),
    selectedEffort: text(128),
  },
  ["group"],
)

const autonomyMode = choice("manual", "yolo", "auto")
const autonomy: Schema = {
  oneOf: [
    {
      ...object({ permissions: autonomyMode, guardrails: autonomyMode, answers: autonomyMode }),
      minProperties: 1,
    },
    object({ sleep: boolean }, ["sleep"]),
  ],
}

const forecast = {
  type: "object",
  properties: { sessionID, input: object({ localScope: choice("backend", "location") }, ["localScope"]) },
  required: ["input"],
  additionalProperties: false,
  allOf: [
    {
      if: {
        properties: { input: { properties: { localScope: { const: "location" } }, required: ["localScope"] } },
        required: ["input"],
      },
      then: { required: ["sessionID"] },
      else: { not: { required: ["sessionID"] } },
    },
  ],
} as const

const specs = {
  "session.dots.exchange.create": {
    description: "Admit external information, a closed routine directive for one separately native-approved task, or a delegated task/decision under an active native session delegation. Delegated text is plugin-origin information from the authenticated client, not the user. Decisions settle only eligible ordinary pending requests from that delegation's own tasks by exact fingerprint; read candidates from the task exchange. Stable exchange IDs reconcile retries.",
    input: { oneOf: [
      object({ exchangeID: text(256), expectedAttachment: dotsAttachment, targetSessionID: sessionID, channel: { const: "task" }, delivery, text: text(32768) }, ["exchangeID", "expectedAttachment", "targetSessionID", "channel", "delivery", "text"]),
      object({ exchangeID: text(256), expectedAttachment: dotsAttachment, targetSessionID: sessionID, channel: { const: "task" }, delivery,
        delegation: object({ id: text(256), revision: { type: "integer", minimum: 1 } }, ["id", "revision"]), taskInputID: text(256),
        instruction: { oneOf: [object({ operation: { const: "continue" } }, ["operation"]),
          object({ operation: { const: "presentation" }, preferences: { ...object({ format: { enum: ["prose", "bullets"] }, detail: { enum: ["concise", "standard", "detailed"] } }), minProperties: 1 } }, ["operation", "preferences"]) ] },
      }, ["exchangeID", "expectedAttachment", "targetSessionID", "channel", "delivery", "delegation", "taskInputID", "instruction"]),
      object({ exchangeID: text(256), expectedAttachment: dotsAttachment, targetSessionID: sessionID, channel: { const: "task" }, delivery,
        delegation: object({ id: text(256), revision: { type: "integer", minimum: 1 } }, ["id", "revision"]),
        instruction: { oneOf: [object({ operation: { const: "task" }, text: text(32768) }, ["operation", "text"]), dotsDecisionInstruction] },
      }, ["exchangeID", "expectedAttachment", "targetSessionID", "channel", "delivery", "delegation", "instruction"]),
    ] },
  },
  "session.dots.exchange.read": {
    description: "Read only the authorized exchange's correlated progress and result. Delegated task exchanges also list eligible pending native decisions from that exact task with fingerprints for a delegated decision exchange. Does not retry work or transmit room messages.",
    input: object({ exchangeID: text(256) }, ["exchangeID"]),
  },
  "session.dots.delegation.device.create": {
    description: "Create a device-wide Dots grant for the freshly authenticated client, scoped to the selected closed operations and current relay authorization.",
    input: object({ id: text(256), exchangeID: text(256), bindingID: text(256), expectedAttachment: dotsAttachment,
      scope: object({ target: { const: "device" }, operations: array(choice("task", "decision"), 1, 2, true) }, ["target", "operations"]) }, ["id", "exchangeID", "bindingID", "expectedAttachment", "scope"]),
  },
  "session.dots.delegation.device.read": {
    description: "Read device-wide Dots grants under the authenticated binding, using the opaque continuation cursor when provided.",
    input: object({ cursor: text(4096), limit: integer(1, 100) }),
    optional: true,
  },
  "session.dots.delegation.device.revoke": {
    description: "Revoke a device-wide Dots grant by its current revision. Revocation blocks future admissions and never replays prior work.",
    input: object({ id: text(256), revision: integer(1, maxSafeInteger), exchangeID: text(256), bindingID: text(256), expectedAttachment: dotsAttachment }, ["id", "revision", "exchangeID", "bindingID", "expectedAttachment"]),
  },
  "session.dots.decisions.list": {
    description: "List exact, currently pending native decisions from the selected Session or the confirmed device's authorized Session inventory. Results are paged with opaque cursors.",
    input: object({ bindingID: text(256), expectedAttachment: dotsAttachment, delegation: object({ id: text(256), revision: integer(1, maxSafeInteger) }, ["id", "revision"]), targetSessionID: sessionID, cursor: text(4096), limit: integer(1, 100) }, ["bindingID", "expectedAttachment", "delegation"]),
  },
  "provider.auth.list": {
    description:
      "List the provider integrations, connection labels and connection methods available at a Session or workspace target.",
    input: object({ target: providerTarget }, ["target"]),
  },
  "provider.auth.key": {
    description: "Store a provider API key for a target. Persistent credential change; the key is never returned.",
    input: providerInput({ label: line(128), key: line(8_192) }, ["label", "key"]),
  },
  "provider.auth.begin": {
    description: "Begin a provider connection attempt for a target and return its attempt ID and instructions.",
    input: providerInput(
      {
        methodID: line(128),
        label: line(128),
        inputs: { type: "object", maxProperties: 32, propertyNames: line(128), additionalProperties: text(2_048, 0) },
      },
      ["methodID", "label", "inputs"],
    ),
  },
  "provider.auth.status": {
    description: "Read the status of a provider connection attempt.",
    input: providerInput({ attemptID }, ["attemptID"]),
  },
  "provider.auth.complete": {
    description: "Complete a provider connection attempt with the authorization code the user obtained.",
    input: providerInput({ attemptID, code: line(2_048) }, ["attemptID", "code"]),
  },
  "provider.auth.cancel": {
    description: "Cancel a pending provider connection attempt.",
    input: providerInput({ attemptID }, ["attemptID"]),
  },
  "workspace.list": {
    description:
      "List the workspaces (recorded project directories) on this machine. Pass sessionsOnly to list only workspaces that hold Sessions.",
    input: object({ sessionsOnly: boolean }),
    optional: true,
  },
  "workspace.catalog": {
    description: "List the agents, models, commands, skills, references and resources available in a workspace.",
    input: object({ workspace: text(128) }, ["workspace"]),
  },
  "workspace.file.find": {
    description: "Find files by name in a workspace.",
    input: object({ workspace: text(128), query: text(200), limit: integer(1, 50) }, ["workspace", "query"]),
  },
  "session.list": {
    description: "Page through the backend's Sessions, newest first by default. Pass the returned cursor to continue.",
    input: object({
      limit: integer(1, 200),
      order: choice("asc", "desc", "pinned", "active"),
      search: text(200, 0),
      searchFields: choice("summary"),
      parentID: { anyOf: [sessionID, { type: "null" }] },
      cursor: text(1_024),
      workspace: text(128),
      status: choice("waiting", "running", "idle"),
      around: sessionID,
      before: integer(0, 199),
    }),
    optional: true,
  },
  "session.active": { description: "Read which Sessions are executing now." },
  "session.get": { description: "Read one Session's record." },
  "session.delete": {
    description:
      "Delete a Session and its history at its backend-resolved Location. Deleting a Project's Master deletes the Project; deleting a member detaches it.",
  },
  "session.messages": { description: "Read a Session's full projected transcript." },
  "session.capturedChanges.list": {
    description: "Page through the file changes a Session and its subagents captured.",
    input: object({ cursor: text(256) }),
    optional: true,
  },
  "session.compaction.list": { description: "Read a Session's compaction history." },
  "session.compact": {
    description:
      "Compact a Session's context. Returns when compaction settles, which can take minutes. The client supplies the compaction ID.",
    input: object({ id: prefixed("^cmp_[A-Za-z0-9_-]+$", 128) }, ["id"]),
  },
  "session.snapshot": {
    description:
      "Read a Session's transcript snapshot. Pass limit (and before from a previous result) to page older history.",
    input: object({ limit: integer(1, 200), before: text(256) }),
    optional: true,
  },
  "session.pending.list": { description: "List a Session's admitted prompts that are not yet part of the transcript." },
  "session.attachment.read": {
    description: "Read a managed attachment of a Session by its SHA-256 digest.",
    input: object({ digest: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["digest"]),
  },
  "session.todo.list": { description: "Read a Session's todo list." },
  "session.subagent.list": {
    description: "Page through a Session's managed subagent tasks.",
    input: object({ cursor: text(1_024) }),
    optional: true,
  },
  "session.pin": { description: "Pin a managed child Session in its parent's Team view." },
  "session.unpin": { description: "Unpin a managed child Session in its parent's Team view." },
  "session.subagent.cancel": {
    description: "Cancel a managed subagent of a Session.",
    input: object({ childID: sessionID }, ["childID"]),
  },
  "session.subagent.answer": {
    description: "Answer one pending question from a managed child in this Session family. The local orchestration service verifies the child and question before settlement.",
    input: object({ childID: sessionID, questionID: prefixed("^qst_[A-Za-z0-9_-]+$", 128), text: text(8_192) }, ["childID", "questionID", "text"]),
  },
  "session.team.economics": {
    description: "Read cost, token and context figures for members of a Session's family.",
    input: object({ sessionIDs: array(sessionID, 1, 15, true) }, ["sessionIDs"]),
  },
  "session.team.shell.list": { description: "List the shells running across a root Session's family." },
  "session.team.shell.kill": {
    description: "Terminate one shell of a root Session's family.",
    input: object({ shellID }, ["shellID"]),
  },
  "session.side-chat.list": {
    description: "Page through a root Session's side chats.",
    input: object({ cursor: text(1_024) }),
    optional: true,
  },
  "session.side-chat.create": {
    description: "Create a side chat under a root Session. The client supplies the side chat's Session ID.",
    input: object({ id: sessionID }, ["id"]),
  },
  "session.family.activity": {
    description: "Read what each listed family member of a root Session is doing now.",
    input: object({ sessionIDs: array(sessionID, 0, 15, true) }, ["sessionIDs"]),
  },
  "session.log": {
    description: "Read a Session's event log after a sequence number.",
    input: object({ after: integer(0, maxSafeInteger) }),
    optional: true,
  },
  "session.prompt": {
    description:
      "Send a prompt to a Session. The client must supply input.id (a msg_ identifier); retry an uncertain send only with the same id. Delivery steers by default; queue waits until the Session would go idle.",
    input: object(
      {
        id: messageID,
        text: text(32_768, 0),
        files,
        agents,
        skills: array(nonblank(128), 0, 200),
        delivery,
        resume: boolean,
      },
      ["id", "text"],
    ),
  },
  "session.interrupt": { description: "Interrupt a Session's active execution." },
  "session.prediction": {
    description: "Predict the next prompt for a Session using the listed memory scopes.",
    input: object({ memory, hint: text(2_000, 0) }, ["memory"]),
  },
  "session.promptGenerate": {
    description: "Draft a prompt from an intent for a Session using the listed memory scopes.",
    input: object({ mode: choice("start", "steer", "queue", "goal"), intent: nonblank(4_000), memory }, [
      "mode",
      "intent",
      "memory",
    ]),
  },
  "session.permission.list": { description: "List a Session's pending permission requests." },
  "session.permission.reply": {
    description: "Reply to one pending permission request with once, always, or reject. The local permission service rechecks the request, denies, ceilings, and grant scope; submit only an action available for that request.",
    input: object({ requestID: prefixed("^per_[A-Za-z0-9_-]+$", 256), reply: choice("once", "always", "reject"), message: text(1_024, 0) }, ["requestID", "reply"]),
  },
  "session.guardrail.status": { description: "Read a Session's guardrail review status." },
  "session.guardrail.request.list": { description: "List a Session family's pending guardrail reviews." },
  "session.guardrail.reply": {
    description: "Reply to one pending guardrail request with once, always, or reject. Always is available only for ordinary reviews; hard reviews permit once or reject. The local guardrail service enforces current policy.",
    input: object({ requestID: prefixed("^grq_[A-Za-z0-9_-]+$", 256), reply: choice("once", "always", "reject") }, ["requestID", "reply"]),
  },
  "session.review.list": { description: "List the open review items of a Session's family, including deferred ones." },
  "session.review.decide": {
    description: "Submit one typed decision for an open review item. The available action depends on the item and current policy; the local review service checks ownership and settlement state.",
    input: object({ itemID: prefixed("^rvw_[A-Za-z0-9_-]+$", 128), decision: nativeReviewDecision }, ["itemID", "decision"]),
  },
  "session.form.list": { description: "List a Session's pending forms and questions." },
  "session.form.reply": {
    description: "Submit answers to one pending form. The local form validator checks the current form and answer fields.",
    input: object({ formID: prefixed("^frm_[A-Za-z0-9_-]+$", 256), answer: nativeFormAnswers }, ["formID", "answer"]),
  },
  "session.form.cancel": {
    description: "Cancel one pending form without interrupting or stopping its Session.",
    input: object({ formID: prefixed("^frm_[A-Za-z0-9_-]+$", 256) }, ["formID"]),
  },
  "session.shell.output": {
    description: "Read a page of a shell's output. Pass the returned cursor to continue.",
    input: object({ shellID, cursor: integer(0, maxSafeInteger), limit: integer(1, 65_536) }, ["shellID"]),
  },
  "session.autonomy.get": {
    description:
      "Read a Session's autonomy settings (permissions, guardrails, and answers modes with their effective and inherited values, sleep, goal).",
  },
  "session.autonomy.set": {
    description:
      "Set Session autonomy: send any of permissions, guardrails, and answers in one request, each manual, yolo, or auto; or send sleep alone. Manual leaves undecided requests pending for an authorized typed client decision; Auto uses deterministic rules; YOLO adds the category evaluator for unresolved requests. Denies and permission ceilings always apply, and hard or custom-rule review approvals require an authorized typed decision. Grants standing authority; send only what the user authorized.",
    input: autonomy,
  },
  "session.goal.set": {
    description:
      "Set a Session's goal and optionally its no-progress budget. The Session then continues autonomously toward the goal.",
    input: object({ goal: text(8_192), maxNoProgress }, ["goal"]),
  },
  "session.goal.stop": {
    description: "Stop a Session's goal.",
    input: object({ goal: { type: "null" } }),
    optional: true,
  },
  "session.create": {
    description:
      "Create a root Session in a recorded workspace from workspace_list. The client must supply input.id; retry an uncertain create with the same id and workspace.",
    input: object({ id: sessionID, workspace: text(128), agent: text(128), model, title: sessionTitle }, [
      "id",
      "workspace",
    ]),
  },
  "session.status": { description: "Read which root Sessions are running, need attention, or failed." },
  "session.catalog": {
    description: "List the agents, models, commands, skills, references and resources available to a Session.",
  },
  "session.file.find": {
    description: "Find files by name at a Session's Location.",
    input: object({ query: text(200), limit: integer(1, 50) }, ["query"]),
  },
  "session.switchModel": {
    description: "Switch a Session's model.",
    input: object({ model }, ["model"]),
  },
  "session.switchAgent": {
    description: "Switch a Session's agent.",
    input: object({ agent: text(128) }, ["agent"]),
  },
  "session.command": {
    description: "Run a slash command in a Session.",
    input: object({ id: messageID, command: text(256), arguments: text(8_192, 0), files, agents, delivery }, [
      "command",
    ]),
  },
  "session.skill": {
    description: "Load a skill into a Session.",
    input: object({ id: messageID, skill: text(128), resume: boolean }, ["skill"]),
  },
  "usage.providers": {
    description: "Read provider quota and usage status. Pass refresh to re-read it from the providers.",
    input: object({ refresh: boolean }),
    optional: true,
  },
  "usage.summary": { description: "Read the backend's usage summary." },
  "usage.report": { description: "Read a backend usage report grouped by the chosen dimension.", input: usageReport },
  "session.usageReport": {
    description: "Read a usage report for one Session's tree grouped by the chosen dimension.",
    input: usageReport,
  },
  "session.promptCosts": {
    description: "Read the cost of up to 100 prompts of a Session by prompt message ID.",
    input: object({ inputIDs: array(messageID, 1, 100, true) }, ["inputIDs"]),
  },
  "session.taskCosts": {
    description: "Read the cost of up to 100 task Sessions of a Session's tree by Session ID.",
    input: object({ sessionIDs: array(sessionID, 1, 100, true) }, ["sessionIDs"]),
  },
  "usage.forecast": {
    description:
      "Read a usage forecast: localScope backend needs no sessionID; location needs the sessionID whose Location it covers.",
  },
  "incident.report": {
    description: "Read the backend's model incident report grouped by model or agent.",
    input: object(
      {
        group: choice("model", "agent"),
        from: integer(0, maxSafeInteger),
        to: integer(0, maxSafeInteger),
        offset: integer(0, maxSafeInteger),
        limit: integer(1, 200),
      },
      ["group"],
    ),
  },
  "incident.recent": {
    description: "Read recent incidents of one model.",
    input: object({ provider: text(128), model: text(128), agent: text(128), limit: integer(1, 50) }, [
      "provider",
      "model",
    ]),
  },
  "incident.guidance": {
    description:
      "Read the guardrail guidance derived for a model. Pass sessionID to resolve the capability at that Session's Location.",
    input: object({ provider: text(128), model: text(128) }, ["provider", "model"]),
    session: "optional",
  },
  "incident.guidance.clear": {
    description:
      "Clear the guardrail guidance for a model. Pass sessionID to resolve the capability at that Session's Location.",
    input: object({ provider: text(128), model: text(128) }, ["provider", "model"]),
    session: "optional",
  },
  "machine.keepAwake.get": { description: "Read whether this machine is held awake for running Sessions." },
  "machine.keepAwake.set": {
    description: "Turn the machine keep-awake hold on or off.",
    input: object({ enabled: boolean }, ["enabled"]),
  },
  "artifact.demo.preview": {
    description:
      "Render the fixed two-variant MCP Apps capability demo. No Session or workspace content is read. Actual host support requires verification.",
  },
  "artifact.demo.export": {
    description:
      "Export only the fixed expiring PNG demo with original-byte integrity metadata. Native attachment creation belongs to the host.",
  },
  "coordination.settings": {
    description:
      "Read the backend's resolved delegated-decision settings for Projects (enabled, categories, optional action/resource bounds and expiry).",
  },
  "coordination.list": {
    description: "List Projects with their Master Session IDs, active state, revision, settings and member counts.",
  },
  "coordination.create": {
    description:
      "Create a Project with one Master and up to 64 member Sessions. All Sessions must exist on this backend; their Locations are resolved by the backend.",
    input: object({ name: text(120), masterSessionID: sessionID, memberSessionIDs: array(sessionID, 0, 64) }, [
      "name",
      "masterSessionID",
      "memberSessionIDs",
    ]),
  },
  "coordination.get": {
    description: "Read a Project's Master, members, live states, pending requests, settings and active state.",
    input: object({ groupID: coordinationGroupID }, ["groupID"]),
  },
  "coordination.update": {
    description:
      "Update a Project at the expected revision. Omitted fields are preserved; memberSessionIDs and settings replace their whole values. Sessions must exist on this backend.",
    input: object(
      {
        groupID: coordinationGroupID,
        revision: coordinationRevision,
        name: text(120),
        masterSessionID: sessionID,
        memberSessionIDs: array(sessionID, 0, 64),
        settings: coordinationSettings,
      },
      ["groupID", "revision"],
    ),
  },
  "coordination.delete": {
    description: "Delete a Project while preserving its Master and member Sessions and their histories.",
    input: object({ groupID: coordinationGroupID }, ["groupID"]),
  },
  "session.createInDirectory": {
    description:
      "Create a root Session in an existing directory strictly below the machine owner's home directory, given as an absolute path. The client must supply input.id; retry an uncertain create with the same id and directory. Missing paths, the home directory itself, and paths outside home (including via symlinks) are refused; no directory is created.",
    input: object({ id: sessionID, directory: text(4_096), agent: text(128), model, title: sessionTitle }, [
      "id",
      "directory",
    ]),
  },
} as const satisfies Record<Exclude<ToolOperation, RemoteMcpApps.Operation>, Spec>

export function toolName(operation: string) {
  return operation
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[.-]/g, "_")
    .toLowerCase()
}

const standardTools: readonly Tool[] = (Object.entries(specs) as [ToolOperation, Spec][]).map(([operation, spec]) => {
  const mutation = operation === "session.createInDirectory" || remoteOperationAccess[operation] === "mutation"
  return {
    name: toolName(operation),
    operation,
    description: spec.description,
    inputSchema: inputSchema(operation, spec),
    mutation,
    annotations: {
      readOnlyHint: !mutation,
      destructiveHint: mutation,
      idempotentHint: !mutation,
      openWorldHint: false,
    },
  }
})

const decisionForm: Tool = {
  name: "session_dots_decision_form",
  operation: "session.dots.exchange.create",
  description: "Collect an authenticated Dots decision for one currently pending native request listed under a device delegation. Local native services recheck authorization and the decision fingerprint before settlement.",
  inputSchema: object({ sessionID, input: { oneOf: [
    object({ exchangeID: text(256), taskExchangeID: text(256), expectedAttachment: dotsAttachment, targetSessionID: sessionID, channel: { const: "task" }, delivery,
      delegation: object({ id: text(256), revision: integer(1, maxSafeInteger) }, ["id", "revision"]), instruction: object({ operation: { const: "decision" }, target: dotsDecisionTarget }, ["operation", "target"]) },
      ["exchangeID", "taskExchangeID", "expectedAttachment", "targetSessionID", "channel", "delivery", "delegation", "instruction"]),
    object({ exchangeID: text(256), bindingID: text(256), expectedAttachment: dotsAttachment, targetSessionID: sessionID,
      delegation: object({ id: text(256), revision: integer(1, maxSafeInteger) }, ["id", "revision"]), target: dotsDecisionTarget, cursor: text(4096),
    }, ["exchangeID", "bindingID", "expectedAttachment", "targetSessionID", "delegation", "target"]),
  ] } }, ["sessionID", "input"]),
  mutation: true,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}

export const tools: readonly Tool[] = [decisionForm, ...standardTools.flatMap((tool) =>
  tool.operation === "session.createInDirectory"
    ? [...RemoteMcpApps.tools.map((app) => ({ ...app, mutation: !app.annotations.readOnlyHint })), tool]
    : [tool],
)]

function inputSchema(operation: ToolOperation, spec: Spec) {
  if (operation === "usage.forecast") return forecast
  const scoped = operation !== "session.createInDirectory" && requireSession(operation)
  const session = scoped || spec.session === "optional"
  const required = [
    ...(scoped ? ["sessionID"] : []),
    ...(spec.input !== undefined && spec.optional !== true ? ["input"] : []),
  ]
  return object(
    { ...(session ? { sessionID } : {}), ...(spec.input === undefined ? {} : { input: spec.input }) },
    required,
  )
}

export function sessionOf(tool: Tool, args: Record<string, unknown>) {
  if (typeof args.sessionID === "string") return args.sessionID
  const input = recordOf(args.input)
  if (tool.operation.startsWith("provider.auth.")) {
    const target = recordOf(input?.target)
    return typeof target?.sessionID === "string" ? target.sessionID : undefined
  }
  if (tool.operation === "session.create" || tool.operation === "session.createInDirectory")
    return typeof input?.id === "string" ? input.id : undefined
  return undefined
}

export function laneOf(tool: Tool, args: Record<string, unknown>) {
  if (!tool.mutation) return undefined
  if (tool.operation.startsWith("coordination.")) {
    const groupID = recordOf(args.input)?.groupID
    return typeof groupID === "string" ? `coordination:${groupID}` : "backend"
  }
  const session = sessionOf(tool, args)
  return session === undefined ? "backend" : `session:${session}`
}

export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
