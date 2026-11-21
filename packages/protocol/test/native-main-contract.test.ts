import { expect, test } from "bun:test"
import path from "node:path"
import { readdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { CONTRACT_DIGEST, messages } from "../src/generated/v5/contract.js"
import {
  MutationClass,
  operations as descriptors,
  Paging,
  PeerRole,
  ScopeKind,
  Sensitivity,
  Settlement,
  Streaming,
} from "../src/generated/v5/index.js"
import { connectorOperations, noticeOperations, relayOperations } from "./connector-source.js"

const directory = path.resolve(import.meta.dir, "../../../protocol/ycoding/v5")
const source = (
  await Promise.all(
    readdirSync(directory)
      .filter((name) => name.endsWith(".proto"))
      .map((name) => Bun.file(path.join(directory, name)).text()),
  )
).join("\n")
const body = (kind: string, name: string) =>
  source.match(new RegExp(`^${kind} ${name} \\{\\n([\\s\\S]*?)^\\}`, "m"))?.[1] ?? ""
const fields = (name: string) =>
  Object.fromEntries(
    [...body("message", name).matchAll(/^\s+(?:(?:required|optional|repeated) )?\S+ (\w+) = (\d+)/gm)].map((field) => [
      field[1],
      Number(field[2]),
    ]),
  )

test("current machine controls have fixed allocations and retired RPCs are absent", () => {
  const operations = new Map(
    [...source.matchAll(/operation_id: (\d+)\s+diagnostic_name: "([^"]+)"/g)].map((match) => [
      match[2],
      Number(match[1]),
    ]),
  )
  expect(operations.get("dots.get")).toBe(2068)
  expect(operations.get("dots.set")).toBe(2069)
  expect(operations.get("usage.dashboard")).toBe(2070)
  expect(
    [...operations.keys()].filter(
      (name) =>
        name.startsWith("session.dots.") ||
        name === "remote.mcp.get" ||
        name === "remote.mcp.set" ||
        name === "mcp.request",
    ),
  ).toEqual([])
})

test("prompt provenance cannot reuse its retired eighth payload tag", () => {
  expect(fields("session_prompt_Request_payload").remoteSource).toBeUndefined()
  expect(body("message", "session_prompt_Request_payload")).toMatch(/reserved 8;/)
  expect(body("message", "session_prompt_Request_payload")).toContain('reserved "remoteSource";')
})

test("accounting additions preserve existing timing speed and report slots", () => {
  expect(fields("ProviderRequest_Timing")).toMatchObject({
    firstOutputMs: 1,
    totalMs: 2,
    retryWaitMs: 3,
    estimatedTokens: 9,
    estimatedGenerationDurationNs: 10,
    receivedOutput: 11,
  })
  expect(fields("ProviderRequest_Speed")).toMatchObject({
    samples: 6,
    generationSamples: 7,
    generationP90TokensPerSecond: 9,
    providerTimedSamples: 10,
    observedSamples: 11,
    generationP95TokensPerSecond: 12,
    meanTokensPerSecond: 13,
    firstOutputP99Ms: 14,
    totalP99Ms: 15,
  })
  expect(fields("ProviderRequest_ReportRow")).toEqual({
    key: 1,
    label: 2,
    logical: 3,
    physical: 4,
    helpers: 5,
    continued: 6,
    fallback: 7,
    tokens: 8,
    cost: 9,
    costProvenance: 10,
    cacheReadReported: 11,
    speed: 12,
    model: 13,
    dimensions: 14,
    costCoverage: 15,
    outcomes: 16,
    concurrency: 17,
  })
  expect(fields("ProviderRequest_ReportMetrics")).toMatchObject({ costCoverage: 10, outcomes: 11 })
  expect(fields("ProviderRequest_Report").speed).toBe(6)
  expect(fields("Session_GenerationSpeedHistory").live).toBe(5)
})

