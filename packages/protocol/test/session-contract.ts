import { SchemaAST } from "effect"
import { domainLabel, wireContract, isUtcDeclaration, withDomainLiteral } from "./wire-contract.js"
import { enumNumbers, messageTags, reservedLine, wireAllocation, type WireAllocation } from "./wire-allocation.js"
import { middlewareErrors } from "./resources-source.js"
import { resourceContract, resourceFieldConstraints, resourceSourceIdentity } from "./resources-contract.js"
import { platformContract, sharedSet } from "./platform-contract.js"
import { sessionRpcEndpoints } from "./session-source.js"
import { SessionAutonomyState, SessionListBefore, SessionLogItem } from "../src/groups/session.js"
import type { WireField } from "./wire-contract.js"
import { connectorRoles } from "./connector-source.js"

export const sessionIDs = {
  "event.subscribe": 4000,
  "event.unsubscribe": 4001,
  "form.request.list": 4002,
  "generate.text": 4003,
  "permission.request.list": 4004,
  "permission.saved.list": 4005,
  "permission.saved.remove": 4006,
  "question.request.list": 4007,
  "session.active": 4008,
  "session.archive": 4009,
  "session.attachment.read": 4010,
  "session.autonomy.get": 4011,
  "session.autonomy.set": 4012,
  "session.background": 4013,
  "session.command": 4014,
  "session.compact": 4015,
  "session.completions": 4016,
  "session.context": 4017,
  "session.create": 4018,
  "session.daybreak.set": 4019,
  "session.diagnostics": 4020,
  "session.fileChange.list": 4021,
  "session.fork": 4022,
  "session.form.cancel": 4023,
  "session.form.create": 4024,
  "session.form.get": 4025,
  "session.form.list": 4026,
  "session.form.reply": 4027,
  "session.form.state": 4028,
  "session.generate": 4029,
  "session.get": 4030,
  "session.guardrail.request.list": 4031,
  "session.guardrail.request.reply": 4032,
  "session.guardrail.status": 4033,
  "session.instructions.entry.list": 4034,
  "session.instructions.entry.put": 4035,
  "session.instructions.entry.remove": 4036,
  "session.interrupt": 4037,
  "session.list": 4038,
  "session.log": 4039,
  "session.message": 4040,
  "session.messages": 4041,
  "session.move": 4042,
  "session.outstanding": 4043,
  "session.pending.list": 4044,
  "session.permission.create": 4045,
  "session.permission.get": 4046,
  "session.permission.list": 4047,
  "session.permission.reply": 4048,
  "session.pin": 4049,
  "session.prompt": 4050,
  "session.question.list": 4051,
  "session.question.reject": 4052,
  "session.question.reply": 4053,
  "session.remove": 4054,
  "session.rename": 4055,
  "session.resolveSkillConflict": 4056,
  "session.revert.clear": 4057,
  "session.revert.commit": 4058,
  "session.revert.stage": 4059,
  "session.shell": 4060,
  "session.skill": 4061,
  "session.skills": 4062,
  "session.snapshot": 4063,
  "session.subagent.answer": 4064,
  "session.subagent.cancel": 4065,
  "session.subagent.launch": 4066,
  "session.subagent.list": 4067,
  "session.subagent.message": 4068,
  "session.subagent.resume": 4069,
  "session.switchAgent": 4070,
  "session.switchModel": 4071,
  "session.synthetic": 4072,
  "session.todo.list": 4073,
  "session.todo.update": 4074,
  "session.unarchive": 4075,
  "session.unpin": 4076,
  "session.usage": 4077,
  "session.usageReport": 4078,
  "session.wait": 4079,
  "session.capturedInputs": 4080,
  "session.compaction.list": 4081,
  "session.prediction": 4082,
  "session.promptGenerate": 4083,
  "session.promptCosts": 4084,
  "session.taskCosts": 4085,
  "session.review.list": 4086,
  "session.review.decide": 4087,
} as const

export const sessionResultNames = {} as const

