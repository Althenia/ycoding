import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { HttpApiEndpoint } from "effect/unstable/httpapi"
import { enumNumbers, messageTags, reservedLine, type WireAllocation } from "./wire-allocation.js"
import { wireContract } from "./wire-contract.js"
import { frontendBoundaryBaseline } from "./frontend-boundary-baseline.js"
import { platformContract, platformProto, sharedProto } from "./platform-contract.js"
import { publicEventContract, publicEventProto } from "./public-event-contract.js"
import { resourceContract, resourceProto } from "./resources-contract.js"
import { sessionContract, sessionProto } from "./session-contract.js"

const named = (...names: string[]) => names.map((name) => ({ name }))
const allocation = (
  messages: WireAllocation["messages"] = {},
  enums: WireAllocation["enums"] = {},
): WireAllocation => ({
  messages,
  enums,
})

test("diagnostic reasons stay scalar and append escalation metadata without moving existing tags", () => {
  const contract = sessionContract()
  expect(contract.enums.get("Guardrail_EscalationReason")).toEqual([
    "unavailable",
    "invalid-request",
    "provider-failed",
    "timeout",
    "input-too-large",
    "invalid-output",
    "refused",
    "truncated-output",
    "unsupported-output",
    "escalated",
    "low_confidence",
    "conflicting_grades",
  ])
  expect(contract.messages.has("Guardrail_EscalationReason")).toBe(false)
  expect(messageTags("Guardrail_Escalation", contract.messages.get("Guardrail_Escalation")!.fields)).toEqual([
    4, 1, 2, 3,
  ])
  expect(
    messageTags("SessionLogItemValue54_data", contract.messages.get("SessionLogItemValue54_data")!.fields),
  ).toEqual([1, 2, 8, 3, 4, 5, 6, 7])
  const reasons = contract.enums.get("SessionReview_Reason")!
  const ordinals = Object.fromEntries(
    reasons.map((reason, index) => [reason, enumNumbers("SessionReview_Reason", reasons)[index]]),
  )
  expect(ordinals).toMatchObject({
    disabled: 1,
    free_text: 2,
    refused: 3,
    low_confidence: 4,
    escalated: 5,
    error: 6,
    timeout: 7,
    sleep_entry: 8,
    restart: 9,
  })
  expect(reasons).toHaveLength(17)
})

describe("message field tags", () => {
  test("a message without an allocation keeps declaration order", () => {
    expect(messageTags("M", named("a", "b", "c"), allocation())).toEqual([1, 2, 3])
  })

  test("reordering the declaration does not move an allocated tag", () => {
    expect(messageTags("M", named("b", "a"), allocation({ M: ["a", "b"] }))).toEqual([2, 1])
  })

  test("a field appended to the declaration keeps every earlier tag only when it is allocated last", () => {
    const registry = allocation({ M: ["a", "b", "c"] })
    expect(messageTags("M", named("a", "c", "b"), registry)).toEqual([1, 3, 2])
  })

  test("a reserved slot keeps its number and later fields keep theirs", () => {
    const registry = allocation({ M: ["a", { reserved: "gone" }, "b"] })
    expect(messageTags("M", named("a", "b"), registry)).toEqual([1, 3])
    expect(reservedLine("message", "M", registry)).toBe("  reserved 2;\n")
  })

  test("a message with no reserved slot renders no reserved statement", () => {
    expect(reservedLine("message", "M", allocation({ M: ["a"] }))).toBe("")
    expect(reservedLine("message", "Other", allocation({ M: [{ reserved: "x" }] }))).toBe("")
  })

  test("preset tags are used as given and must be unique", () => {
    expect(
      messageTags(
        "M",
        [
          { name: "a", tag: 7 },
          { name: "b", tag: 3 },
        ],
        allocation(),
      ),
    ).toEqual([7, 3])
    expect(() =>
      messageTags(
        "M",
        [
          { name: "a", tag: 3 },
          { name: "b", tag: 3 },
        ],
        allocation(),
      ),
    ).toThrow(/duplicate/i)
    expect(() => messageTags("M", [{ name: "a", tag: 3 }, { name: "b" }], allocation())).toThrow(/preset/i)
  })

  test("a field missing from the allocation is rejected", () => {
    expect(() => messageTags("M", named("a", "b"), allocation({ M: ["a"] }))).toThrow(/unallocated.*M.*b/i)
  })

  test("an allocated name that is neither declared nor reserved is rejected", () => {
    expect(() => messageTags("M", named("a"), allocation({ M: ["a", "b"] }))).toThrow(/stale.*M.*b/i)
  })

  test("a duplicated allocation entry is rejected", () => {
    expect(() => messageTags("M", named("a"), allocation({ M: ["a", "a"] }))).toThrow(/duplicate.*M.*a/i)
    expect(() => messageTags("M", named("a"), allocation({ M: ["a", { reserved: "a" }] }))).toThrow(/duplicate.*M.*a/i)
    expect(() => messageTags("M", named("a"), allocation({ M: ["a", { reserved: "x" }, { reserved: "x" }] }))).toThrow(
      /duplicate.*M.*x/i,
    )
  })
})