test("nested receipts and missing Dots history append after preserved unions", () => {
  expect(fields("ToolInvocation_Settled")).toEqual({
    id: 1,
    index: 2,
    name: 3,
    tool: 4,
    status: 5,
    input: 6,
    structured: 7,
  })
  expect(fields("SessionLogItemValue66_data")).toEqual({
    sessionID: 1,
    assistantMessageID: 2,
    callID: 3,
    invocation: 4,
  })
  const log = Object.values(fields("SessionLogItem"))
  for (const slot of [63, 64, 65, 66, 67, 68, 69, 70, 71, 72]) expect(log).toContain(slot)
  const events = new Map(
    [
      ...body("message", "PublicEvent").matchAll(
        /\S+ \w+ = (\d+) \[\(ycoding\.v5\.public_event\) = \{ diagnostic_name: "([^"]+)"/g,
      ),
    ].map((match) => [match[2], Number(match[1])]),
  )
  expect(events.get("session.tool.invocation-settled")).toBe(130)
  expect(events.get("session.dots.access.changed")).toBe(131)
  expect(events.get("session.dots.binding.bound")).toBe(132)
  expect(events.get("session.dots.binding.unbound")).toBe(133)
  expect(events.get("session.dots.device-delegation.created")).toBe(134)
  expect(events.get("session.dots.device-delegation.revoked")).toBe(135)
  expect(events.get("session.dots.decision.settled")).toBe(136)
  expect(events.get("permission.cancelled")).toBe(137)
  expect(events.get("guardrail.cancelled")).toBe(138)
})

test("current field additions cannot shift existing nested wire identities", () => {
  expect(fields("Browser_Observation")).toMatchObject({ truncated: 8, texts: 9, frames: 10 })
  expect(fields("IsolatedBrowser_Observation")).toMatchObject({
    truncated: 8,
    mode: 9,
    instanceID: 10,
    texts: 11,
    frames: 12,
  })
  expect(fields("ProviderUsage_Window")).toMatchObject({ unit: 3, periodSeconds: 9, group: 10 })
  expect(fields("SessionReview_PermissionPayload")).toMatchObject({
    requestID: 6,
    coordinationEscalation: 7,
    fingerprintVersion: 8,
  })
  expect(fields("SessionLogItemValue63_data")).toMatchObject({ scope: 11, delegated: 12 })
  expect(body("enum", "ModelIncident_RecordedDecidedBy")).toBe("")
  expect(body("enum", "ModelIncident_DecidedBy")).toContain("MODELINCIDENT_DECIDEDBY_DECISION_MODEL = 1")
  expect(body("enum", "ModelIncident_DecidedBy")).not.toContain("MODELINCIDENT_DECIDEDBY_HUMAN =")
  expect(body("enum", "ModelIncident_DecidedBy")).toContain("MODELINCIDENT_DECIDEDBY_CLIENT = 3")
  expect(body("enum", "ModelIncident_DecidedBy")).toMatch(/reserved 2;/)
  expect(body("enum", "ModelIncident_DecidedBy")).toContain('reserved "MODELINCIDENT_DECIDEDBY_HUMAN";')
  expect(fields("ModelIncident_Item").decidedBy).toBe(10)
})

test("review request origins add the optional executor marker at the next free tag without moving the union arms", () => {
  expect(fields("SessionReview_Origin")).toEqual({ value_1: 1, value_2: 2, value_3: 3 })
  expect(fields("SessionReview_OriginValue1")).toEqual({ messageID: 1, callID: 2 })
  expect(fields("SessionReview_OriginValue2")).toEqual({ questionID: 1 })
  expect(fields("SessionReview_OriginValue3")).toEqual({ requestID: 1, executor: 2 })
  expect(body("message", "SessionReview_OriginValue3")).toMatch(/^\s+optional bool executor = 2/m)
  expect(body("message", "SessionReview_OriginValue3")).toMatch(/^\s+required LosslessString requestID = 1/m)
  expect(body("message", "SessionReview_OriginValue3")).not.toContain("reserved")
  const declared = messages as Record<
    string,
    { fields: readonly { tag: number; name: string; type: number; required: boolean; repeated: boolean }[] }
  >
  expect(
    declared["ycoding.v5.SessionReview_OriginValue3"].fields.map(({ tag, name, type, required, repeated }) => ({
      tag,
      name,
      type,
      required,
      repeated,
    })),
  ).toEqual([
    { tag: 1, name: "requestID", type: 11, required: true, repeated: false },
    { tag: 2, name: "executor", type: 8, required: false, repeated: false },
  ])
})

