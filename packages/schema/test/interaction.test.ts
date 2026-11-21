import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Interaction } from "../src/interaction.js"

describe("Interaction wire contract", () => {
  test("admits only bounded typed native actions", () => {
    const decode = Schema.decodeUnknownSync(Interaction.Action, { onExcessProperty: "error" })
    expect(decode({ platform: "chrome", type: "scroll", deltaY: 12 })).toEqual({
      platform: "chrome", type: "scroll", deltaY: 12,
    })
    expect(decode({ platform: "macos", type: "press", elementID: crypto.randomUUID() }).type).toBe("press")
    expect(() => decode({ platform: "macos", type: "navigate", url: "https://example.test/" })).toThrow()
    expect(() => decode({ platform: "chrome", type: "navigate", url: "javascript:void(0)" })).toThrow()
    expect(() => decode({ platform: "chrome", type: "navigate", url: "https://user@example.test/" })).toThrow()
    expect(() => decode({ platform: "chrome", type: "scroll", deltaY: 12, script: "void(0)" })).toThrow()
    expect(() => decode({ platform: "chrome", type: "scroll", deltaY: 10001 })).toThrow()
  })

  test("separates pending consent and preview pixels", () => {
    const decodeStatus = Schema.decodeUnknownSync(Interaction.Status, { onExcessProperty: "error" })
    const generation = crypto.randomUUID()
    expect(decodeStatus({ state: "pending", platform: "chrome", generation }).state).toBe("pending")
    expect(() => decodeStatus({ state: "pending", platform: "chrome", generation, authorization: "proof" })).toThrow()
    const decodePreview = Schema.decodeUnknownSync(Interaction.Preview)
    expect(() => decodePreview({ state: "ready", generation, frame: { mimeType: "image/svg+xml", base64: "YWJj", width: 1, height: 1 } })).toThrow()
  })

  test("paused status and action results carry one typed foreground reason", () => {
    const decodeStatus = Schema.decodeUnknownSync(Interaction.Status, { onExcessProperty: "error" })
    const generation = Interaction.Generation.create()
    const paused = { state: "paused", platform: "macos", generation, label: "Selected macOS window", reason: "file_chooser" } as const
    expect(decodeStatus(paused)).toEqual(paused)
    expect(() => decodeStatus({ ...paused, reason: "busy" })).toThrow()
    expect(() => decodeStatus({ state: "paused", platform: "macos", generation, label: "Selected macOS window" })).toThrow()
    const decodeResult = Schema.decodeUnknownSync(Interaction.ActionResult, { onExcessProperty: "error" })
    for (const reason of ["foreground_required", "file_chooser", "dialog", "captcha", "sensitive", "user_takeover"] as const)
      expect(decodeResult({ outcome: "paused", reason })).toEqual({ outcome: "paused", reason })
    expect(() => decodeResult({ outcome: "paused" })).toThrow()
  })

  test("a capture carries one bounded frame and optional safe title and URL", () => {
    const decode = Schema.decodeUnknownOption(Interaction.Capture, { onExcessProperty: "error" })
    const frame = { mimeType: "image/png", width: 1, height: 1, base64: Buffer.alloc(8).toString("base64") }
    const generation = crypto.randomUUID()
    expect(decode({ generation, frame })._tag).toBe("Some")
    expect(decode({ generation, frame, title: "Checkout", url: "https://example.test/cart" })._tag).toBe("Some")
    expect(decode({ generation, frame, title: "line\nbreak" })._tag).toBe("None")
    expect(decode({ generation, frame, url: "https://user@example.test/" })._tag).toBe("None")
    expect(decode({ generation, frame: { ...frame, width: 961 } })._tag).toBe("None")
    expect(decode({ frame })._tag).toBe("None")
  })

  test("a script request admits only a bounded source in script or code mode", () => {
    const decode = Schema.decodeUnknownOption(Interaction.ScriptRequest, { onExcessProperty: "error" })
    expect(decode({ mode: "script", source: "return 1" })._tag).toBe("Some")
    expect(decode({ mode: "code", source: "x", timeoutMs: 60_000 })._tag).toBe("Some")
    expect(decode({ mode: "code", source: "x".repeat(65_536), timeoutMs: 100 })._tag).toBe("Some")
    for (const input of [
      { mode: "eval", source: "x" }, { mode: "script", source: "" }, { mode: "script", source: "x".repeat(65_537) },
      { mode: "script", source: "x", timeoutMs: 99 }, { mode: "script", source: "x", timeoutMs: 60_001 },
      { mode: "script", source: "x", timeoutMs: 1.5 }, { mode: "script", source: "x", userGesture: true },
    ]) expect(decode(input)._tag).toBe("None")
  })

  test("a script result reports one bounded outcome with logs", () => {
    const decode = Schema.decodeUnknownOption(Interaction.ScriptResult, { onExcessProperty: "error" })
    const logs = [{ level: "warn", text: "careful" }]
    for (const result of [
      { outcome: "completed", value: { rows: [1, "two", null, true] }, logs },
      { outcome: "completed", valueTruncated: true, logs: [], logsTruncated: true },
      { outcome: "error", error: { name: "TypeError", message: "x is undefined", stack: "at <anonymous>" }, logs },
      { outcome: "timeout", logs }, { outcome: "stopped", logs: [] },
      { outcome: "refused", reason: "unsupported" }, { outcome: "paused", reason: "dialog" },
    ]) expect(decode(result)._tag).toBe("Some")
    for (const result of [
      { outcome: "completed", value: "x".repeat(65_536), logs: [] },
      { outcome: "completed", logs: Array.from({ length: 201 }, () => ({ level: "log", text: "x" })) },
      { outcome: "completed", logs: [{ level: "trace", text: "x" }] },
      { outcome: "completed", logs: [{ level: "log", text: "x".repeat(2049) }] },
      { outcome: "error", error: { name: "x".repeat(129), message: "m" }, logs: [] },
      { outcome: "error", error: { name: "E", message: "m", stack: "x".repeat(8193) }, logs: [] },
      { outcome: "timeout" }, { outcome: "refused", reason: "busy", logs: [] }, { outcome: "uncertain" },
    ]) expect(decode(result)._tag).toBe("None")
  })

  test("requires exactly one safe URL for owned or isolated Chrome", () => {
    const decode = Schema.decodeUnknownSync(Interaction.Request)
    expect(decode({ platform: "chrome", mode: "isolated", url: "https://example.test/" })).toMatchObject({ mode: "isolated" })
    expect(() => decode({ platform: "chrome", mode: "owned" })).toThrow()
    expect(() => decode({ platform: "chrome", mode: "tab", url: "https://example.test/" })).toThrow()
    expect(() => decode({ platform: "macos", url: "https://example.test/" })).toThrow()
    expect(() => decode({ platform: "chrome", mode: "isolated", url: "file:///private" })).toThrow()
  })

  test("Chrome targets require a query-free document pathname and public status cannot carry it", () => {
    const decode = Schema.decodeUnknownSync(Interaction.Target, { onExcessProperty: "error" })
    const target = { id: crypto.randomUUID(), kind: "chrome-tab", label: "Fixture", origin: "https://example.test" }
    expect(decode({ ...target, pathname: "/directory/item%20one" })).toMatchObject({ pathname: "/directory/item%20one" })
    for (const pathname of [undefined, "relative", "/admin?query", "/admin#fragment", "/admin\\folder", "/admin\u0000"]) {
      expect(() => decode({ ...target, pathname })).toThrow()
    }
    const decodeStatus = Schema.decodeUnknownSync(Interaction.Status, { onExcessProperty: "error" })
    expect(() => decodeStatus({ state: "active", platform: "chrome", generation: crypto.randomUUID(), label: target.label, pathname: "/admin" })).toThrow()
  })

  test("native observation wire carries an optional pathname but never an origin", () => {
    const decode = Schema.decodeUnknownOption(Interaction.Observation, { onExcessProperty: "error" })
    const observed = { revision: 1, elements: [] }
    expect(decode(observed)._tag).toBe("Some")
    expect(decode({ ...observed, pathname: "/approved" })._tag).toBe("Some")
    expect(decode({ ...observed, pathname: "/approved", origin: "https://example.test" })._tag).toBe("None")
  })

  test("preview frames admit exactly 160 KiB decoded and at most 960 by 720 pixels", () => {
    const decode = Schema.decodeUnknownOption(Interaction.Frame)
    const frame = { mimeType: "image/jpeg", width: 960, height: 720, base64: Buffer.alloc(160 * 1024).toString("base64") }
    expect(decode(frame)._tag).toBe("Some")
    for (const sizes of [
      { width: 961 }, { height: 721 }, { base64: Buffer.alloc(160 * 1024 + 1).toString("base64") },
      { base64: Buffer.alloc(160 * 1024 + 2).toString("base64") }, { base64: "aW1hZ2U=\n" },
    ]) expect(decode({ ...frame, ...sizes })._tag).toBe("None")
  })
})