describe("enum numbers", () => {
  test("an enum without an allocation keeps literal order", () => {
    expect(enumNumbers("E", ["x", "y"], allocation())).toEqual([1, 2])
  })

  test("reordering or appending literals does not move an allocated number", () => {
    const registry = allocation({}, { E: ["x", "y", "z"] })
    expect(enumNumbers("E", ["z", "x", "y"], registry)).toEqual([3, 1, 2])
  })

  test("a reserved slot keeps its number and later literals keep theirs", () => {
    const registry = allocation({}, { E: ["x", { reserved: "gone" }, "y"] })
    expect(enumNumbers("E", ["x", "y"], registry)).toEqual([1, 3])
    expect(reservedLine("enum", "E", registry)).toBe("  reserved 2;\n")
  })

  test("non-string literals are allocated by value", () => {
    expect(enumNumbers("E", [2, 1, true], allocation({}, { E: [1, 2, true] }))).toEqual([2, 1, 3])
  })

  test("unallocated, stale and duplicate entries are rejected", () => {
    expect(() => enumNumbers("E", ["x", "y"], allocation({}, { E: ["x"] }))).toThrow(/unallocated.*E.*y/i)
    expect(() => enumNumbers("E", ["x"], allocation({}, { E: ["x", "y"] }))).toThrow(/stale.*E.*y/i)
    expect(() => enumNumbers("E", ["x"], allocation({}, { E: ["x", "x"] }))).toThrow(/duplicate.*E.*x/i)
  })
})

describe("union members", () => {
  const member = (type: string, fields: Schema.Struct.Fields = {}) =>
    Schema.Struct({ type: Schema.Literal(type), ...fields })
  const contractOf = (members: readonly Schema.Top[], registry?: WireAllocation) =>
    wireContract(
      [
        {
          group: "test",
          endpoint: HttpApiEndpoint.get("test.log", "/log", {
            success: Schema.Union(members as [Schema.Top, Schema.Top]).annotate({ identifier: "TestLog" }),
          }),
        },
      ],
      { "test.log": 4000 },
      () => "packages/schema/src/form.ts#Form.Fields",
      [],
      {},
      [],
      registry,
    )
  const a = member("a", { x: Schema.String })
  const c = member("c", { y: Schema.String })
  const d = member("d", { z: Schema.String })
  const summary = (contract: ReturnType<typeof contractOf>) =>
    contract.messages.get("TestLog")!.fields.map((field) => [field.name, field.type, field.tag])

  test("members are numbered by position without an allocation", () => {
    expect(summary(contractOf([a, c, d]))).toEqual([
      ["value_1", "TestLogValue1", undefined],
      ["value_2", "TestLogValue2", undefined],
      ["value_3", "TestLogValue3", undefined],
    ])
  })

  test("a removed member leaves its slot reserved and later names and tags stay put", () => {
    const registry = allocation({ TestLog: ["a", { reserved: "b" }, "c", "d"] })
    const contract = contractOf([a, c, d], registry)
    expect(summary(contract)).toEqual([
      ["value_1", "TestLogValue1", 1],
      ["value_3", "TestLogValue3", 3],
      ["value_4", "TestLogValue4", 4],
    ])
    expect(contract.messages.get("TestLogValue3")!.fields.map((field) => field.name)).toEqual(["type", "y"])
    expect(contract.messages.has("TestLogValue2")).toBe(false)
    expect(reservedLine("message", "TestLog", registry)).toBe("  reserved 2;\n")
  })

  test("reordering the declared members does not move an allocated slot", () => {
    const contract = contractOf([c, a], allocation({ TestLog: ["a", "c"] }))
    expect(summary(contract)).toEqual([
      ["value_2", "TestLogValue2", 2],
      ["value_1", "TestLogValue1", 1],
    ])
    expect(contract.messages.get("TestLogValue2")!.fields.map((field) => field.name)).toEqual(["type", "y"])
  })

  test("a member appended to the declaration takes the next allocated slot", () => {
    const before = allocation({ TestLog: ["a", { reserved: "b" }, "c"] })
    const after = allocation({ TestLog: ["a", { reserved: "b" }, "c", "d"] })
    expect(summary(contractOf([a, c], before)).map(([, , tag]) => tag)).toEqual([1, 3])
    expect(summary(contractOf([a, c, d], after)).map(([, , tag]) => tag)).toEqual([1, 3, 4])
  })

  test("unallocated, stale and duplicate members are rejected", () => {
    expect(() => contractOf([a, c], allocation({ TestLog: ["a"] }))).toThrow(/unallocated.*TestLog.*c/i)
    expect(() => contractOf([a, c], allocation({ TestLog: ["a", "b", "c"] }))).toThrow(/stale.*TestLog.*b/i)
    expect(() => contractOf([a, c], allocation({ TestLog: ["a", "a", "c"] }))).toThrow(/duplicate.*TestLog.*a/i)
  })

  test("a member without a type identity cannot be allocated", () => {
    const anonymous = Schema.Struct({ x: Schema.String })
    expect(() => contractOf([a, anonymous], allocation({ TestLog: ["a", "b"] }))).toThrow(/identity.*TestLog/i)
  })
})

