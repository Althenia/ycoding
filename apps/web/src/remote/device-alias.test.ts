import { describe, expect, test } from "bun:test"
import {
  clearDeviceAlias,
  deviceAliasStorageKey,
  displayDeviceName,
  readDeviceAliases,
  setDeviceAlias,
} from "./device-alias"

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

describe("browser-local device aliases", () => {
  test("reads aliases keyed by device ID and ignores malformed storage", () => {
    const saved = storage({ [deviceAliasStorageKey]: JSON.stringify({ dev_one: "Work Mac", dev_two: "Lab" }) })
    expect(readDeviceAliases(saved)).toEqual({ dev_one: "Work Mac", dev_two: "Lab" })
    expect(readDeviceAliases(storage({ [deviceAliasStorageKey]: "invalid" }))).toEqual({})
  })

  test("trims and bounds aliases and clears an empty value", () => {
    const saved = storage()
    expect(setDeviceAlias("dev_one", "  Travel Mac  ", saved)).toEqual({ dev_one: "Travel Mac" })
    expect(setDeviceAlias("dev_two", "x".repeat(60), saved)).toEqual({ dev_one: "Travel Mac", dev_two: "x".repeat(48) })
    expect(clearDeviceAlias("dev_one", saved)).toEqual({ dev_two: "x".repeat(48) })
    expect(readDeviceAliases(saved)).toEqual({ dev_two: "x".repeat(48) })
    expect(setDeviceAlias("dev_two", "   ", saved)).toEqual({})
  })

  test("shows the alias when present and otherwise preserves the relay hostname", () => {
    const device = { id: "dev_one", name: "Kritthapass-MacBook-Pro.local" }
    expect(displayDeviceName(device, { dev_one: "Work Mac" })).toBe("Work Mac")
    expect(displayDeviceName(device, {})).toBe(device.name)
  })

  test("keeps the in-memory result when browser storage is unavailable", () => {
    const unavailable = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    }
    expect(readDeviceAliases(unavailable)).toEqual({})
    expect(setDeviceAlias("dev_one", "Work Mac", unavailable)).toEqual({ dev_one: "Work Mac" })
  })
})
