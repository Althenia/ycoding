import { describe, expect, test } from "bun:test"
import { displayDeviceName } from "./device-alias"

describe("account-shared device names", () => {
  test("uses only the canonical alias and retains the real hostname", () => {
    const device = { id: "dev_one", name: "synthetic-host.local", alias: "Studio" }
    expect(displayDeviceName(device)).toBe("Studio")
    expect(device.name).toBe("synthetic-host.local")
    expect(displayDeviceName({ ...device, alias: null })).toBe(device.name)
    expect(displayDeviceName({ id: device.id, name: device.name })).toBe(device.name)
  })

  test("keeps distinct IDs independent even when hostnames match", () => {
    expect([displayDeviceName({ id: "dev_one", name: "host", alias: "One" }), displayDeviceName({ id: "dev_two", name: "host", alias: "Two" })]).toEqual(["One", "Two"])
  })
})
