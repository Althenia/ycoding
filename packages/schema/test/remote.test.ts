import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Remote } from "../src/remote.js"

test("MCP capabilities distinguish unreported and observed absent support without identity fields", () => {
  const decode = Schema.decodeUnknownSync(Remote.McpStatus)
  expect(decode({ state: "on" })).toEqual({ state: "on" })
  const observed = { state: "on", clientCapabilities: [{ protocolVersion: "2026-07-28", elicitation: false, form: false, url: false, observedAt: 0 }] } satisfies Remote.McpStatus
  expect(decode(observed)).toEqual(observed)
  expect(() => decode({ state: "on", clientCapabilities: [{ observedAt: -1 }] })).toThrow()
})

test("MCP status optional strings retain source validation and JSON omission", () => {
  const decode = Schema.decodeUnknownSync(Remote.McpStatus)
  const encode = Schema.encodeSync(Remote.McpStatus)
  for (const value of [
    { state: "on" },
    { state: "on", message: "Ready", url: "https://example.invalid/mcp" },
  ] satisfies Remote.McpStatus[]) {
    expect(JSON.stringify(encode(decode(value)))).toBe(JSON.stringify(value))
  }
  const absent = { state: "on", message: undefined, url: undefined } satisfies Remote.McpStatus
  expect(JSON.stringify(encode(absent))).toBe('{"state":"on"}')
  for (const key of ["message", "url"]) expect(() => decode({ state: "on", [key]: null })).toThrow()
})

test("MCP JSON status rejects null strings and omits undefined while encoding", () => {
  const codec = Schema.toCodecJson(Remote.McpStatus)
  const decode = Schema.decodeUnknownSync(codec)
  const encode = Schema.encodeSync(codec)
  for (const key of ["message", "url"]) expect(() => decode({ state: "on", [key]: null })).toThrow()
  expect(decode({ state: "on" })).toEqual({ state: "on" })
  expect(decode({ state: "on", clientCapabilities: [{ observedAt: 0 }] })).toEqual({ state: "on", clientCapabilities: [{ observedAt: 0 }] })
  expect(() => decode({ state: "on", clientCapabilities: [{}] })).toThrow()
  const value = { state: "on", message: "Ready", url: "https://example.invalid/mcp" } satisfies Remote.McpStatus
  expect(decode(value)).toEqual(value)
  expect(encode(value)).toEqual(value)
  expect(JSON.stringify(encode({ state: "on", message: undefined, url: undefined }))).toBe('{"state":"on"}')
})
