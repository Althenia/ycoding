import { describe, expect, test } from "bun:test"
import { Schema, SchemaAST } from "effect"
import { ModelIncident } from "../src/model-incident.js"

const decode = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown) =>
  Schema.decodeUnknownSync(schema as never)(input) as S["Type"]
const encode = <S extends Schema.Encoder<unknown>>(schema: S, input: unknown) =>
  Schema.encodeUnknownSync(schema as never)(input) as S["Encoded"]
const rejects = (schema: Schema.Top, input: unknown) => expect(() => Schema.decodeUnknownSync(schema as never)(input)).toThrow()

describe("ModelIncident", () => {
  test("creates ascending inc_ identifiers", () => {
    const first = ModelIncident.ID.create()
    const second = ModelIncident.ID.create()
    expect(first.startsWith("inc_")).toBe(true)
    expect(second > first).toBe(true)
    rejects(ModelIncident.ID, "ses_abc")
  })

  test("closes kind, decider, and group", () => {
    for (const kind of ["fallback", "guardrail-escalated", "guardrail-rejected"]) expect(decode(ModelIncident.Kind, kind)).toBe(kind as never)
    for (const value of ["decision-model", "client"]) expect(decode(ModelIncident.DecidedBy, value)).toBe(value as never)
    for (const value of ["model", "agent"]) expect(decode(ModelIncident.Group, value)).toBe(value as never)
    rejects(ModelIncident.Kind, "other")
    rejects(ModelIncident.DecidedBy, "system")
    rejects(ModelIncident.DecidedBy, "human")
    rejects(ModelIncident.Group, "provider")
  })

  test("report rows omit absent agent and require nonnegative integer counts", () => {
    const row = { providerID: "p", modelID: "m", fallbacks: 1, escalated: 0, rejected: 2, last: 5 }
    expect(encode(ModelIncident.ReportRow, decode(ModelIncident.ReportRow, row))).toEqual(row)
    expect(Object.keys(encode(ModelIncident.ReportRow, decode(ModelIncident.ReportRow, { ...row, agent: "build" })))).toContain("agent")
    for (const field of ["fallbacks", "escalated", "rejected", "last"]) {
      rejects(ModelIncident.ReportRow, { ...row, [field]: -1 })
      rejects(ModelIncident.ReportRow, { ...row, [field]: 1.5 })
    }
    expect(decode(ModelIncident.Report, { rows: [row], groups: 7 }).groups).toBe(7)
    rejects(ModelIncident.Report, { rows: [], groups: -1 })
  })

  test("recent items round-trip with optional omission", () => {
    const item = { id: "inc_a", time: 10, kind: "fallback" as const, category: "rate-limit", ruleIDs: ["r1"], agent: "build" }
    const decoded = decode(ModelIncident.Recent, { items: [item] })
    expect(encode(ModelIncident.Recent, decoded)).toEqual({ items: [item] })
    const full = {
      ...item,
      kind: "guardrail-rejected" as const,
      variant: "high",
      profile: "work",
      target: { id: "m2", providerID: "p2" },
      decidedBy: "client" as const,
    }
    expect(encode(ModelIncident.Recent, decode(ModelIncident.Recent, { items: [full] }))).toEqual({ items: [full] })
    rejects(ModelIncident.Recent, { items: [{ ...item, decidedBy: "robot" }] })
    rejects(ModelIncident.Recent, { items: [{ ...item, kind: "x" }] })
    rejects(ModelIncident.Recent, { items: [{ ...item, time: -1 }] })
    rejects(ModelIncident.Recent, { items: [{ ...item, ruleIDs: "r1" }] })
  })

  test("guidance omits absent text and clearedAt", () => {
    expect(encode(ModelIncident.Guidance, decode(ModelIncident.Guidance, { enabled: false }))).toEqual({ enabled: false })
    const full = { text: "t", clearedAt: 3, enabled: true }
    expect(encode(ModelIncident.Guidance, decode(ModelIncident.Guidance, full))).toEqual(full)
    rejects(ModelIncident.Guidance, { text: "t" })
  })

  test("uses unique stable identifiers", () => {
    const names = [ModelIncident.ID, ModelIncident.Kind, ModelIncident.DecidedBy, ModelIncident.Group, ModelIncident.ReportRow, ModelIncident.Report, ModelIncident.Recent, ModelIncident.Guidance, ModelIncident.Item].map(
      (schema) => SchemaAST.resolveIdentifier(schema.ast),
    )
    expect(names.every((name) => name?.startsWith("ModelIncident."))).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })
})
