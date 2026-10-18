import { describe, expect, test } from "bun:test"
import path from "node:path"
import { messages } from "../src/generated/v5/contract.js"
import { operationIDsByRole } from "../src/generated/v5/index.js"
import { ClientApi, groupNames } from "../src/client.js"
import {
  MutationClass,
  operations,
  Paging,
  PeerRole,
  ScopeKind,
  Sensitivity,
  Settlement,
  Streaming,
} from "../src/v5/index.js"
import { connectorOperations } from "./connector-source.js"
import { resourceIDs } from "./resources-contract.js"

const descriptors = path.resolve(import.meta.dir, "../../../protocol/ycoding/v5")
const read = (file: string) => Bun.file(path.join(descriptors, file)).text()

type Field = { tag: number; name: string; target?: string }
const fields = (message: string) =>
  (messages as Record<string, { fields: readonly Field[] }>)[`ycoding.v5.${message}`]?.fields
const tags = (message: string) => Object.fromEntries(fields(message)!.map((field) => [field.name, field.tag]))
const operation = (name: string) => operations.find((candidate) => candidate.diagnosticName === name)!
const enumValues = (proto: string, name: string) => {
  const body = proto.match(new RegExp(`^enum ${name} \\{\\n([\\s\\S]*?)^\\}`, "m"))?.[1]
  expect(body, `enum ${name}`).toBeDefined()
  return Object.fromEntries([...body!.matchAll(/^\s+(\w+) = (\d+)(?: \[[^\]]*\])?;/gm)].map((match) => [match[1], Number(match[2])]))
}
const errors = (name: string) => [...operation(name).errorTypes].sort()
const standardErrors = ["InvalidRequestError", "UnauthorizedError"].map((error) => `ycoding.v5.${error}`)
const standardRoles = [PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY]

const allocation = [
  ["incident.report", 2064],
  ["incident.recent", 2065],
  ["incident.guidance.get", 2066],
  ["incident.guidance.clear", 2067],
] as const

