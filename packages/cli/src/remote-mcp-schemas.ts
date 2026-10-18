export * as RemoteMcpSchemas from "./remote-mcp-schemas"

import { remoteOperationAccess, requireSession, type RemoteOperation } from "@ycoding-ai/remote"

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

type Spec = { readonly description: string; readonly input?: Schema; readonly optional?: true; readonly session?: "optional" }

const maxSafeInteger = Number.MAX_SAFE_INTEGER

const text = (maxLength: number, minLength = 1): Schema => ({ type: "string", minLength, maxLength })
const nonblank = (maxLength: number): Schema => ({ type: "string", minLength: 1, maxLength, pattern: "^[\\s\\S]*\\S[\\s\\S]*$" })
const line = (maxLength: number): Schema => ({
  type: "string",
  minLength: 1,
  maxLength,
  pattern: "^[^\\u0000\\r\\n]*\\S[^\\u0000\\r\\n]*$",
})
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
const reply = choice("once", "always", "reject")
const delivery = choice("steer", "queue")
const maxNoProgress = { anyOf: [integer(0, 1_000), { type: "null" }] }

const model = object(
  { providerID: text(128), id: text(128), variant: text(128), profile: text(128) },
  ["providerID", "id"],
)
const mention = object({ start: integer(0, 1_000_000), end: integer(0, 1_000_000), text: text(1_024, 0) }, ["start", "end", "text"])
const files = array(
  object({ uri: text(2_048), name: text(256), description: text(1_024), mention }, ["uri"]),
  0,
  64,
)
const agents = array(object({ name: text(256), mention }, ["name"]), 0, 64)
const formAnswer: Schema = {
  type: "object",
  additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }, boolean, { type: "array", items: { type: "string" } }] },
}

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

