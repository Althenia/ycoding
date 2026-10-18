import { describe, expect, test } from "bun:test"
import path from "node:path"
import { messages } from "../src/generated/v5/contract.js"
import {
  MutationClass,
  operations,
  Paging,
  PeerRole,
  publicEvents,
  ScopeKind,
  Sensitivity,
  Settlement,
  Streaming,
} from "../src/v5/index.js"

const descriptors = path.resolve(import.meta.dir, "../../../protocol/ycoding/v5")
const read = (file: string) => Bun.file(path.join(descriptors, file)).text()

const tags = (message: string) =>
  Object.fromEntries(
    (messages as Record<string, { fields: readonly { tag: number; name: string }[] }>)[
      `ycoding.v5.${message}`
    ]!.fields.map((field) => [field.name, field.tag]),
  )
const operation = (name: string) => operations.find((candidate) => candidate.diagnosticName === name)!
const enumValues = (proto: string, name: string) => {
  const body = proto.match(new RegExp(`^enum ${name} \\{\\n([\\s\\S]*?)^\\}`, "m"))![1]
  return Object.fromEntries([...body.matchAll(/^\s+(\w+) = (\d+)(?: \[[^\]]*\])?;/gm)].map((match) => [match[1], Number(match[2])]))
}

describe("operations", () => {
  test("prompt and task costs are Session-scoped reads for local, remote and relay peers", () => {
    for (const [name, id] of [
      ["session.promptCosts", 4084],
      ["session.taskCosts", 4085],
    ] as const) {
      const descriptor = operation(name)
      expect(descriptor.operationId).toBe(id)
      expect(descriptor.requestType).toBe(`ycoding.v5.${name.replace(".", "_")}_Request`)
      expect(descriptor.resultType).toBe(`ycoding.v5.${name.replace(".", "_")}_Result`)
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
        MutationClass.READ,
        Settlement.COMPLETED,
        Paging.UNPAGED,
        Streaming.TYPED_BULK,
        Sensitivity.PRIVATE,
      ])
      expect([...descriptor.errorTypes].sort()).toEqual(
        ["InvalidRequestError", "ServiceUnavailableError", "SessionNotFoundError", "UnauthorizedError"]
          .map((error) => `ycoding.v5.${error}`)
          .sort(),
      )
    }
  })

  test("the usage forecast is a Location read that remote and relay peers address at machine or Session scope", () => {
    const descriptor = operation("providerUsage.forecast")
    expect(descriptor.operationId).toBe(2063)
    expect(descriptor.roles).toEqual([PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY])
    expect(descriptor.roleScopes.map((entry) => [entry.role, entry.scopes])).toEqual([
      [PeerRole.REMOTE_CLIENT, [ScopeKind.MACHINE, ScopeKind.SESSION]],
      [PeerRole.RELAY, [ScopeKind.MACHINE, ScopeKind.SESSION]],
    ])
    expect([descriptor.scope, descriptor.mutation, descriptor.paging, descriptor.streaming]).toEqual([
      ScopeKind.LOCATION,
      MutationClass.READ,
      Paging.UNPAGED,
      Streaming.TYPED_BULK,
    ])
    expect([...descriptor.errorTypes].sort()).toEqual(
      ["InvalidRequestError", "ServiceUnavailableError", "UnauthorizedError"]
        .map((error) => `ycoding.v5.${error}`)
        .sort(),
    )
  })

  test("the Session usage report becomes remote and relay readable", () => {
    expect(operation("session.usageReport").operationId).toBe(4078)
    expect(operation("session.usageReport").roles).toEqual([
      PeerRole.LOCAL_CLIENT,
      PeerRole.REMOTE_CLIENT,
      PeerRole.RELAY,
    ])
  })

  test("operation IDs stay contiguous in the Session and resource ranges", () => {
    for (const [first, last] of [
      [4000, 4087],
      [2000, 2067],
    ] as const) {
      const ids = operations
        .map((descriptor) => descriptor.operationId)
        .filter((id) => id >= first && id <= last)
        .sort((a, b) => a - b)
      expect(ids).toEqual(Array.from({ length: last - first + 1 }, (_, index) => first + index))
    }
  })

  test("remote and relay allowlists include usage, incident, fixed demo, local app and relay-only MCP operations", () => {
    const remote = operations.filter((descriptor) => descriptor.roles.includes(PeerRole.REMOTE_CLIENT)).length
    const relay = operations.filter((descriptor) => descriptor.roles.includes(PeerRole.RELAY)).length
    expect([remote, relay]).toEqual([87, 84])
  })

  test("each new request type wraps its declared parameters", () => {
    expect(tags("session_promptCosts_Request")).toEqual({ params: 1, query: 2 })
    expect(tags("session_taskCosts_Request")).toEqual({ params: 1, query: 2 })
    expect(tags("providerUsage_forecast_Request")).toEqual({ query: 1 })
    expect(tags("providerUsage_forecast_Result")).toEqual({ location: 1, data: 2 })
  })
})

