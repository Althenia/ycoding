import { describe, expect, test } from "bun:test"
import path from "node:path"
import { messages } from "../src/generated/v5/contract.js"
import { wireAllocation } from "./wire-allocation.js"
import {
  MutationClass,
  operationIDsByRole,
  operations,
  Paging,
  PeerRole,
  publicEvents,
  ScopeKind,
  Sensitivity,
  Settlement,
  Streaming,
} from "../src/v5/index.js"

type Field = { tag: number; name: string; target?: string; maxCount?: number }
const declared = messages as Record<string, { fields: readonly Field[] }>
const message = (name: string) => {
  const found = declared[`ycoding.v5.${name}`]
  if (!found) throw new Error(`missing message ${name}`)
  return found
}
const tags = (name: string) => Object.fromEntries(message(name).fields.map((field) => [field.name, field.tag]))
const target = (name: string, field: string) =>
  message(name)
    .fields.find((candidate) => candidate.name === field)!
    .target!.replace("ycoding.v5.", "")
const operation = (name: string) => {
  const found = operations.find((candidate) => candidate.diagnosticName === name)
  if (!found) throw new Error(`missing operation ${name}`)
  return found
}
const proto = (file: string) => Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5", file)).text()
const enumValues = (source: string, name: string) => {
  const body = source.match(new RegExp(`^enum ${name} \\{\\n([\\s\\S]*?)^\\}`, "m"))
  if (!body) throw new Error(`missing enum ${name}`)
  return Object.fromEntries(
    [...body[1].matchAll(/^\s+(\w+) = (\d+)(?: \[[^\]]*\])?;/gm)].map((match) => [match[1], Number(match[2])]),
  )
}
const errors = (name: string) => [...operation(name).errorTypes].map((type) => type.replace("ycoding.v5.", "")).sort()

