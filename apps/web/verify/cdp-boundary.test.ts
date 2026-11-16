import { expect, test } from "bun:test"
import { cdpResponses, decodeArray, decodeBoolean, decodeCDPMessage, decodeDictionary, decodeLiteral, decodeNullable, decodeNumber, decodeOptional, decodeRecord, decodeString, decodeUnion } from "./cdp"

test("the message boundary correlates responses and leaves events unclaimed", () => {
  expect(decodeCDPMessage({ method: "Page.loadEventFired", params: { timestamp: 1 } })).toBeUndefined()
  expect(decodeCDPMessage({ id: 2, result: { targetId: "target_fixture" } })).toEqual({ id: 2, result: { targetId: "target_fixture" } })
  expect(decodeCDPMessage({ id: 3, error: { code: -32601, message: "Unknown method" } })).toEqual({ id: 3, error: "Unknown method" })
})

test.each([null, [], "response", { id: "1", result: {} }, { id: 0, result: {} }, { id: 1.5, result: {} }, { id: 1 }, { id: 1, error: {} }].map((value) => [value] as const))("the message boundary rejects malformed response %j", (value) => {
  expect(() => decodeCDPMessage(value)).toThrow()
})

const validResponses: readonly { method: keyof typeof cdpResponses; value: unknown; expected: unknown }[] = [
  { method: "Target.createTarget", value: { targetId: "target_fixture" }, expected: { targetId: "target_fixture" } },
  { method: "Target.attachToTarget", value: { sessionId: "session_fixture" }, expected: { sessionId: "session_fixture" } },
  { method: "DOM.getDocument", value: { root: { nodeId: 1, children: [] } }, expected: { root: { nodeId: 1, children: [] } } },
  { method: "DOM.querySelector", value: { nodeId: 0 }, expected: { nodeId: 0 } },
  { method: "CSS.getPlatformFontsForNode", value: { fonts: [{ familyName: "Fixture Sans", postScriptName: "FixtureSans", isCustomFont: true, glyphCount: 4 }] }, expected: { fonts: [{ familyName: "Fixture Sans", postScriptName: "FixtureSans", isCustomFont: true, glyphCount: 4 }] } },
  { method: "Page.captureScreenshot", value: { data: "aW1hZ2U=" }, expected: { data: "aW1hZ2U=" } },
  { method: "Page.getInstallabilityErrors", value: { installabilityErrors: [{ errorId: "manifest-missing", errorArguments: [] }] }, expected: { installabilityErrors: [{ errorId: "manifest-missing", errorArguments: [] }] } },
  { method: "Runtime.evaluate", value: { result: { type: "object", value: { count: 3 } } }, expected: { count: 3 } },
]

test("union validation preserves both decoder failures", () => {
  const first = new Error("First decoder refused the value")
  const second = new Error("Second decoder refused the value")
  try {
    decodeUnion(() => { throw first }, () => { throw second })(null)
    throw new Error("Both decoders accepted an invalid value")
  } catch (cause) {
    if (!(cause instanceof AggregateError)) throw cause
    expect(cause.errors).toEqual([first, second])
  }
})

for (const { method, value, expected } of validResponses) {
  test(`${method} preserves a valid protocol response`, () => {
    expect(cdpResponses[method](value)).toEqual(expected)
  })
  test(`${method} rejects a missing response body`, () => {
    expect(() => cdpResponses[method](undefined)).toThrow()
    expect(() => cdpResponses[method]({})).toThrow()
  })
}

const invalidResponses: readonly { method: keyof typeof cdpResponses; value: unknown }[] = [
  { method: "Target.createTarget", value: { targetId: 1 } },
  { method: "Target.attachToTarget", value: { sessionId: false } },
  { method: "DOM.getDocument", value: { root: { nodeId: "1" } } },
  { method: "DOM.querySelector", value: { nodeId: Number.NaN } },
  { method: "CSS.getPlatformFontsForNode", value: { fonts: [{ familyName: "Fixture Sans", isCustomFont: "yes", glyphCount: 4 }] } },
  { method: "CSS.getPlatformFontsForNode", value: { fonts: [{ familyName: "Fixture Sans", isCustomFont: true, glyphCount: "4" }] } },
  { method: "Page.captureScreenshot", value: { data: null } },
  { method: "Page.getInstallabilityErrors", value: { installabilityErrors: [{ errorId: 1 }] } },
  { method: "Runtime.evaluate", value: { result: { type: 3, value: "wrong" } } },
]

for (const { method, value } of invalidResponses) test(`${method} rejects malformed consumed fields ${JSON.stringify(value)}`, () => {
  expect(() => cdpResponses[method](value)).toThrow()
})

test("runtime values remain unknown and browser exceptions retain their description", () => {
  expect(cdpResponses["Runtime.evaluate"]({ result: { type: "undefined" } })).toBeUndefined()
  expect(cdpResponses["Runtime.evaluate"]({ result: { type: "object", value: null } })).toBeNull()
  expect(() => cdpResponses["Runtime.evaluate"]({ exceptionDetails: { text: "Uncaught", exception: { description: "Fixture failure" } } })).toThrow("Fixture failure")
  expect(() => cdpResponses["Runtime.evaluate"]({ exceptionDetails: { text: "Fixture failure" } })).toThrow("Fixture failure")
  expect(() => cdpResponses["Runtime.evaluate"]({ exceptionDetails: { text: 1 } })).toThrow()
})

test("primitive and compound decoders validate every consumed value", () => {
  expect(decodeString("")).toBe("")
  expect(decodeNumber(0)).toBe(0)
  expect(decodeBoolean(false)).toBe(false)
  expect(decodeRecord({ fixture: true })).toEqual({ fixture: true })
  expect(decodeArray(decodeNumber)([0, 1])).toEqual([0, 1])
  expect(decodeOptional(decodeNullable(decodeString))(undefined)).toBeUndefined()
  expect(decodeOptional(decodeNullable(decodeString))(null)).toBeNull()
  expect(decodeOptional(decodeNullable(decodeString))("fixture")).toBe("fixture")
  expect(decodeUnion(decodeLiteral("ready"), decodeNumber)("ready")).toBe("ready")
  expect(decodeUnion(decodeLiteral("ready"), decodeNumber)(0)).toBe(0)
  expect(decodeDictionary(decodeBoolean)({ enabled: true, disabled: false })).toEqual({ enabled: true, disabled: false })
  expect(() => decodeString(1)).toThrow()
  expect(() => decodeNumber(Number.POSITIVE_INFINITY)).toThrow()
  expect(() => decodeBoolean("true")).toThrow()
  expect(() => decodeRecord([])).toThrow()
  expect(() => decodeArray(decodeNumber)([0, "1"])).toThrow()
  expect(() => decodeOptional(decodeString)(null)).toThrow()
  expect(() => decodeNullable(decodeString)(undefined)).toThrow()
  expect(() => decodeUnion(decodeLiteral("ready"), decodeNumber)(false)).toThrow()
  expect(() => decodeDictionary(decodeBoolean)({ enabled: "true" })).toThrow()
})
