import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApiEndpoint } from "effect/unstable/httpapi"
import { messages } from "../src/generated/v5/contract.js"
import {
  browser_action_Request_payload_actionValue6_tabIDsSchema,
  browser_action_Request_payload_actionValue7_tabIDsSchema,
  isolatedBrowser_action_Request_payload_actionValue6_tabIDsSchema,
  isolatedBrowser_action_Request_payload_actionValue7_tabIDsSchema,
  UsageAccounting_PromptInput_inputIDsSchema,
  UsageAccounting_TaskInput_sessionIDsSchema,
  create,
  encodeLossless,
  encodeStrict,
  session_family_activity_Request_payload_sessionIDsSchema,
  session_team_economics_Request_payload_sessionIDsSchema,
} from "../src/v5/index.js"
import { connectorContract, connectorFieldConstraints } from "./connector-contract.js"
import { platformContract, platformFieldConstraints } from "./platform-contract.js"
import { publicEventContract } from "./public-event-contract.js"
import { resourceContract, resourceFieldConstraints } from "./resources-contract.js"
import { sessionContract } from "./session-contract.js"
import { wireContract, type WireField } from "./wire-contract.js"

type Bounds = { readonly min?: number; readonly max?: number }

const flatten = (check: any): readonly any[] =>
  check._tag === "Filter" ? [check.annotations ?? {}] : check.checks.flatMap(flatten)
const structuralChecks = (ast: any): readonly any[] => {
  const own = (ast?.checks ?? []).flatMap(flatten)
  if (ast?._tag !== "Union") return own
  const types = ast.types.filter((type: any) => type._tag !== "Undefined")
  return types.length === 1 ? [...own, ...structuralChecks(types[0])] : own
}
const bounds = (checks: readonly any[]): Bounds =>
  checks
    .filter((check) => check["~structural"] === true && typeof check.meta === "object" && check.meta !== null)
    .reduce<Bounds>(
      (result, check) => ({
        min: typeof check.meta.minLength === "number" ? check.meta.minLength : result.min,
        max: typeof check.meta.maxLength === "number" ? check.meta.maxLength : result.max,
      }),
      {},
    )

function repeatedField(array: Schema.Top) {
  const contract = wireContract(
    [
      {
        group: "test",
        endpoint: HttpApiEndpoint.get("test.repeat", "/repeat", { success: Schema.Struct({ ids: array as never }) }),
      },
    ],
    { "test.repeat": 4000 },
    () => "packages/schema/src/form.ts#Form.Fields",
    [],
  )
  const wrapper = contract.messages.get(contract.messages.get("test_repeat_Result")!.fields[0].type)!
  return wrapper.fields[0]
}

describe("array-level and item-level checks stay separate", () => {
  test("an array cardinality bound is a count bound, never a per-string length", () => {
    const field = repeatedField(Schema.NonEmptyArray(Schema.String).check(Schema.isMaxLength(100)))
    const constraints = resourceFieldConstraints(field)
    expect([constraints.countMin, constraints.countMax]).toEqual([1, 100])
    expect([constraints.utf16Min, constraints.utf16Max]).toEqual([undefined, undefined])
  })

  test("an item bound stays a per-string length and never becomes a count", () => {
    const field = repeatedField(
      Schema.NonEmptyArray(Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(32))).check(
        Schema.isMaxLength(5),
      ),
    )
    for (const constraints of [resourceFieldConstraints(field), platformFieldConstraints(field)]) {
      expect([constraints.utf16Min, constraints.utf16Max]).toEqual([2, 32])
      expect([constraints.countMin, constraints.countMax]).toEqual([1, 5])
    }
  })

  test("distinct-identity metadata on the array adds no string or count bound", () => {
    const unique = Schema.makeFilter<ReadonlyArray<string>>((value) => new Set(value).size === value.length, {
      expected: "distinct identities",
      meta: { _tag: "isMaxLength", maxLength: 100 },
      arbitrary: { constraint: { maxLength: 100 } },
    })
    const constraints = resourceFieldConstraints(
      repeatedField(Schema.NonEmptyArray(Schema.String).check(Schema.isMaxLength(100), unique)),
    )
    expect([constraints.utf16Min, constraints.utf16Max]).toEqual([undefined, undefined])
    expect([constraints.countMin, constraints.countMax]).toEqual([1, 100])
  })

  test("every projected repeated field derives string bounds only from its item and counts only from its array", () => {
    const sources = [
      ["session", sessionContract(), resourceFieldConstraints],
      ["resources", resourceContract(), resourceFieldConstraints],
      ["platform", platformContract(), platformFieldConstraints],
      ["events", publicEventContract(), resourceFieldConstraints],
    ] as const
    const offenders = sources.flatMap(([label, contract, constraintsOf]) =>
      [...contract.messages].flatMap(([name, message]) =>
        message.fields.flatMap((field: WireField) => {
          if (field.presence !== "repeated") return []
          const item = new Set(structuralChecks(field.ast))
          const itemBounds = bounds(field.constraints.filter((check) => item.has(check)))
          const arrayBounds = bounds(field.constraints.filter((check) => !item.has(check)))
          const actual = constraintsOf(field)
          const expected = {
            utf16Min: field.type === "LosslessString" ? itemBounds.min : undefined,
            utf16Max: field.type === "LosslessString" ? itemBounds.max : undefined,
            countMin: arrayBounds.min,
            countMax: arrayBounds.max,
          }
          const observed = {
            utf16Min: actual.utf16Min,
            utf16Max: actual.utf16Max,
            countMin: actual.countMin,
            countMax: actual.countMax,
          }
          return JSON.stringify(observed) === JSON.stringify(expected)
            ? []
            : [`${label} ${name}.${field.name} expected ${JSON.stringify(expected)} got ${JSON.stringify(observed)}`]
        }),
      ),
    )
    expect([...new Set(offenders)].sort()).toEqual([])
  })
})

