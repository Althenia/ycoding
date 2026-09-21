import { describe, expect, test } from "bun:test"
import { browserStorage, readStored, writeStored } from "./storage"

function memoryStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    },
    removeItem: (key: string) => {
      entries.delete(key)
    },
  }
}

describe("readStored", () => {
  test("returns the decoded value", () => {
    const storage = memoryStorage({ theme: "dark" })
    expect(readStored(storage, "theme", (raw) => raw)).toBe("dark")
  })

  test("returns undefined for a missing key or rejected value", () => {
    const storage = memoryStorage()
    expect(readStored(storage, "theme", (raw) => raw)).toBeUndefined()
    expect(readStored(storage, "theme", () => undefined)).toBeUndefined()
  })

  test("survives absent storage, a blocked getter, and a throwing decoder", () => {
    expect(readStored(undefined, "theme", (raw) => raw)).toBeUndefined()
    expect(readStored(null, "theme", (raw) => raw)).toBeUndefined()
    const blocked = {
      getItem: () => {
        throw new Error("storage disabled")
      },
      setItem: () => {},
    }
    expect(readStored(blocked, "theme", (raw) => raw)).toBeUndefined()
    const storage = memoryStorage({ theme: "dark" })
    expect(
      readStored(storage, "theme", () => {
        throw new Error("decode failed")
      }),
    ).toBeUndefined()
  })
})

describe("browserStorage", () => {
  test("survives a blocked localStorage accessor", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage blocked by privacy settings")
      },
    })
    try {
      expect(browserStorage()).toBeUndefined()
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor)
      else Reflect.deleteProperty(globalThis, "localStorage")
    }
  })
})

describe("writeStored", () => {
  test("persists a value and reports success", () => {
    const storage = memoryStorage()
    expect(writeStored(storage, "theme", "dark")).toBe(true)
    expect(storage.getItem("theme")).toBe("dark")
  })

  test("reports failure when storage is absent or rejects the write", () => {
    expect(writeStored(undefined, "theme", "dark")).toBe(false)
    expect(
      writeStored(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota exceeded")
          },
        },
        "theme",
        "dark",
      ),
    ).toBe(false)
  })
})