describe("Session approval settings", () => {
  test("per-category decision modes replace the Boolean YOLO and rule flags", async () => {
    expect(tags("SessionAutonomyState")).toEqual({
      mode: 1,
      goal: 3,
      defer: 4,
      permissions: 9,
      guardrails: 10,
      answers: 11,
    })
    expect(tags("SessionAutonomySet")).toEqual({
      value_1: 1,
      value_2: 2,
      value_3: 3,
      value_7: 7,
      value_8: 8,
    })
    expect(tags("SessionAutonomySetValue1")).toEqual({ goal: 2, maxNoProgress: 3 })
    expect(tags("SessionAutonomySetValue2")).toEqual({ permissions: 3, guardrails: 4, answers: 5 })
    expect(tags("SessionAutonomySetValue3")).toEqual({ defer: 1 })
    expect(tags("SessionAutonomySetValue7")).toEqual({ permissions: 1, guardrails: 2, answers: 3 })
    expect(tags("SessionAutonomySetValue8")).toEqual({ permissions: 1, guardrails: 2, answers: 3 })
    for (const slot of [4, 5, 6]) expect(declared[`ycoding.v5.SessionAutonomySetValue${slot}`]).toBeUndefined()
    expect(declared["ycoding.v5.SessionAutonomyYolo"]).toBeUndefined()
    const source = await proto("session.proto")
    expect(enumValues(source, "SessionAutonomy_DecisionMode")).toEqual({
      SESSIONAUTONOMY_DECISIONMODE_MANUAL: 1,
      SESSIONAUTONOMY_DECISIONMODE_YOLO: 2,
      SESSIONAUTONOMY_DECISIONMODE_AUTO: 3,
    })
    for (const [name, slots] of [
      ["SessionAutonomyState", "2, 5, 6, 7, 8"],
      ["SessionAutonomyView", "2, 5, 7, 8, 9"],
      ["SessionAutonomyEffective", "1, 4, 5, 6, 7, 8, 9"],
      ["SessionAutonomySetValue1", "1, 4"],
      ["SessionAutonomySetValue2", "1, 2"],
      ["SessionAutonomySet", "4, 5, 6"],
    ] as const)
      expect(source.match(new RegExp(`message ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1]).toContain(`reserved ${slots};`)
  })

  test("the committed beta Set slots 4, 5 and 6 and their rule-flag tags stay retired and are never reused", async () => {
    const committed = {
      oneof: { value_1: 1, value_2: 2, value_3: 3, value_4: 4, value_5: 5, value_6: 6 },
      retired: [
        [4, "SessionAutonomySetValue4", "autoAnswer"],
        [5, "SessionAutonomySetValue5", "autoPermission"],
        [6, "SessionAutonomySetValue6", "autoGuardrail"],
      ] as const,
    }
    const current = tags("SessionAutonomySet")
    for (const [slot, retired, field] of committed.retired) {
      expect(Object.values(current)).not.toContain(slot)
      expect(declared[`ycoding.v5.${retired}`]).toBeUndefined()
      expect(wireAllocation.messages.SessionAutonomySet?.[slot - 1]).toEqual({ reserved: field })
    }
    expect(Object.entries(current).filter(([name]) => name in committed.oneof)).toEqual([
      ["value_1", 1],
      ["value_2", 2],
      ["value_3", 3],
    ])
    expect(tags("SessionAutonomySetValue3")).toEqual({ defer: 1 })
    const source = await proto("session.proto")
    const retiredFields = [...source.matchAll(/^\s+\w+ \w+ (auto(?:Answer|Permission|Guardrail)) = \d+/gm)].map(
      (match) => match[1],
    )
    expect(retiredFields).toEqual([])
  })

  test("autonomy replies carry the per-category modes and effective inheritance", () => {
    for (const name of ["session_autonomy_get_Result", "session_autonomy_set_Result"])
      expect(target(name, "data")).toBe("SessionAutonomyView")
    expect(tags("SessionAutonomyView")).toEqual({
      mode: 1,
      goal: 3,
      defer: 4,
      effective: 6,
      permissions: 10,
      guardrails: 11,
      answers: 12,
    })
    expect(tags("SessionAutonomyEffective")).toEqual({
      deferred: 2,
      guardrailsEnabled: 3,
      permissions: 10,
      guardrails: 11,
      answers: 12,
      inherited: 13,
    })
    expect(tags("SessionAutonomyEffective_inherited")).toEqual({ permissions: 1, guardrails: 2, answers: 3 })
    for (const name of ["SessionAutonomyState", "SessionAutonomyView", "SessionAutonomyEffective"])
      for (const field of ["permissions", "guardrails", "answers"])
        expect(target(name, field)).toBe("SessionAutonomy_DecisionMode")
  })

  test("lost background results retain a separate status identity", () => {
    expect(tags("Status")).toEqual({ running: 1, attention: 2, outstanding: 3, failed: 4, details: 5, lost: 6 })
    expect(target("Status", "lost")).toBe("IdentifierList")
    expect(Object.fromEntries(message("Status").fields.map((field) => [field.name, field.maxCount]))).toEqual({
      running: 500,
      attention: 500,
      outstanding: 500,
      failed: 500,
      details: 500,
      lost: 500,
    })
  })
})

describe("review operations", () => {
  test.each([
    ["session.review.list", 4086, MutationClass.READ],
    ["session.review.decide", 4087, MutationClass.MUTATION],
  ] as const)("%s is Session-scoped for local, remote and relay peers", (name, id, mutation) => {
    const descriptor = operation(name)
    expect(descriptor.operationId).toBe(id)
    expect(descriptor.roles).toEqual([PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY])
    expect(descriptor.roleScopes).toEqual([])
    expect([
      descriptor.scope,
      descriptor.mutation,
      descriptor.settlement,
      descriptor.paging,
      descriptor.streaming,
      descriptor.sensitivity,
    ]).toEqual([
      ScopeKind.SESSION,
      mutation,
      Settlement.COMPLETED,
      Paging.UNPAGED,
      Streaming.TYPED_BULK,
      Sensitivity.PRIVATE,
    ])
  })

  test("declared errors are closed and include the review lookup failure", () => {
    expect(errors("session.review.list")).toEqual(
      ["InvalidRequestError", "SessionNotFoundError", "UnauthorizedError"].sort(),
    )
    expect(errors("session.review.decide")).toEqual(
      [
        "ConflictError",
        "InvalidRequestError",
        "ReviewItemNotFoundError",
        "SessionNotFoundError",
        "UnauthorizedError",
        "UnknownError",
      ].sort(),
    )
    expect(tags("ReviewItemNotFoundError")).toEqual({ _tag: 1, itemID: 2, message: 3 })
  })

  test("request and result wrappers carry the Session and item identity", () => {
    expect(tags("session_review_list_Request")).toEqual({ params: 1 })
    expect(tags("session_review_list_Request_params")).toEqual({ sessionID: 1 })
    expect(tags("session_review_list_Result")).toEqual({ data: 1 })
    expect(tags("session_review_decide_Request")).toEqual({ params: 1, payload: 2 })
    expect(tags("session_review_decide_Request_params")).toEqual({ sessionID: 1, itemID: 2 })
    expect(tags("SessionReview_Decide")).toEqual({ decision: 1 })
    expect(target("session_review_decide_Request", "payload")).toBe("SessionReview_Decide")
    expect(tags("session_review_decide_Result")).toEqual({ data: 1 })
  })

  test("the Session operation range retains current operations and excludes retired Dots controls", () => {
    const ids = operations
      .map((descriptor) => descriptor.operationId)
      .filter((id) => id >= 4000 && id <= 4999)
      .sort((a, b) => a - b)
    expect(ids).toEqual([...Array.from({ length: 90 }, (_, index) => 4000 + index), 4102])
    expect(ids.filter((id) => id >= 4090 && id <= 4101)).toEqual([])
    expect(operation("session.subagent.switchModel").operationId).toBe(4089)
    expect(
      [
        "targets",
        "status",
        "bind",
        "unbind",
        "send",
        "pause",
        "resume",
        "exchange.create",
        "exchange.read",
        "delegation.status",
        "delegation.create",
        "delegation.revoke",
      ].map((name) => operations.find((item) => item.diagnosticName === `session.dots.${name}`)),
    ).toEqual(Array(12).fill(undefined))
    expect(operation("session.promptCosts").operationId).toBe(4084)
    expect(operation("session.taskCosts").operationId).toBe(4085)
    expect(operation("providerUsage.forecast").operationId).toBe(2063)
  })

  test("the current inventory retains review, incident, fixed demos and apps without raw relay MCP", () => {
    expect(operations).toHaveLength(257)
    expect(operationIDsByRole[PeerRole.LOCAL_CLIENT]).toHaveLength(238)
    expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).toHaveLength(94)
    expect(operationIDsByRole[PeerRole.RELAY]).toHaveLength(90)
    expect(operations.filter((item) => item.operationId >= 2000 && item.operationId <= 2083).map((item) => item.operationId))
      .toEqual(Array.from({ length: 84 }, (_, index) => 2000 + index))
    expect(operations.filter((item) => item.operationId >= 2073 && item.operationId <= 2083).map((item) => [item.operationId, item.diagnosticName, item.roles]))
      .toEqual([
        [2073, "credential.refresh", [PeerRole.LOCAL_CLIENT]],
        [2074, "dots.detach", [PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY]],
        [2075, "dots.remove", [PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY]],
        [2076, "dots.threads", [PeerRole.LOCAL_CLIENT]],
        [2077, "dots.task.updates", [PeerRole.LOCAL_CLIENT]],
        [2078, "dots.thread.read", [PeerRole.LOCAL_CLIENT]],
        [2079, "dots.thread.send", [PeerRole.LOCAL_CLIENT]],
        [2080, "dots.thread.interrupt", [PeerRole.LOCAL_CLIENT]],
        [2081, "dots.resume", [PeerRole.LOCAL_CLIENT]],
        [2082, "dots.thread.requests", [PeerRole.LOCAL_CLIENT]],
        [2083, "dots.thread.respond", [PeerRole.LOCAL_CLIENT]],
      ])
    expect(operation("provider.auth.refresh")).toMatchObject({ operationId: 5053, roles: [PeerRole.REMOTE_CLIENT, PeerRole.RELAY] })
    expect(operations.some((item) => item.diagnosticName === "mcp.request")).toBe(false)
  })

  test("web latency values append the two review operations after the usage values and the incident values after them", async () => {
    const values = enumValues(await proto("platform.proto"), "Telemetry_RequestSample_operation")
    const prefix = "TELEMETRY_REQUESTSAMPLE_OPERATION_"
    expect(values[`${prefix}USAGE_FORECAST`]).toBe(70)
    expect(values[`${prefix}SESSION_REVIEW_LIST`]).toBe(71)
    expect(values[`${prefix}SESSION_REVIEW_DECIDE`]).toBe(72)
    expect(
      [
        "INCIDENT_REPORT",
        "INCIDENT_RECENT",
        "INCIDENT_GUIDANCE",
        "INCIDENT_GUIDANCE_GET",
        "INCIDENT_GUIDANCE_CLEAR",
      ].map((name) => values[`${prefix}${name}`]),
    ).toEqual([73, 74, 75, 76, 77])
    expect(
      [
        "COORDINATION_SETTINGS",
        "COORDINATION_LIST",
        "COORDINATION_CREATE",
        "COORDINATION_GET",
        "COORDINATION_UPDATE",
        "COORDINATION_DELETE",
        "SESSION_DELETE",
      ].map((name) => values[`${prefix}${name}`]),
    ).toEqual([86, 87, 88, 89, 90, 91, 92])
    expect(
      [
        "TARGETS",
        "STATUS",
        "BIND",
        "UNBIND",
        "SEND",
        "PAUSE",
        "RESUME",
        "EXCHANGE_CREATE",
        "EXCHANGE_READ",
        "DELEGATION_STATUS",
        "DELEGATION_CREATE",
        "DELEGATION_REVOKE",
      ].map((name) => values[`${prefix}SESSION_DOTS_${name}`]),
    ).toEqual(Array(12).fill(undefined))
    expect(
      ["DOTS_GET", "DOTS_SET", "USAGE_DASHBOARD", "DOTS_ATTACH"].map((name) => values[`${prefix}${name}`]),
    ).toEqual([105, 106, 107, 108])
    expect(
      ["PROVIDER_AUTH_REFRESH", "DOTS_DETACH", "DOTS_REMOVE", "SESSION_FORK"].map((name) => values[`${prefix}${name}`]),
    ).toEqual([109, 110, 111, 112])
  })
})

describe("public events", () => {
  const entry = (name: string) => publicEvents.find((event) => event.name === name)

  test("the inventory appends nine branches and seven durable events without reusing retired tag 116", () => {
    expect(publicEvents).toHaveLength(137)
    expect(publicEvents.filter((event) => event.durable)).toHaveLength(74)
    expect(new Set(publicEvents.map((event) => event.tag)).size).toBe(137)
    expect(Math.max(...publicEvents.map((event) => event.tag))).toBe(138)
    expect(entry("provider.quota.pace")).toMatchObject({ tag: 117, durable: false })
    expect(entry("session.tool.progress")).toMatchObject({ tag: 51, durable: false })
  })

  test("deadline and deferral branches are live-only and follow the frozen order", () => {
    const live = [
      [102, "question.timed_out"],
      [103, "form.timed_out"],
      [112, "permission.deferred"],
      [113, "guardrail.deferred"],
      [114, "question.deferred"],
      [115, "form.deferred"],
    ] as const
    for (const [tag, name] of live)
      expect<unknown>(entry(name), name).toEqual({
        name,
        durable: false,
        tag,
        type: `ycoding.v5.PublicEvent_${name.replace(/[^a-zA-Z0-9]/g, "_")}`,
      })
  })

  test("guardrail, review and reroute events are durable and reuse the appended log slots", () => {
    const durable = [
      [104, 53, "session.guardrail.dismissed"],
      [105, 54, "session.guardrail.escalated"],
      [106, 55, "session.guardrail.decided"],
      [107, 56, "session.review.deferred"],
      [108, 57, "session.review.decided"],
      [109, 58, "session.review.withdrawn"],
      [110, 59, "session.review.consumed"],
      [111, 60, "session.step.rerouted"],
      [118, 61, "session.decision.audited"],
      [119, 62, "session.permission.assessed"],
    ] as const
    for (const [tag, slot, name] of durable)
      expect<unknown>(entry(name), name).toEqual({
        name,
        durable: true,
        tag,
        type: `ycoding.v5.SessionLogItemValue${slot}`,
      })
  })

  test("the log union keeps log.synced and the reserved slot and appends thirteen members", async () => {
    const log = tags("SessionLogItem")
    expect(Object.keys(log)).toHaveLength(71)
    expect(Math.max(...Object.values(log))).toBe(72)
    expect(Object.values(log)).not.toContain(40)
    expect(log.value_52).toBe(52)
    expect(await proto("session.proto")).toMatch(/message SessionLogItem \{[\s\S]*?\n  reserved 40;\n\}/)
  })

  test.each([
    ["SessionLogItemValue53", ["sessionID", "reviewSessionID", "ruleID", "confidence", "source"]],
    [
      "SessionLogItemValue54",
      ["sessionID", "requestID", "choice", "confidence", "grades", "ruleIDs", "source", "reason", "authority"],
    ],
    [
      "SessionLogItemValue55",
      [
        "sessionID",
        "reviewSessionID",
        "requestID",
        "reply",
        "choice",
        "grades",
        "confidence",
        "ruleIDs",
        "source",
        "authority",
        "actor",
        "coordinatorSessionID",
        "groupID",
        "rationale",
      ],
    ],
    [
      "SessionLogItemValue56",
      ["sessionID", "itemID", "kind", "reason", "choice", "confidence", "grades", "origin", "payload"],
    ],
    ["SessionLogItemValue57", ["sessionID", "itemID", "decision", "source"]],
    ["SessionLogItemValue58", ["sessionID", "itemID", "reason"]],
    ["SessionLogItemValue59", ["sessionID", "itemID"]],
    ["SessionLogItemValue60", ["sessionID", "assistantMessageID", "model", "error"]],
    [
      "SessionLogItemValue61",
      [
        "sessionID",
        "purpose",
        "authority",
        "agent",
        "model",
        "route",
        "outcome",
        "reason",
        "fingerprint",
        "invocationKey",
        "attempts",
        "answers",
      ],
    ],
    [
      "SessionLogItemValue62",
      [
        "sessionID",
        "requestID",
        "outcome",
        "via",
        "reply",
        "authority",
        "reason",
        "choice",
        "confidence",
        "grades",
        "source",
        "actor",
        "coordinatorSessionID",
        "groupID",
        "rationale",
      ],
    ],
  ] as const)("%s preserves its published data field allocations", (envelope, fields) => {
    expect(tags(envelope).data).toBe(8)
    const data = tags(target(envelope, "data"))
    expect(Object.keys(data).sort()).toEqual([...fields].sort())
    expect(fields.map((field) => data[field])).toEqual(fields.map((_, index) => index + 1))
  })

  test.each([
    ["question.timed_out", ["sessionID", "requestID"]],
    ["form.timed_out", ["id", "sessionID"]],
    ["permission.deferred", ["sessionID", "requestID", "itemID"]],
    ["guardrail.deferred", ["rootSessionID", "sessionID", "requestID", "itemID"]],
    ["question.deferred", ["sessionID", "requestID", "itemID"]],
    ["form.deferred", ["id", "sessionID", "itemID"]],
  ] as const)("%s carries its data fields in declaration order", (name, fields) => {
    const envelope = `PublicEvent_${name.replace(/[^a-zA-Z0-9]/g, "_")}`
    expect(tags(envelope).data).toBe(7)
    expect(Object.keys(tags(target(envelope, "data")))).toEqual([...fields])
  })
})

describe("appended additions to existing declarations", () => {
  test("task changes retain timeout at 12 and resume at 13, then append supervising at 14", async () => {
    const change = tags("SessionLogItemValue24_data_change")
    expect(change).toEqual(Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`value_${index + 1}`, index + 1])))
    const source = await proto("session.proto")
    expect(enumValues(source, "SessionLogItemValue24_data_changeValue11_type")).toEqual({
      SESSIONLOGITEMVALUE24_DATA_CHANGEVALUE11_TYPE_LOST: 1,
    })
    expect(Object.keys(enumValues(source, "SessionLogItemValue24_data_changeValue12_type"))).toEqual([
      "SESSIONLOGITEMVALUE24_DATA_CHANGEVALUE12_TYPE_QUESTION_TIMED_OUT",
    ])
    expect(Object.keys(enumValues(source, "SessionLogItemValue24_data_changeValue13_type"))).toEqual([
      "SESSIONLOGITEMVALUE24_DATA_CHANGEVALUE13_TYPE_RESUMED",
    ])
    expect(enumValues(source, "SessionLogItemValue24_data_changeValue14_type")).toEqual({
      SESSIONLOGITEMVALUE24_DATA_CHANGEVALUE14_TYPE_SUPERVISING: 1,
    })
    expect(tags("SessionLogItemValue24_data_changeValue12")).toEqual({ type: 1, questionID: 2 })
    expect(tags("SessionLogItemValue24_data_changeValue13")).toEqual({ type: 1 })
    expect(tags("SessionLogItemValue24_data_changeValue14")).toEqual({ type: 1 })
  })

  test("form states append the timed-out and deferred states", () => {
    expect(tags("Form_State")).toEqual({ value_1: 1, value_2: 2, value_3: 3, value_4: 4, value_5: 5 })
    expect(tags("Form_StateValue4")).toEqual({ status: 1, seconds: 2 })
    expect(tags("Form_StateValue5")).toEqual({ status: 1, itemID: 2 })
  })

  test("autonomy keeps the empty defer marker and its setter alternative at the former sleep tags", async () => {
    expect(target("SessionAutonomyState", "defer")).toBe("SessionAutonomyDefer")
    expect(target("SessionAutonomyView", "defer")).toBe("SessionAutonomyDefer")
    expect(tags("SessionAutonomyDefer")).toEqual({})
    expect(declared["ycoding.v5.SessionAutonomySleep"]).toBeUndefined()
    expect(tags("KeepAwake_Status").deferHold).toBe(5)
    const source = await proto("session.proto")
    expect(enumValues(source, "SessionReview_Reason")).toMatchObject({
      SESSIONREVIEW_REASON_SLEEP_ENTRY: 8,
      SESSIONREVIEW_REASON_DEFER_ENTRY: 18,
    })
    expect(enumValues(source, "SessionLogItemValue58_data_reason")).toEqual({
      SESSIONLOGITEMVALUE58_DATA_REASON_REVERTED: 1,
      SESSIONLOGITEMVALUE58_DATA_REASON_TASK_CLOSED: 2,
      SESSIONLOGITEMVALUE58_DATA_REASON_AUTONOMY: 3,
    })
    expect(tags("SessionAutonomySetValue3")).toEqual({ defer: 1 })
  })

  test("decision audit and permission assessment answers keep bounded typed fields", async () => {
    expect(target("SessionLogItemValue61_data", "answers")).toBe("SessionLogItemValue61_data_answers")
    expect(tags("SessionLogItemValue61_data_answersItem")).toEqual({
      name: 1,
      type: 2,
      confidence: 3,
      answer: 4,
      choice: 5,
      score: 6,
      length: 7,
    })
    const source = await proto("session.proto")
    expect(Object.values(enumValues(source, "Guardrail_Authority"))).toEqual([1, 2])
    expect(enumValues(source, "Guardrail_DecisionChoice")).toMatchObject({
      GUARDRAIL_DECISIONCHOICE_APPROVE_ALL: 1,
      GUARDRAIL_DECISIONCHOICE_APPROVE: 2,
      GUARDRAIL_DECISIONCHOICE_REJECT: 3,
      GUARDRAIL_DECISIONCHOICE_ESCALATE: 4,
      GUARDRAIL_DECISIONCHOICE_ALLOW: 5,
      GUARDRAIL_DECISIONCHOICE_DENY: 6,
    })
  })

  test("assessment provenance appends authority and permission escalation", () => {
    expect(tags("Guardrail_Escalation")).toEqual({ choice: 1, confidence: 2, grades: 3, reason: 4, authority: 5 })
    expect(target("Guardrail_Escalation", "authority")).toBe("Guardrail_Authority")
    expect(tags("Guardrail_Status_decisionsItem")).toMatchObject({ source: 9, authority: 10 })
    for (const name of ["Permission_Request", "PublicEvent_permission_asked_data"]) {
      expect(tags(name)).toMatchObject({ source: 7, escalation: 8 })
      expect(target(name, "escalation")).toBe("Guardrail_Escalation")
    }
  })

  test("guardrail requests append the escalation after their metadata", () => {
    for (const name of ["Guardrail_Request", "PublicEvent_guardrail_asked_data"]) {
      const fields = tags(name)
      expect([fields.metadata, fields.escalation]).toEqual([11, 12])
    }
  })

  test("guardrail replies and status append their decision provenance", () => {
    expect(tags("PublicEvent_guardrail_replied_data")).toEqual({
      rootSessionID: 1,
      sessionID: 2,
      requestID: 3,
      reply: 4,
      decidedBy: 5,
      choice: 6,
      confidence: 7,
      grades: 8,
      authority: 9,
    })
    expect(tags("Guardrail_Status")).toMatchObject({ invalidFiles: 7, dismissals: 8, decisions: 9 })
  })

  test("managed-task, question and assistant messages append their review and reroute fields", () => {
    expect(tags("SessionOrchestration_Question")).toEqual({ id: 1, text: 2, data: 3, time: 4, deferred: 5 })
    expect(tags("SessionOrchestration_Task")).toMatchObject({ pinnedAt: 12, stoppedRecovery: 13 })
    expect(tags("SessionOrchestration_Task_stoppedRecovery")).toEqual({ itemID: 1 })
    expect(tags("Session_Message_Assistant")).toMatchObject({ retry: 15, reroutes: 16 })
    expect(tags("Session_Message_Assistant_Reroute")).toEqual({ from: 1, model: 2, error: 3 })
  })
})