describe("projection", () => {
  const descriptors = path.resolve(import.meta.dir, "../../../protocol/ycoding/v5")
  const read = (file: string) => Bun.file(path.join(descriptors, file)).text()

  test("the current allocation renders every checked-in descriptor unchanged", async () => {
    expect(sessionProto()).toBe(await read("session.proto"))
    expect(resourceProto()).toBe(frontendBoundaryBaseline(await read("resources.proto")))
    expect(sharedProto()).toBe(frontendBoundaryBaseline(await read("shared.proto")))
    expect(platformProto()).toBe(frontendBoundaryBaseline(await read("platform.proto")))
    expect(publicEventProto()).toBe(await read("events.proto"))
  })

  const enums = new Map([
    ...resourceContract().enums,
    ...platformContract().enums,
    ...sessionContract().enums,
    ...publicEventContract().enums,
  ])
  const declaration = (proto: string, kind: "message" | "enum", name: string) =>
    proto.match(new RegExp(`^${kind} ${name} \\{\\n([\\s\\S]*?)^\\}`, "m"))![1]
  const numbered = (body: string, pattern: RegExp) => [...body.matchAll(pattern)].map((m) => [m[1], Number(m[2])])
  const fieldPattern = /^\s+(?:(?:required|optional|repeated) )?\S+ (\w+) = (\d+)/gm
  const valuePattern = /^\s+(\w+) = (\d+)(?: \[[^\]]*\])?;/gm
  const firstMessage = (proto: string) =>
    [...proto.matchAll(/^message (\w+) \{\n([\s\S]*?)^\}/gm)].find(
      (m) => !m[2].includes("oneof") && numbered(m[2], fieldPattern).length >= 3,
    )!
  const firstEnum = (proto: string) =>
    [...proto.matchAll(/^enum (\w+) \{\n([\s\S]*?)^\}/gm)].find((m) => enums.has(m[1]) && enums.get(m[1])!.length >= 3)!

  const renderers = [
    { file: "session", render: (registry?: WireAllocation) => sessionProto(undefined, registry) },
    { file: "resources", render: (registry?: WireAllocation) => resourceProto(false, registry) },
    { file: "shared", render: (registry?: WireAllocation) => sharedProto(registry) },
    { file: "platform", render: (registry?: WireAllocation) => platformProto(undefined, true, registry) },
  ]

  test.each(renderers)("$file descriptor honors message and enum allocations", ({ render }) => {
    const base = render()
    const message = firstMessage(base)
    const fields = numbered(message[2], fieldPattern).map(([name]) => String(name))
    const enumeration = firstEnum(base)
    const values = enums.get(enumeration[1])!
    const rendered = render(
      allocation(
        { [message[1]]: [...fields.toReversed(), { reserved: "retired" }] },
        { [enumeration[1]]: [...values.toReversed(), { reserved: "retired" }] },
      ),
    )
    const body = declaration(rendered, "message", message[1])
    expect(numbered(body, fieldPattern)).toEqual(fields.map((name, index) => [name, fields.length - index]))
    expect(body).toContain(`  reserved ${fields.length + 1};\n`)
    const enumBody = declaration(rendered, "enum", enumeration[1])
    expect(numbered(enumBody, valuePattern).map(([, value]) => value)).toEqual(
      values.map((_, index) => values.length - index),
    )
    expect(enumBody).toContain(`  reserved ${values.length + 1};\n`)
  })

  test("events descriptor honors the PublicEvent allocation", () => {
    const events = publicEventContract()
      .messages.get("PublicEvent")!
      .fields.map((field) => field.name)
    const rendered = publicEventProto(allocation({ PublicEvent: [...events.toReversed(), { reserved: "retired" }] }))
    const body = declaration(rendered, "message", "PublicEvent")
    expect(numbered(body, fieldPattern)).toEqual(events.map((name, index) => [name, events.length - index]))
    expect(body).toContain(`  reserved ${events.length + 1};\n`)
  })

  test("an incomplete allocation fails the descriptor render", () => {
    expect(() => sessionProto(undefined, allocation({ SessionsQuery: ["order"] }))).toThrow(
      /unallocated.*SessionsQuery/i,
    )
  })
})