export function sessionSourceIdentity(ast: SchemaAST.AST, hint: string): string {
  if (isUtcDeclaration(ast)) return "packages/schema/src/schema.ts#DateTimeUtcFromMillis"
  const name = typeof ast.annotations?.identifier === "string" ? ast.annotations.identifier : hint
  const module = name.split(/[._]/)[0]
  if (module === "ProviderRequest") return resourceSourceIdentity(ast, hint)
  if (name.startsWith("Session.Message.") || name.startsWith("Session_Message_"))
    return `packages/schema/src/session-message.ts#SessionMessage.${name.split(/[._]/)[2]}`
  if (name.startsWith("Session.Event.") || name.startsWith("Session_Event_"))
    return `packages/schema/src/session-event.ts#SessionEvent.${name.split(/[._]/).at(-1)}`
  const cacheNames: Record<string, string> = {
    CacheMechanism: "Mechanism",
    ProviderCacheDiagnostics: "ProviderCache",
    ContextBreakdown: "ContextBreakdown",
    GenerationSpeed: "GenerationSpeed",
    GenerationSpeedHistory: "GenerationSpeedHistory",
    CacheDiagnostics: "Info",
  }
  if (cacheNames[name.split(/[._]/)[1]])
    return `packages/schema/src/session-cache-diagnostics.ts#SessionCacheDiagnostics.${cacheNames[name.split(/[._]/)[1]]}`
  if (module === "InstructionEntryValueTooLargeError")
    return "packages/schema/src/instruction-entry.ts#InstructionEntry.ValueTooLargeError"
  if (name.startsWith("Session.Revert") || name.startsWith("Session_Revert"))
    return "packages/schema/src/session-revert.ts#Revert"
  if (name.startsWith("Form.CreatePayload") || name.startsWith("Form_CreatePayload"))
    return "packages/protocol/src/groups/form.ts#CreatePayload"
  if (name.startsWith("SessionReview.Decide") && !name.startsWith("SessionReview.Decision"))
    return "packages/protocol/src/groups/review.ts#ReviewDecide"
  if (name.startsWith("SessionReview_Decide") && !name.startsWith("SessionReview_Decision"))
    return "packages/protocol/src/groups/review.ts#ReviewDecide"
  if (name.startsWith("Prompt.Mention") || name.startsWith("Prompt_Mention"))
    return "packages/schema/src/prompt.ts#PromptMention"
  if (module.endsWith("Error")) return `packages/protocol/src/errors.ts#${module}`
  if (name === "LocationQuery") return "packages/protocol/src/groups/location.ts#LocationQuery"
  const modules: Record<string, string> = {
    Session: "session",
    SessionMessage: "session-message",
    SessionCompaction: "session-compaction",
    SessionCapturedChanges: "session-captured-changes",
    SessionPending: "session-pending",
    SessionOrchestration: "session-orchestration",
    SessionDelivery: "session-delivery",
    SessionCacheDiagnostics: "session-cache-diagnostics",
    SessionTodo: "session-todo",
    SessionSkillStatus: "session-skill-status",
    SessionWorkCompletion: "session-work-completion",
    PromptInput: "prompt-input",
    Prompt: "prompt",
    InstructionEntry: "instruction-entry",
    Project: "project",
    Event: "event",
    EventLog: "event-log",
    Workspace: "workspace",
    Agent: "agent",
    Skill: "skill",
    Model: "model",
    Location: "location",
    ProviderRequest: "provider-request",
    Form: "form",
    Permission: "permission",
    PermissionSaved: "permission-saved",
    Question: "question",
    Guardrail: "guardrail",
    Money: "money",
    TokenUsage: "token-usage",
    ProviderUsage: "provider-usage",
    Tool: "tool",
    FileDiff: "file-diff",
    Shell: "shell",
    Credential: "credential",
    Integration: "integration",
    Provider: "provider",
    Snapshot: "snapshot",
    UsageAnchor: "usage-anchor",
    UsageAccounting: "usage-accounting",
    UsageForecast: "usage-forecast",
    SessionReview: "session-review",
  }
  if (modules[module])
    return `packages/schema/src/${modules[module]}.ts#${module}.${name.split(/[._]/)[1]?.replace(/Value\d+$/, "") ?? "Info"}`
  if (module === "SourceEpoch") return "packages/schema/src/source-epoch.ts#SourceEpoch"
  if (module === "AttachmentDigest" || module === "Base64") return `packages/schema/src/prompt.ts#${module}`
  if (module.startsWith("Session") || module === "SessionsQuery")
    return "packages/protocol/src/groups/session.ts#makeSessionGroup"
  const operation = sessionRpcEndpoints().find(({ endpoint }) =>
    hint.startsWith(endpoint.identifier.replace(/[^a-zA-Z0-9]/g, "_") + "_"),
  )
  if (!operation) throw new Error(`no session source owner: ${name} (${hint})`)
  const group = operation.group.slice(7)
  return `packages/protocol/src/groups/${group}.ts#${group === "generate" ? "GenerateGroup" : group === "message" ? "MessageGroup" : `make${group[0].toUpperCase() + group.slice(1)}Group`}`
}