describe("canonical methods and allocation", () => {
  test("the four methods hold exactly the fresh explicit IDs 2064-2067 and no other incident method exists", () => {
    for (const [name, id] of allocation) {
      const descriptor = operation(name)
      expect(descriptor, name).toBeDefined()
      expect(descriptor.operationId).toBe(id)
      expect(descriptor.requestType).toBe(`ycoding.v5.${name.replaceAll(".", "_")}_Request`)
      expect(descriptor.resultType).toBe(`ycoding.v5.${name.replaceAll(".", "_")}_Result`)
      expect(descriptor.settlement).toBe(Settlement.COMPLETED)
      expect(descriptor.streaming).toBe(Streaming.TYPED_BULK)
      expect(descriptor.sensitivity).toBe(Sensitivity.PRIVATE)
      expect(errors(name)).toEqual(standardErrors)
    }
    expect(
      operations
        .filter((descriptor) => descriptor.diagnosticName.startsWith("incident."))
        .map((descriptor) => descriptor.diagnosticName)
        .sort(),
    ).toEqual(allocation.map(([name]) => name).sort())
    expect(Object.fromEntries(Object.entries(resourceIDs).filter(([name]) => name.startsWith("incident.")))).toEqual(
      Object.fromEntries(allocation),
    )
  })

  test("the reservation extends the resource range contiguously without moving any prior ID", async () => {
    const ids = operations
      .map((descriptor) => descriptor.operationId)
      .filter((id) => id >= 2000 && id <= 2999)
      .sort((left, right) => left - right)
    expect(ids).toEqual(Array.from({ length: 68 }, (_, index) => 2000 + index))
    expect(operation("agent.list").operationId).toBe(2000)
    expect(operation("usage.report").operationId).toBe(2059)
    expect(operation("providerUsage.forecast").operationId).toBe(2063)
    expect(await read("resources.proto")).toContain("option (ycoding.v5.operation_range) = { first: 2000 last: 2067 };")
  })

  test("the incident service is declared in the resources descriptor with its four RPCs", async () => {
    const proto = await read("resources.proto")
    const service = proto.match(/^service server_incident \{\n([\s\S]*?)^\}/m)?.[1]
    expect(service).toBeDefined()
    expect([...service!.matchAll(/rpc (\w+)\(/g)].map((match) => match[1]).sort()).toEqual([
      "incident_guidance_clear",
      "incident_guidance_get",
      "incident_recent",
      "incident_report",
    ])
    for (const [name, id] of allocation)
      expect(service).toContain(`operation_id: ${id}\n      diagnostic_name: "${name}"`)
  })

  test("only the three reads are remote names, all admitted as unchanged canonical operations", () => {
    expect(
      Object.entries(connectorOperations)
        .filter(([source]) => source.startsWith("incident."))
        .sort(([left], [right]) => left.localeCompare(right)),
    ).toEqual([
      ["incident.guidance.get", [2066, "incident.guidance.get", "B-reuse", "READ"]],
      ["incident.recent", [2065, "incident.recent", "A", "READ"]],
      ["incident.report", [2064, "incident.report", "A", "READ"]],
    ])
    expect(Object.keys(connectorOperations)).not.toContain("incident.guidance.clear")
  })
})

describe("scope and roles", () => {
  test("report and recent are Machine reads for local, remote and relay peers and carry no Location", () => {
    for (const name of ["incident.report", "incident.recent"] as const) {
      const descriptor = operation(name)
      expect(descriptor.roles).toEqual(standardRoles)
      expect(descriptor.roleScopes).toEqual([])
      expect([descriptor.scope, descriptor.mutation]).toEqual([ScopeKind.MACHINE, MutationClass.READ])
    }
    expect(operation("incident.report").paging).toBe(Paging.OFFSET)
    expect(operation("incident.recent").paging).toBe(Paging.UNPAGED)
    expect(tags("ModelIncidentReportQuery")).not.toHaveProperty("location")
    expect(tags("ModelIncidentRecentQuery")).not.toHaveProperty("location")
  })

  test("guidance read is a Location read that remote and relay peers address only at Session scope", () => {
    const descriptor = operation("incident.guidance.get")
    expect(descriptor.roles).toEqual(standardRoles)
    expect(descriptor.roleScopes.map((entry) => [entry.role, entry.scopes])).toEqual([
      [PeerRole.REMOTE_CLIENT, [ScopeKind.SESSION]],
      [PeerRole.RELAY, [ScopeKind.SESSION]],
    ])
    expect([descriptor.scope, descriptor.mutation, descriptor.paging]).toEqual([
      ScopeKind.LOCATION,
      MutationClass.READ,
      Paging.UNPAGED,
    ])
  })

  test("guidance clear is a local-only Location mutation that no remote or relay peer may send", () => {
    const descriptor = operation("incident.guidance.clear")
    expect(descriptor.roles).toEqual([PeerRole.LOCAL_CLIENT])
    expect(descriptor.roleScopes).toEqual([])
    expect([descriptor.scope, descriptor.mutation, descriptor.paging]).toEqual([
      ScopeKind.LOCATION,
      MutationClass.MUTATION,
      Paging.UNPAGED,
    ])
    expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).not.toContain(2067)
    expect(operationIDsByRole[PeerRole.RELAY]).not.toContain(2067)
    expect(operationIDsByRole[PeerRole.LOCAL_CLIENT]).toEqual(expect.arrayContaining([2064, 2065, 2066, 2067]))
  })

  test("remote and relay allowlists contain exactly the three incident reads", () => {
    for (const role of [PeerRole.REMOTE_CLIENT, PeerRole.RELAY])
      expect(
        operations
          .filter((descriptor) => descriptor.roles.includes(role) && descriptor.diagnosticName.startsWith("incident."))
          .map((descriptor) => descriptor.diagnosticName)
          .sort(),
      ).toEqual(["incident.guidance.get", "incident.recent", "incident.report"])
  })
})

