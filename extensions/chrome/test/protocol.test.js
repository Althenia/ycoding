import { describe, expect, test } from "bun:test"
import {
  MAX_SHARED_TABS,
  VERSION,
  actionGuardFailure,
  connectURL,
  reconnectDelay,
  safePage,
  validateServerURL,
} from "../protocol.js"

describe("Chrome bridge protocol", () => {
  test("keeps pairing and reconnect credentials in first frames rather than URLs", () => {
    expect(VERSION).toBe(2)
    expect(connectURL("http://127.0.0.1:4096", "ses_selected")).toBe(
      "ws://127.0.0.1:4096/api/session/ses_selected/browser/connect",
    )
    expect(reconnectDelay(0)).toBe(1_000)
    expect(reconnectDelay(4)).toBe(16_000)
    expect(reconnectDelay(20)).toBe(30_000)
  })

  test("accepts only loopback bridge URLs", () => {
    expect(validateServerURL("http://127.0.0.1:4096").toString()).toBe("http://127.0.0.1:4096/")
    expect(validateServerURL("http://localhost:4096").toString()).toBe("http://localhost:4096/")
    expect(() => validateServerURL("https://example.com")).toThrow()
    expect(() => validateServerURL("http://192.168.1.2:4096")).toThrow()
    expect(() => validateServerURL("http://user@localhost:4096")).toThrow()
  })

  test("removes query and fragment and rejects credential-bearing page URLs", () => {
    expect(safePage("https://example.test/form?token=secret#private")).toEqual({
      origin: "https://example.test",
      path: "/form",
    })
    expect(() => safePage("https://user:pass@example.test/form")).toThrow()
    expect(() => safePage("chrome://settings")).toThrow()
  })

  test("caps explicitly shared tabs", () => {
    expect(MAX_SHARED_TABS).toBe(8)
  })

  test("fails guarded mutations closed when Chrome cannot enforce no downloads", () => {
    const message =
      "Chrome's extension debugger API cannot enforce the required no-download guard; navigate, click, and type are unavailable"
    expect(actionGuardFailure("navigate")).toBe(message)
    expect(actionGuardFailure("click")).toBe(message)
    expect(actionGuardFailure("type")).toBe(message)
    expect(actionGuardFailure("scroll")).toBeUndefined()
    expect(actionGuardFailure("capture")).toBeUndefined()
  })
})
