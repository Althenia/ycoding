import { describe, expect, test } from "bun:test"
import { MAX_SHARED_TABS, VERSION, connectURL, reconnectDelay, safePage, validateServerURL } from "../protocol.js"

describe("Chrome bridge protocol", () => {
  test("identifies YCoding in Chrome and ships toolbar and popup icons at the declared sizes", async () => {
    const manifest = await Bun.file(new URL("../manifest.json", import.meta.url)).json()
    expect(manifest.name).toBe("YCoding")
    expect(manifest.permissions).toEqual(["alarms", "debugger", "storage", "tabs", "tabGroups"])
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*", "http://localhost/*"])
    expect(manifest.action.default_icon).toMatchObject({ 16: manifest.icons["16"], 32: manifest.icons["32"] })
    for (const size of [16, 32, 48, 128]) {
      const image = new DataView(await Bun.file(new URL(`../${manifest.icons[size]}`, import.meta.url)).arrayBuffer())
      expect(image.getUint32(16)).toBe(size)
      expect(image.getUint32(20)).toBe(size)
    }
  })
  test("keeps pairing and reconnect credentials in first frames rather than URLs", () => {
    expect(VERSION).toBe(3)
    expect(connectURL("http://127.0.0.1:4096")).toBe("ws://127.0.0.1:4096/api/browser/connect")
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

  test("caps paired profile tabs", () => {
    expect(MAX_SHARED_TABS).toBe(8)
  })
})