test("the generated contract digest matches the checked-in descriptors and the hello and ready vectors", async () => {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".proto"))
    .sort()
  const digest = createHash("sha256")
  for (const file of files) {
    digest.update(`ycoding/v5/${file}\0`)
    digest.update(new Uint8Array(await Bun.file(path.join(directory, file)).arrayBuffer()))
  }
  expect(CONTRACT_DIGEST).toBe(digest.digest("hex"))
  const rows = new Map(
    (await Bun.file(path.join(directory, "testdata/manifest.tsv")).text())
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const columns = line.split("\t")
        return [columns[0], columns] as const
      }),
  )
  for (const name of ["hello", "ready"]) {
    expect(rows.get(name)?.[2]).toBe("valid")
    expect(rows.get(name)?.[4]).toContain(CONTRACT_DIGEST)
  }
})

const descriptor = (name: string) => {
  const found = descriptors.find((operation) => operation.diagnosticName === name)
  if (!found) throw new Error(`missing operation ${name}`)
  return {
    id: found.operationId,
    roles: [...found.roles],
    scope: found.scope,
    mutation: found.mutation,
    settlement: found.settlement,
    paging: found.paging,
    streaming: found.streaming,
    sensitivity: found.sensitivity,
    request: found.requestType,
    result: found.resultType,
    errors: [...found.errorTypes].sort(),
  }
}
const localMachine = {
  roles: [PeerRole.LOCAL_CLIENT],
  scope: ScopeKind.MACHINE,
  settlement: Settlement.COMPLETED,
  paging: Paging.UNPAGED,
  streaming: Streaming.TYPED_BULK,
  sensitivity: Sensitivity.PRIVATE,
  errors: ["ycoding.v5.InvalidRequestError", "ycoding.v5.UnauthorizedError"],
}

test("computer attachment, detachment and removal are remote machine operations and the decision list is local-only", () => {
  const remoteMachine = { ...localMachine, roles: [PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY] }
  for (const [name, id, rpc] of [
    ["dots.attach", 2071, "dots_attach"],
    ["dots.detach", 2074, "dots_detach"],
    ["dots.remove", 2075, "dots_remove"],
  ] as const)
    expect(descriptor(name)).toEqual({
      ...remoteMachine,
      id,
      mutation: MutationClass.MUTATION,
      request: `ycoding.v5.${rpc}_Request`,
      result: `ycoding.v5.${rpc}_Result`,
    })
  expect(descriptor("decision.list")).toEqual({
    ...localMachine,
    id: 4102,
    mutation: MutationClass.READ,
    request: "ycoding.v5.decision_list_Request",
    result: "ycoding.v5.decision_list_Result",
  })
  const remote = new Set<string>(
    [...Object.values(connectorOperations), ...Object.values(noticeOperations), ...Object.values(relayOperations)].map(
      ([, name]) => name,
    ),
  )
  for (const name of ["dots.attach", "dots.detach", "dots.remove"]) expect(remote.has(name), name).toBe(true)
  expect(remote.has("decision.list")).toBe(false)
  expect(descriptors.filter((operation) => operation.operationId >= 4090 && operation.operationId <= 4101)).toEqual([])
  expect(descriptor("dots.get")).toMatchObject({ id: 2068, roles: [1, 2, 3], scope: ScopeKind.MACHINE })
  expect(descriptor("dots.set")).toMatchObject({ id: 2069, roles: [1, 2, 3], scope: ScopeKind.MACHINE })
  expect(descriptor("usage.dashboard")).toMatchObject({ id: 2070, roles: [1, 2, 3], scope: ScopeKind.MACHINE })
  expect(descriptor("session.subagent.switchModel")).toMatchObject({ id: 4089 })
})