export function sessionContract(endpoints = sessionRpcEndpoints(), allocation: WireAllocation = wireAllocation) {
  const contract = wireContract(
    [...endpoints].sort((a, b) => a.endpoint.identifier.localeCompare(b.endpoint.identifier)),
    sessionIDs,
    sessionSourceIdentity,
    middlewareErrors,
    sessionResultNames,
    [SessionLogItem, SessionAutonomyState],
    allocation,
  )
  contract.messages.get("event_subscribe_Request")!.fields.push({
    name: "scope",
    type: "Scope",
    presence: "required",
    constraints: [],
  })
  contract.messages.set("event_unsubscribe_Request", {
    fields: [{ name: "subscription_id", type: "string", presence: "required", constraints: [] }],
    oneof: false,
  })
  contract.messages.set("event_unsubscribe_Result", {
    fields: [{ name: "data", type: "Empty", presence: "required", constraints: [] }],
    oneof: false,
  })
  contract.operations.push({
    id: sessionIDs["event.unsubscribe"],
    name: "event.unsubscribe",
    rpc: "event_unsubscribe",
    group: "server.event",
    request: "event_unsubscribe_Request",
    result: "event_unsubscribe_Result",
    errors: ["UnauthorizedError", "InvalidRequestError"],
    method: "POST",
  })
  contract.operations.sort((a, b) => a.id - b.id)
  contract.enums.set("SessionsQuery_order", ["asc", "desc", "pinned", "active"])
  contract.enums.set("SessionsQuery_status", ["running", "idle", "waiting"])
  contract.enums.set("SessionsQuery_searchFields", ["summary"])
  contract.messages
    .get("SessionsQuery")!
    .fields.push(
      { name: "status", type: "SessionsQuery_status", presence: "optional", constraints: [] },
      { name: "searchFields", type: "SessionsQuery_searchFields", presence: "optional", constraints: [] },
      { name: "around", type: "LosslessString", presence: "optional", constraints: [] },
      {
        name: "before",
        type: "uint64",
        presence: "optional",
        constraints: [],
        ast: SessionListBefore.ast,
        source: "packages/protocol/src/groups/session.ts#SessionListBefore",
      },
    )
  contract.messages
    .get("SessionsResponse")!
    .fields.push(
      { name: "status", type: "Status", presence: "optional", constraints: [] },
      { name: "stale", type: "bool", presence: "optional", constraints: [] },
    )
  contract.messages.get("SessionAutonomyEffective")!.fields[0].type = "SessionAutonomyYolo"
  contract.messages.delete("SessionAutonomyYoloLevel")
  return contract
}

export function sessionPolicy(name: string, method: string) {
  const machine = ["session.list", "session.active", "session.outstanding", "session.completions"].includes(name)
  return {
    scope: name.startsWith("event.")
      ? "GLOBAL"
      : machine
        ? "MACHINE"
        : name === "session.create"
          ? "LOCATION"
          : name.startsWith("session.form.")
            ? "FORM"
            : name.startsWith("session.")
              ? "SESSION"
              : "LOCATION",
    mutation: name === "session.wait" ? "READ" : name.startsWith("event.") || method !== "GET" ? "MUTATION" : "READ",
    settlement: ["session.prompt", "session.command"].includes(name) ? "DURABLY_ADMITTED" : "COMPLETED",
    paging:
      name === "session.usageReport"
        ? "OFFSET"
        : ["session.list", "session.snapshot", "session.subagent.list"].includes(name)
          ? "CURSOR"
          : "UNPAGED",
    streaming: ["event.subscribe", "session.log"].includes(name)
      ? "EVENTS"
      : name === "session.attachment.read"
        ? "ASSET_BULK"
        : name === "event.unsubscribe"
          ? "INLINE"
          : "TYPED_BULK",
    sensitivity: [
      "session.prompt",
      "session.command",
      "session.shell",
      "generate.text",
      "session.generate",
      "session.prediction",
      "session.promptGenerate",
    ].includes(name)
      ? "SECRET"
      : "PRIVATE",
    streamEnd: name === "session.log",
  } as const
}