describe("connector family member lists", () => {
  test.each([
    ["session_team_economics_Request_payload_sessionIDs", 1],
    ["session_family_activity_Request_payload_sessionIDs", 0],
  ] as const)("%s declares a structural count of %i to 128 and 1 to 128 units per ID", (message, countMin) => {
    const constraints = connectorFieldConstraints(connectorContract().messages.get(message)!.fields[0])
    expect([constraints.utf16Min, constraints.utf16Max]).toEqual([1, 128])
    expect([constraints.countMin, constraints.countMax]).toEqual([countMin, 128])
  })

  test("a root-only activity read accepts an empty list and 128 entries but not 129", () => {
    const schema = session_family_activity_Request_payload_sessionIDsSchema
    const list = (count: number) => create(schema, { items: Array.from({ length: count }, () => encodeLossless("s")) })
    expect(() => encodeStrict(schema, list(0))).not.toThrow()
    expect(() => encodeStrict(schema, list(128))).not.toThrow()
    expect(() => encodeStrict(schema, list(129))).toThrow("collection limit")
  })
})

describe("generated usage accounting input descriptors", () => {
  const constraints = (message: string) =>
    (
      messages as Record<
        string,
        {
          fields: readonly {
            constraints?: { utf16Min?: number; utf16Max?: number; countMin?: number; countMax?: number }
          }[]
        }
      >
    )[`ycoding.v5.${message}`]!.fields[0].constraints!

  test.each(["UsageAccounting_PromptInput_inputIDs", "UsageAccounting_TaskInput_sessionIDs"])(
    "%s bounds the distinct list at 1 to 100 entries and puts no length bound on each ID",
    (message) => {
      const rule = constraints(message)
      expect([rule.countMin, rule.countMax]).toEqual([1, 100])
      expect([rule.utf16Min, rule.utf16Max]).toEqual([undefined, undefined])
    },
  )
})

describe("generated wire boundary", () => {
  const ids = (prefix: string, units: number, count: number) =>
    Array.from({ length: count }, (_, index) =>
      encodeLossless(`${prefix}${String(index).padStart(units - prefix.length, "a")}`),
    )

  test.each([
    ["msg_", UsageAccounting_PromptInput_inputIDsSchema],
    ["ses_", UsageAccounting_TaskInput_sessionIDsSchema],
  ] as const)("%s IDs of 101 to 128 units are accepted within 1 to 100 entries", (prefix, schema) => {
    for (const units of [prefix.length + 1, 100, 101, 128])
      for (const count of [1, 100])
        expect(
          () => encodeStrict(schema, create(schema, { items: ids(prefix, units, count) })),
          `${count} IDs of ${units} units`,
        ).not.toThrow()
  })

  test.each([
    ["msg_", UsageAccounting_PromptInput_inputIDsSchema],
    ["ses_", UsageAccounting_TaskInput_sessionIDsSchema],
  ] as const)("%s lists outside 1 to 100 entries are rejected by cardinality", (prefix, schema) => {
    for (const units of [prefix.length + 1, 101, 128])
      expect(() => encodeStrict(schema, create(schema, { items: ids(prefix, units, 101) }))).toThrow("collection limit")
    expect(() => encodeStrict(schema, create(schema, { items: [] }))).toThrow("count constraint")
  })

  test("connector family IDs keep their own 1 to 128 unit item bound beside the entry count", () => {
    const schema = session_team_economics_Request_payload_sessionIDsSchema
    const list = (items: readonly string[]) => create(schema, { items: items.map(encodeLossless) })
    expect(() => encodeStrict(schema, list(["s".repeat(128)]))).not.toThrow()
    expect(() => encodeStrict(schema, list(["s".repeat(129)]))).toThrow("text constraint")
    expect(() => encodeStrict(schema, list([""]))).toThrow("text constraint")
    expect(() => encodeStrict(schema, list(Array.from({ length: 128 }, () => "s")))).not.toThrow()
    expect(() => encodeStrict(schema, list(Array.from({ length: 129 }, () => "s")))).toThrow("collection limit")
  })

  test.each([
    ["browser group", browser_action_Request_payload_actionValue6_tabIDsSchema],
    ["browser ungroup", browser_action_Request_payload_actionValue7_tabIDsSchema],
    ["isolated browser group", isolatedBrowser_action_Request_payload_actionValue6_tabIDsSchema],
    ["isolated browser ungroup", isolatedBrowser_action_Request_payload_actionValue7_tabIDsSchema],
  ] as const)("%s tab ID lists accept generated btab_ IDs within 1 to 8 entries", (_, schema) => {
    const tabs = (count: number) => ({ items: ids("btab_", 31, count) })
    expect(() => encodeStrict(schema, create(schema, tabs(1)))).not.toThrow()
    expect(() => encodeStrict(schema, create(schema, tabs(8)))).not.toThrow()
    expect(() => encodeStrict(schema, create(schema, tabs(9)))).toThrow("collection limit")
  })
})