describe("message shapes", () => {
  test("each request wraps exactly its query and each result wraps exactly its data", () => {
    for (const name of ["incident_report", "incident_recent", "incident_guidance_get", "incident_guidance_clear"]) {
      expect(tags(`${name}_Request`), name).toEqual({ query: 1 })
      expect(tags(`${name}_Result`), name).toEqual({ data: 1 })
    }
    expect(fields("incident_report_Request")![0].target).toBe("ycoding.v5.ModelIncidentReportQuery")
    expect(fields("incident_recent_Request")![0].target).toBe("ycoding.v5.ModelIncidentRecentQuery")
    for (const name of ["incident_guidance_get", "incident_guidance_clear"])
      expect(fields(`${name}_Request`)![0].target).toBe("ycoding.v5.ModelIncidentGuidanceQuery")
    expect(fields("incident_report_Result")![0].target).toBe("ycoding.v5.ModelIncident_Report")
    expect(fields("incident_recent_Result")![0].target).toBe("ycoding.v5.ModelIncident_Recent")
    for (const name of ["incident_guidance_get", "incident_guidance_clear"])
      expect(fields(`${name}_Result`)![0].target).toBe("ycoding.v5.ModelIncident_Guidance")
  })

  test("queries carry the released fields in source order, with Location only on guidance", () => {
    expect(tags("ModelIncidentReportQuery")).toEqual({ group: 1, from: 2, to: 3, offset: 4, limit: 5 })
    expect(tags("ModelIncidentRecentQuery")).toEqual({ provider: 1, model: 2, agent: 3, limit: 4 })
    expect(tags("ModelIncidentGuidanceQuery")).toEqual({ provider: 1, model: 2, location: 3 })
    expect(tags("ModelIncidentGuidanceQuery_location")).toEqual({ directory: 1, workspace: 2 })
  })

  test("report, recent and guidance results carry the released fields in source order", () => {
    expect(tags("ModelIncident_Report")).toEqual({ rows: 1, groups: 2 })
    expect(tags("ModelIncident_Report_rows")).toEqual({ items: 1 })
    expect(fields("ModelIncident_Report_rows")![0].target).toBe("ycoding.v5.ModelIncident_ReportRow")
    expect(tags("ModelIncident_ReportRow")).toEqual({
      providerID: 1,
      modelID: 2,
      agent: 3,
      fallbacks: 4,
      escalated: 5,
      rejected: 6,
      last: 7,
    })
    expect(tags("ModelIncident_Recent")).toEqual({ items: 1 })
    expect(fields("ModelIncident_Recent_items")![0].target).toBe("ycoding.v5.ModelIncident_Item")
    expect(tags("ModelIncident_Item")).toEqual({
      id: 1,
      time: 2,
      kind: 3,
      category: 4,
      ruleIDs: 5,
      agent: 6,
      variant: 7,
      profile: 8,
      target: 9,
      decidedBy: 10,
    })
    expect(tags("ModelIncident_Item_ruleIDs")).toEqual({ items: 1 })
    expect(fields("ModelIncident_Item")!.find((field) => field.name === "target")!.target).toBe("ycoding.v5.Model_Ref")
    expect(tags("ModelIncident_Guidance")).toEqual({ text: 1, clearedAt: 2, enabled: 3 })
  })

  test("the inc_ identifier prefix is a Schema-owned domain obligation, not a wire-structural constraint", async () => {
    const proto = await read("resources.proto")
    const id = proto
      .match(/^message ModelIncident_Item \{\n([\s\S]*?)^\}/m)![1]
      .match(/^\s+required LosslessString id = 1 (.*)$/m)![1]
    expect(id).toContain('domain_obligations: "packages/schema/src/model-incident.ts#ModelIncident.ID"')
    expect(id).not.toMatch(/utf16_|integer_|count_/)
  })

  test("closed vocabularies keep their released order and values", async () => {
    const proto = await read("resources.proto")
    expect(enumValues(proto, "ModelIncident_Kind")).toEqual({
      MODELINCIDENT_KIND_FALLBACK: 1,
      MODELINCIDENT_KIND_GUARDRAIL_ESCALATED: 2,
      MODELINCIDENT_KIND_GUARDRAIL_REJECTED: 3,
    })
    expect(enumValues(proto, "ModelIncident_DecidedBy")).toEqual({
      MODELINCIDENT_DECIDEDBY_DECISION_MODEL: 1,
      MODELINCIDENT_DECIDEDBY_HUMAN: 2,
    })
    expect(enumValues(proto, "ModelIncident_Group")).toEqual({
      MODELINCIDENT_GROUP_MODEL: 1,
      MODELINCIDENT_GROUP_AGENT: 2,
    })
  })
})

describe("API placement", () => {
  test("the group is named incident and registered directly after usage", () => {
    expect(groupNames["server.incident" as keyof typeof groupNames]).toBe("incident")
    const groups = Object.keys(ClientApi.groups)
    expect(groups.indexOf("server.incident")).toBe(groups.indexOf("server.usage") + 1)
    expect(Object.keys(ClientApi.groups["server.incident" as keyof typeof ClientApi.groups].endpoints)).toEqual([
      "incident.report",
      "incident.recent",
      "incident.guidance.get",
      "incident.guidance.clear",
    ])
  })
})