describe("allocated tags and values", () => {
  test("report queries keep their tags and append the four filters", () => {
    for (const message of ["usage_report_Request_query", "session_usageReport_Request_query"])
      expect(tags(message)).toEqual({
        group: 1,
        timeZone: 2,
        from: 3,
        to: 4,
        offset: 5,
        limit: 6,
        sort: 7,
        order: 8,
        providerID: 9,
        profile: 10,
        modelID: 11,
        selectedEffort: 12,
      })
  })

  test("report groups append seven values", async () => {
    const values = enumValues(await read("resources.proto"), "usage_report_Request_query_group")
    expect(Object.values(values)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    expect(Object.keys(values).slice(7)).toEqual(
      ["PROVIDER", "PROVIDER_PROFILE_MODEL", "PROVIDER_MODEL", "MODEL_ID", "PROFILE", "PROMPT", "TASK"].map(
        (group) => `USAGE_REPORT_REQUEST_QUERY_GROUP_${group}`,
      ),
    )
    const session = enumValues(await read("session.proto"), "session_usageReport_Request_query_group")
    expect(Object.values(session)).toEqual(Object.values(values))
  })

  test("timing, speed, report and diagnostics fields append after their existing tags", () => {
    expect(tags("ProviderRequest_Timing")).toMatchObject({
      firstOutputMs: 1,
      generatedTokens: 7,
      loadDurationNs: 8,
      estimatedTokens: 9,
      estimatedGenerationDurationNs: 10,
    })
    expect(tags("ProviderRequest_Speed")).toEqual({
      firstOutputP50Ms: 1,
      firstOutputP95Ms: 2,
      totalP50Ms: 3,
      totalP95Ms: 4,
      outputTokensPerSecond: 5,
      samples: 6,
      generationSamples: 7,
      generationP50TokensPerSecond: 8,
      generationP90TokensPerSecond: 9,
      providerTimedSamples: 10,
      observedSamples: 11,
    })
    expect(tags("ProviderRequest_Report_rowsItem")).toMatchObject({
      key: 1,
      tokens: 8,
      speed: 12,
      model: 13,
      dimensions: 14,
      costCoverage: 15,
    })
    expect(tags("ProviderRequest_Report_total")).toMatchObject({ tokens: 6, cacheReadReported: 9, costCoverage: 10 })
    expect(tags("Session_GenerationSpeed")).toMatchObject({ model: 1, tokensPerSecond: 4, estimated: 5 })
    expect(tags("Session_GenerationSpeedHistory")).toEqual({ latest: 1, recent: 2, model: 3, unreportedReason: 4 })
    expect(tags("ProviderRequest_CostCoverage")).toEqual({ pricedRequests: 1, unpricedRequests: 2 })
    expect(tags("UsageAnchor_Ref")).toEqual({ sessionID: 1, inputID: 2 })
  })

  test("attribution fields are optional appended event fields", () => {
    expect(tags("SessionLogItemValue15_data")).toMatchObject({ input: 3, causedBy: 4 })
    expect(tags("SessionLogItemValue24_data_changeValue1")).toMatchObject({ delivery: 11, usageAnchor: 12 })
    expect(tags("SessionLogItemValue45_data")).toMatchObject({ pressure: 3, usageAnchor: 4 })
  })

  test("web latency operations append four values after the keep-awake values", async () => {
    const values = enumValues(await read("platform.proto"), "Telemetry_RequestSample_operation")
    const prefix = "TELEMETRY_REQUESTSAMPLE_OPERATION_"
    expect(values[`${prefix}MACHINE_KEEPAWAKE_GET`]).toBe(65)
    expect(values[`${prefix}MACHINE_KEEPAWAKE_SET`]).toBe(66)
    expect(
      ["SESSION_USAGEREPORT", "SESSION_PROMPTCOSTS", "SESSION_TASKCOSTS", "USAGE_FORECAST"].map(
        (name) => values[`${prefix}${name}`],
      ),
    ).toEqual([67, 68, 69, 70])
  })
})

describe("tool progress", () => {
  test("is a live-only public event in its original slot", () => {
    expect(publicEvents.find((event) => event.name === "session.tool.progress")).toEqual({
      name: "session.tool.progress",
      durable: false,
      tag: 51,
      type: "ycoding.v5.PublicEvent_session_tool_progress",
    })
  })

  test("leaves its durable slot reserved without renumbering later events", async () => {
    const log = Object.values(tags("SessionLogItem"))
    expect(log).toHaveLength(59)
    expect(log).toContain(39)
    expect(log).not.toContain(40)
    expect(log).toContain(41)
    expect(log).toContain(52)
    expect((messages as Record<string, unknown>)["ycoding.v5.SessionLogItemValue40"]).toBeUndefined()
    expect(await read("session.proto")).toMatch(/message SessionLogItem \{[\s\S]*?\n  reserved 40;\n\}/)
    expect(publicEvents.find((event) => event.name === "session.tool.success")).toMatchObject({
      durable: true,
      tag: 52,
      type: "ycoding.v5.SessionLogItemValue41",
    })
  })
})