export function sessionProto(endpoints = sessionRpcEndpoints(), allocation: WireAllocation = wireAllocation) {
  const contract = sessionContract(endpoints, allocation)
  const shared = sharedSet()
  const resources = resourceContract()
  const platform = platformContract()
  for (const name of [...contract.messages.keys(), ...contract.enums.keys()]) {
    if ((resources.messages.has(name) || resources.enums.has(name)) && !shared.has(name))
      throw new Error(`resource-owned declaration is not shared: ${name}`)
    if ((platform.messages.has(name) || platform.enums.has(name)) && !shared.has(name))
      throw new Error(`platform-owned declaration is not shared: ${name}`)
  }
  const fieldOption = (field: WireField) => {
    const entries = Object.entries(resourceFieldConstraints(field)).flatMap(([name, value]) =>
      value === undefined
        ? []
        : Array.isArray(value)
          ? value.map((source) => `domain_obligations: ${JSON.stringify(source)}`)
          : [`${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}: ${JSON.stringify(value)}`],
    )
    return entries.length ? ` [(ycoding.v5.constraints) = { ${entries.join(" ")} }]` : ""
  }
  return (
    (
      'syntax = "proto2";\npackage ycoding.v5;\nimport "ycoding/v5/foundation.proto";\nimport "ycoding/v5/operations.proto";\nimport "ycoding/v5/shared.proto";\n\noption (ycoding.v5.operation_range) = { first: 4000 last: 4087 };\n\n' +
      [...contract.enums]
        .filter(([name]) => !shared.has(name))
        .map(
          ([name, values]) =>
            `enum ${name} {\n${values
              .map(
                (value, index) =>
                  `  ${name.toUpperCase()}_${String(value)
                    .replace(/[^a-zA-Z0-9]/g, "_")
                    .toUpperCase()} = ${enumNumbers(name, values, allocation)[index]}${domainLabel(value)};`,
              )
              .join("\n")}\n${reservedLine("enum", name, allocation)}}`,
        )
        .join("\n\n") +
      "\n\n" +
      [...contract.messages]
        .filter(([name]) => !shared.has(name))
        .map(
          ([name, message]) =>
            `message ${name} {\n${message.oneof ? "  oneof kind {\n" : ""}${message.fields.map((field, index) => `  ${message.oneof ? "  " : ""}${field.presence === "oneof" ? "" : field.presence + " "}${field.type} ${field.name} = ${messageTags(name, message.fields, allocation)[index]}${withDomainLiteral(fieldOption(field), message, field)};`).join("\n")}\n${message.oneof ? "  }\n" : ""}${reservedLine("message", name, allocation)}}`,
        )
        .join("\n\n") +
      "\n\n" +
      [...new Set(contract.operations.map((operation) => operation.group))]
        .map(
          (group) =>
            `service ${group.replace(/[^a-zA-Z0-9]/g, "_")} {\n${contract.operations
              .filter((operation) => operation.group === group)
              .map((operation) => {
                const policy = sessionPolicy(operation.name, operation.method)
                return `  rpc ${operation.rpc}(${operation.request}) returns (${operation.result}) {\n    option (ycoding.v5.operation) = {\n      operation_id: ${operation.id}\n      diagnostic_name: ${JSON.stringify(operation.name)}\n${operation.errors.map((name) => `      error_types: "ycoding.v5.${name}"`).join("\n")}\n      roles: LOCAL_CLIENT\n${operation.name.startsWith("session.form.") ? "      role_scopes: { role: LOCAL_CLIENT scopes: FORM scopes: GLOBAL_FORM }\n" : ""}${connectorRoles(operation.name)}      scope: ${policy.scope}\n      mutation: ${policy.mutation}\n      settlement: ${policy.settlement}\n      paging: ${policy.paging}\n      streaming: ${policy.streaming}\n      sensitivity: ${policy.sensitivity}\n    };\n  }`
              })
              .join("\n")}\n}`,
        )
        .join("\n\n")
    ).trimEnd() + "\n"
  )
}
