import { describe, expect, test } from "bun:test"
import path from "node:path"
import { messages } from "../src/generated/v5/contract.js"
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

type Field = { tag: number; name: string; target?: string }
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
  return Object.fromEntries([...body[1].matchAll(/^\s+(\w+) = (\d+);/gm)].map((match) => [match[1], Number(match[2])]))
}
const errors = (name: string) => [...operation(name).errorTypes].map((type) => type.replace("ycoding.v5.", "")).sort()

describe("Session approval settings", () => {
  test("auto-answer has distinct state and mutation fields without reusing YOLO 3", async () => {
    expect(tags("SessionAutonomyState")).toEqual({ mode: 1, yolo: 2, goal: 3, sleep: 4, autoAnswer: 5 })
    expect(tags("SessionAutonomySet")).toEqual({ value_1: 1, value_2: 2, value_3: 3, value_4: 4 })
    expect(tags("SessionAutonomySetValue4")).toEqual({ autoAnswer: 1 })
    expect(tags("SessionAutonomyYolo")).toEqual({ value_1: 1, value_2: 2, value_3: 3 })
    expect((await proto("session.proto")).match(/message SessionAutonomyYolo \{([\s\S]*?)\n\}/)?.[1]).toContain(
      "reserved 4;",
    )
  })

  test("autonomy replies carry the effective approval policy", () => {
    for (const name of ["session_autonomy_get_Result", "session_autonomy_set_Result"])
      expect(target(name, "data")).toBe("SessionAutonomyView")
    expect(tags("SessionAutonomyView")).toEqual({ mode: 1, yolo: 2, goal: 3, sleep: 4, autoAnswer: 5, effective: 6 })
    expect(tags("SessionAutonomyEffective")).toEqual({
      yolo: 1,
      asleep: 2,
      guardrailsEnabled: 3,
      ordinaryReviewsAuto: 4,
      modelReviews: 5,
      hardModelReviews: 6,
    })
  })

  test("lost background results retain a separate status identity", () => {
    expect(tags("Status")).toEqual({ running: 1, attention: 2, outstanding: 3, failed: 4, details: 5, lost: 6 })
    expect(target("Status", "lost")).toBe("IdentifierList")
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

  test("the Session operation range stays contiguous through 4087 and keeps the usage allocations", () => {
    const ids = operations
      .map((descriptor) => descriptor.operationId)
      .filter((id) => id >= 4000 && id <= 4999)
      .sort((a, b) => a - b)
    expect(ids).toEqual(Array.from({ length: 88 }, (_, index) => 4000 + index))
    expect(operation("session.promptCosts").operationId).toBe(4084)
    expect(operation("session.taskCosts").operationId).toBe(4085)
    expect(operation("providerUsage.forecast").operationId).toBe(2063)
  })

  test("the current inventory grows by the two review operations and the four incident operations", () => {
    expect(operations).toHaveLength(231)
    expect(operationIDsByRole[PeerRole.LOCAL_CLIENT]).toHaveLength(213)
    expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).toHaveLength(79)
    expect(operationIDsByRole[PeerRole.RELAY]).toHaveLength(75)
  })

  test("web latency values append the two review operations after the usage values and the incident values after them", async () => {
    const values = enumValues(await proto("platform.proto"), "Telemetry_RequestSample_operation")
    const prefix = "TELEMETRY_REQUESTSAMPLE_OPERATION_"
    expect(Object.keys(values)).toHaveLength(77)
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
  })
})

describe("public events", () => {
  const entry = (name: string) => publicEvents.find((event) => event.name === name)

  test("the inventory is 116 branches, 58 durable, with the old numbering intact", () => {
    expect(publicEvents).toHaveLength(116)
    expect(publicEvents.filter((event) => event.durable)).toHaveLength(58)
    expect(new Set(publicEvents.map((event) => event.tag)).size).toBe(116)
    expect(Math.max(...publicEvents.map((event) => event.tag))).toBe(116)
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
    ] as const
    for (const [tag, slot, name] of durable)
      expect<unknown>(entry(name), name).toEqual({
        name,
        durable: true,
        tag,
        type: `ycoding.v5.SessionLogItemValue${slot}`,
      })
  })

  test("the log union keeps log.synced and the reserved slot and appends eight members", async () => {
    const log = tags("SessionLogItem")
    expect(Object.keys(log)).toHaveLength(59)
    expect(Math.max(...Object.values(log))).toBe(60)
    expect(Object.values(log)).not.toContain(40)
    expect(log.value_52).toBe(52)
    expect(await proto("session.proto")).toMatch(/message SessionLogItem \{[\s\S]*?\n  reserved 40;\n\}/)
  })

  test.each([
    ["SessionLogItemValue53", ["sessionID", "reviewSessionID", "ruleID", "confidence", "source"]],
    ["SessionLogItemValue54", ["sessionID", "requestID", "choice", "confidence", "grades", "ruleIDs", "source"]],
    [
      "SessionLogItemValue55",
      ["sessionID", "reviewSessionID", "requestID", "reply", "choice", "grades", "confidence", "ruleIDs", "source"],
    ],
    [
      "SessionLogItemValue56",
      ["sessionID", "itemID", "kind", "reason", "choice", "confidence", "grades", "origin", "payload"],
    ],
    ["SessionLogItemValue57", ["sessionID", "itemID", "decision"]],
    ["SessionLogItemValue58", ["sessionID", "itemID", "reason"]],
    ["SessionLogItemValue59", ["sessionID", "itemID"]],
    ["SessionLogItemValue60", ["sessionID", "assistantMessageID", "model", "error"]],
  ] as const)("%s carries its data fields in declaration order", (envelope, fields) => {
    expect(tags(envelope).data).toBe(8)
    const data = tags(target(envelope, "data"))
    expect(Object.keys(data)).toEqual([...fields])
    expect(Object.values(data)).toEqual(fields.map((_, index) => index + 1))
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
  test("task changes append the timed-out question at 12 and the restart resume at 13", async () => {
    const change = tags("SessionLogItemValue24_data_change")
    expect(Object.keys(change)).toHaveLength(13)
    expect([change.value_11, change.value_12, change.value_13]).toEqual([11, 12, 13])
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
    expect(tags("SessionLogItemValue24_data_changeValue12")).toEqual({ type: 1, questionID: 2 })
    expect(tags("SessionLogItemValue24_data_changeValue13")).toEqual({ type: 1 })
  })

  test("form states append the timed-out and deferred states", () => {
    expect(tags("Form_State")).toEqual({ value_1: 1, value_2: 2, value_3: 3, value_4: 4, value_5: 5 })
    expect(tags("Form_StateValue4")).toEqual({ status: 1, seconds: 2 })
    expect(tags("Form_StateValue5")).toEqual({ status: 1, itemID: 2 })
  })

  test("autonomy gains the empty sleep marker and its setter alternative", () => {
    expect(tags("SessionAutonomyState")).toEqual({ mode: 1, yolo: 2, goal: 3, sleep: 4, autoAnswer: 5 })
    expect(target("SessionAutonomyState", "sleep")).toBe("SessionAutonomySleep")
    expect(tags("SessionAutonomySleep")).toEqual({})
    expect(tags("SessionAutonomySet")).toEqual({ value_1: 1, value_2: 2, value_3: 3, value_4: 4 })
    expect(tags("SessionAutonomySetValue3")).toEqual({ sleep: 1 })
    expect(tags("SessionAutonomySetValue1")).toEqual({ yolo: 1, goal: 2, maxNoProgress: 3 })
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