const usageReport = object(
  {
    group: choice("model", "hour", "day", "month", "session", "project", "agent", "provider", "provider-profile-model", "provider-model", "model-id", "profile", "prompt", "task"),
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

const reviewDecision: Schema = {
  oneOf: [
    object({ kind: choice("question", "subagent_question"), dismissed: { const: true } }, ["kind", "dismissed"]),
    object({ kind: { const: "recovery" }, choice: choice("continue", "stop") }, ["kind", "choice"]),
    object({ kind: choice("guardrail", "permission"), reply }, ["kind", "reply"]),
    object(
      { kind: { const: "question" }, answers: { anyOf: [array(array({ type: "string" }, 0, maxSafeInteger), 0, maxSafeInteger), formAnswer] } },
      ["kind", "answers"],
    ),
    object({ kind: { const: "subagent_question" }, text: text(65_536), data: {} }, ["kind", "text"]),
  ],
}

const autonomy: Schema = {
  oneOf: [
    object({ autoAnswer: boolean }, ["autoAnswer"]),
    object({ yolo: { anyOf: [integer(0, 2), boolean] }, maxNoProgress }, ["yolo"]),
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
      if: { properties: { input: { properties: { localScope: { const: "location" } }, required: ["localScope"] } }, required: ["input"] },
      then: { required: ["sessionID"] },
      else: { not: { required: ["sessionID"] } },
    },
  ],
} as const

const specs = {
  "provider.auth.list": {
    description: "List the provider integrations, connection labels and connection methods available at a Session or workspace target.",
    input: object({ target: providerTarget }, ["target"]),
  },
  "provider.auth.key": {
    description: "Store a provider API key for a target. Persistent credential change; the key is never returned.",
    input: providerInput({ label: line(128), key: line(8_192) }, ["label", "key"]),
  },
  "provider.auth.begin": {
    description: "Begin a provider connection attempt for a target and return its attempt ID and instructions.",
    input: providerInput({ methodID: line(128), label: line(128), inputs: { type: "object", maxProperties: 32, propertyNames: line(128), additionalProperties: text(2_048, 0) } }, ["methodID", "label", "inputs"]),
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
    description: "List the workspaces (recorded project directories) on this machine. Pass sessionsOnly to list only workspaces that hold Sessions.",
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
  "session.messages": { description: "Read a Session's full projected transcript." },
  "session.capturedChanges.list": {
    description: "Page through the file changes a Session and its subagents captured.",
    input: object({ cursor: text(256) }),
    optional: true,
  },
  "session.compaction.list": { description: "Read a Session's compaction history." },
  "session.compact": {
    description: "Compact a Session's context. Returns when compaction settles, which can take minutes. The client supplies the compaction ID.",
    input: object({ id: prefixed("^cmp_[A-Za-z0-9_-]+$", 128) }, ["id"]),
  },
  "session.snapshot": {
    description: "Read a Session's transcript snapshot. Pass limit (and before from a previous result) to page older history.",
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
    description: "Answer a question a managed subagent asked. Send only the answer the user authorized.",
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
      { id: messageID, text: text(32_768, 0), files, agents, skills: array(nonblank(128), 0, 200), delivery, resume: boolean },
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
    input: object({ mode: choice("start", "steer", "queue", "goal"), intent: nonblank(4_000), memory }, ["mode", "intent", "memory"]),
  },
  "session.permission.list": { description: "List a Session's pending permission requests." },
  "session.permission.reply": {
    description:
      "Answer a pending permission request: once approves this request, always persists the approval, reject refuses. Send only the decision the user authorized.",
    input: object({ requestID: prefixed("^per_[A-Za-z0-9_-]+$", 128), reply, message: text(1_024, 0) }, ["requestID", "reply"]),
  },
  "session.guardrail.status": { description: "Read a Session's guardrail review status." },
  "session.guardrail.request.list": { description: "List a Session family's pending guardrail reviews." },
  "session.guardrail.reply": {
    description:
      "Answer a pending guardrail review: once approves this action, always persists a directory-scoped approval, reject refuses. Send only the decision the user authorized.",
    input: object({ requestID: prefixed("^grq_[A-Za-z0-9_-]+$", 128), reply }, ["requestID", "reply"]),
  },
  "session.review.list": { description: "List the open review items of a Session's family, including deferred ones." },
  "session.review.decide": {
    description:
      "Decide an open review item with the decision kind it requires: answer or dismiss a question, once/always/reject a guardrail or permission, or continue/stop a recovery. Send only the decision the user authorized.",
    input: object({ itemID: prefixed("^rvw_[A-Za-z0-9_-]+$", 128), decision: reviewDecision }, ["itemID", "decision"]),
  },
  "session.form.list": { description: "List a Session's pending forms and questions." },
  "session.form.reply": {
    description: "Answer a pending form with the values the user supplied.",
    input: object({ formID: prefixed("^frm_[A-Za-z0-9_-]+$", 64), answer: formAnswer }, ["formID", "answer"]),
  },
  "session.form.cancel": {
    description: "Cancel a pending form.",
    input: object({ formID: prefixed("^frm_[A-Za-z0-9_-]+$", 64) }, ["formID"]),
  },
  "session.shell.output": {
    description: "Read a page of a shell's output. Pass the returned cursor to continue.",
    input: object({ shellID, cursor: integer(0, maxSafeInteger), limit: integer(1, 65_536) }, ["shellID"]),
  },
  "session.autonomy.get": { description: "Read a Session's autonomy settings (YOLO level, sleep, auto-answer, goal)." },
  "session.autonomy.set": {
    description:
      "Change a Session's autonomy: yolo 0 asks first, 1 auto-approves tool permissions, 2 also auto-approves ordinary guardrail reviews; sleep and autoAnswer are separate settings. Grants standing authority; send only what the user authorized.",
    input: autonomy,
  },
  "session.goal.set": {
    description: "Set a Session's goal and optionally its no-progress budget. The Session then continues autonomously toward the goal.",
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
    input: object({ id: sessionID, workspace: text(128), agent: text(128), model }, ["id", "workspace"]),
  },
  "session.status": { description: "Read which root Sessions are running, need attention, or failed." },
  "session.catalog": { description: "List the agents, models, commands, skills, references and resources available to a Session." },
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
    input: object({ id: messageID, command: text(256), arguments: text(8_192, 0), files, agents, delivery }, ["command"]),
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
  "session.usageReport": { description: "Read a usage report for one Session's tree grouped by the chosen dimension.", input: usageReport },
  "session.promptCosts": {
    description: "Read the cost of up to 100 prompts of a Session by prompt message ID.",
    input: object({ inputIDs: array(messageID, 1, 100, true) }, ["inputIDs"]),
  },
  "session.taskCosts": {
    description: "Read the cost of up to 100 task Sessions of a Session's tree by Session ID.",
    input: object({ sessionIDs: array(sessionID, 1, 100, true) }, ["sessionIDs"]),
  },
  "usage.forecast": {
    description: "Read a usage forecast: localScope backend needs no sessionID; location needs the sessionID whose Location it covers.",
  },
  "incident.report": {
    description: "Read the backend's model incident report grouped by model or agent.",
    input: object({ group: choice("model", "agent"), from: integer(0, maxSafeInteger), to: integer(0, maxSafeInteger), offset: integer(0, maxSafeInteger), limit: integer(1, 200) }, ["group"]),
  },
  "incident.recent": {
    description: "Read recent incidents of one model.",
    input: object({ provider: text(128), model: text(128), agent: text(128), limit: integer(1, 50) }, ["provider", "model"]),
  },
  "incident.guidance": {
    description: "Read the guardrail guidance derived for a model. Pass sessionID to resolve the capability at that Session's Location.",
    input: object({ provider: text(128), model: text(128) }, ["provider", "model"]),
    session: "optional",
  },
  "incident.guidance.clear": {
    description: "Clear the guardrail guidance for a model. Pass sessionID to resolve the capability at that Session's Location.",
    input: object({ provider: text(128), model: text(128) }, ["provider", "model"]),
    session: "optional",
  },
  "machine.keepAwake.get": { description: "Read whether this machine is held awake for running Sessions." },
  "machine.keepAwake.set": {
    description: "Turn the machine keep-awake hold on or off.",
    input: object({ enabled: boolean }, ["enabled"]),
  },
  "session.createInDirectory": {
    description:
      "Create a root Session in an existing directory strictly below the machine owner's home directory, given as an absolute path. The client must supply input.id; retry an uncertain create with the same id and directory. Missing paths, the home directory itself, and paths outside home (including via symlinks) are refused; no directory is created.",
    input: object({ id: sessionID, directory: text(4_096), agent: text(128), model }, ["id", "directory"]),
  },
} as const satisfies Record<ToolOperation, Spec>

export function toolName(operation: string) {
  return operation.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[.-]/g, "_").toLowerCase()
}

export const tools: readonly Tool[] = (Object.entries(specs) as [ToolOperation, Spec][]).map(([operation, spec]) => {
  const mutation = operation === "session.createInDirectory" || remoteOperationAccess[operation] === "mutation"
  return {
    name: toolName(operation),
    operation,
    description: spec.description,
    inputSchema: inputSchema(operation, spec),
    mutation,
    annotations: { readOnlyHint: !mutation, destructiveHint: mutation, idempotentHint: !mutation, openWorldHint: false },
  }
})

function inputSchema(operation: ToolOperation, spec: Spec) {
  if (operation === "usage.forecast") return forecast
  const scoped = operation !== "session.createInDirectory" && requireSession(operation)
  const session = scoped || spec.session === "optional"
  const required = [...(scoped ? ["sessionID"] : []), ...(spec.input !== undefined && spec.optional !== true ? ["input"] : [])]
  return object({ ...(session ? { sessionID } : {}), ...(spec.input === undefined ? {} : { input: spec.input }) }, required)
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
  const session = sessionOf(tool, args)
  return session === undefined ? "backend" : `session:${session}`
}

export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