test("native status appends the optional computer at tag 4 and the attach payload stays the literal true", () => {
  expect(fields("Dots_NativeStatus")).toEqual({ access: 1, configuration: 2, connection: 3, computer: 4 })
  expect(body("message", "Dots_NativeStatus")).toMatch(/^\s+optional Dots_NativeStatus_computer computer = 4;/m)
  expect(fields("Dots_NativeStatus_computer")).toEqual({
    state: 1,
    message: 2,
    name: 3,
    target: 4,
    readiness: 5,
    usableForTasks: 6,
    dotEnvironment: 7,
  })
  expect(fields("Dots_NativeStatus_connection")).toEqual({ state: 1, hostname: 2, message: 3, name: 4 })
  expect(fields("Dots_ComputerTarget")).toEqual({ dotID: 1, threadID: 2, environmentID: 3, revision: 4 })
  expect(body("enum", "Dots_NativeStatus_computer_state")).toMatch(
    /DOTS_NATIVESTATUS_COMPUTER_STATE_ATTACHED = 1[\s\S]*DETACHED = 2[\s\S]*UNAVAILABLE = 3[\s\S]*REMOVED = 4/,
  )
  expect(body("enum", "Dots_NativeStatus_computer_readiness")).toMatch(
    /DOTS_NATIVESTATUS_COMPUTER_READINESS_CONNECTED = 1[\s\S]*OFFLINE = 2[\s\S]*UNKNOWN = 3/,
  )
  expect(fields("Dots_ComputerAttach")).toEqual({ replaceOthers: 1, expectedTarget: 2 })
  expect(body("message", "Dots_ComputerAttach")).toMatch(/^\s+required bool replaceOthers = 1/m)
  expect(body("message", "Dots_ComputerAttach")).toMatch(/^\s+optional Dots_ComputerTarget expectedTarget = 2;/m)
  expect(fields("dots_attach_Request")).toEqual({ payload: 1 })
  expect(fields("dots_attach_Result")).toEqual({ data: 1 })
  expect(fields("decision_list_Request")).toEqual({})
  expect(fields("decision_list_Result")).toEqual({ data: 1 })
  expect(fields("Decision_Item")).toMatchObject({
    kind: 1,
    sessionID: 2,
    sessionTitle: 3,
    directory: 4,
    id: 5,
    summary: 6,
  })
})

test("session origin is an optional trailing field that leaves the frozen created slot in place", () => {
  expect(fields("Session_Info").origin).toBe(16)
  expect(fields("Session_Info").revert).toBe(15)
  expect(body("message", "Session_Info")).toMatch(/^\s+optional Session_Origin origin = 16;/m)
  expect(fields("SessionLogItemValue1_data")).toMatchObject({ subpath: 9, created: 10, origin: 11 })
  expect(body("message", "SessionLogItemValue1_data")).toMatch(/^\s+optional Session_Origin origin = 11;/m)
  expect(body("enum", "Session_Origin")).toMatch(
    /^\s+SESSION_ORIGIN_DOTS_EXECUTOR = 1 \[\(ycoding\.v5\.domain_label\) = "dots-executor"\];/m,
  )
})

test("the session list query appends an optional background filter after the existing fields", () => {
  expect(fields("SessionsQuery")).toEqual({
    workspace: 1,
    limit: 2,
    order: 3,
    search: 4,
    parentID: 5,
    directory: 6,
    project: 7,
    subpath: 8,
    cursor: 9,
    status: 10,
    searchFields: 11,
    around: 12,
    before: 13,
    background: 14,
    pinned: 15,
  })
  expect(body("message", "SessionsQuery")).toMatch(/^\s+optional SessionsQuery_background background = 14;/m)
  const values = [...body("enum", "SessionsQuery_background").matchAll(/^\s+(\w+) = (\d+)/gm)].map((value) => [
    value[1],
    Number(value[2]),
  ])
  expect(values).toEqual([
    ["SESSIONSQUERY_BACKGROUND_INCLUDE", 1],
    ["SESSIONSQUERY_BACKGROUND_EXCLUDE", 2],
  ])
  expect(body("enum", "SessionsQuery_background")).toContain('(ycoding.v5.domain_label) = "include"')
  expect(body("enum", "SessionsQuery_background")).toContain('(ycoding.v5.domain_label) = "exclude"')
})
