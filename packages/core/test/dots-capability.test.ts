import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCapabilities } from "@ycoding-ai/core/config/capabilities"

const document = (settings: unknown = {}) =>
  new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)(settings) })

const allows = (...documents: Config.Document[]) => ConfigCapabilities.allowsDots(Config.capabilities(documents))

test("Dots stay disabled unless a configuration layer sets dots.enabled to true", () => {
  expect(ConfigCapabilities.allowsDots({})).toBe(false)
  expect(allows()).toBe(false)
  expect(allows(document())).toBe(false)
  expect(allows(document({ dots: {} }))).toBe(false)
  expect(allows(document({ dots: { enabled: false } }))).toBe(false)
  expect(allows(document({ dots: { enabled: true } }))).toBe(true)
})

test("dots.enabled is last-wins per field and an empty or unrelated layer does not reset it", () => {
  expect(allows(document({ dots: { enabled: true } }), document({ dots: { enabled: false } }))).toBe(false)
  expect(allows(document({ dots: { enabled: false } }), document({ dots: { enabled: true } }))).toBe(true)
  expect(allows(document({ dots: { enabled: true } }), document({ dots: {} }))).toBe(true)
  expect(allows(document({ dots: { enabled: true } }), document({ capabilities: { skills: { enabled: false } } }))).toBe(
    true,
  )
  expect(allows(document({ dots: { enabled: true } }), document())).toBe(true)
})

test("dots accepts only a Boolean enabled field and capabilities does not accept a dots key", () => {
  const strict = { onExcessProperty: "error" } as const
  const decode = (value: unknown) => Schema.decodeUnknownSync(Config.Info, strict)(value)
  expect(decode({ dots: { enabled: true } }).dots?.enabled).toBe(true)
  expect(() => decode({ dots: { enabled: "true" } })).toThrow()
  expect(() => decode({ dots: true })).toThrow()
  expect(() => decode({ dots: { enabled: true, profile: "synthetic" } })).toThrow()
  expect(() => decode({ capabilities: { dots: true } })).toThrow()
  expect(() => decode({ capabilities: { dots: { enabled: true } } })).toThrow()
  expect("dots" in ConfigCapabilities.Info.fields).toBe(false)
})

test("the Dots setting does not alter tool selection", () => {
  const capabilities = Config.capabilities([document({ dots: { enabled: false } })])
  expect(ConfigCapabilities.allowsTool(capabilities, "dots_send")).toBe(true)
  expect(
    ConfigCapabilities.allowsTool(
      Config.capabilities([document({ capabilities: { tools: { deny: ["dots_send"] } } })]),
      "dots_send",
    ),
  ).toBe(false)
})
