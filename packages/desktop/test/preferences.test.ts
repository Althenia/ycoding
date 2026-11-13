import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readPreferences, savePreferences, validateSelection } from "../src/preferences"
import { appendAppLog } from "../src/app-log"

test.each([
  [{ mode: "own" }, { mode: "own" }],
  [{ mode: "shared" }, { mode: "shared" }],
  [{ mode: "shared", server: "  " }, { mode: "shared" }],
  [{ mode: "shared", server: "https://example.test/" }, { mode: "shared", server: "https://example.test/" }],
] as const)("validates the explicit backend choice without starting it: %j", (input, expected) => {
  expect(validateSelection(input)).toEqual(expected)
})

test.each([
  {}, { mode: "pwa" }, { mode: "own", server: "http://127.0.0.1:9" },
  { mode: "shared", server: "file:///tmp/backend" },
  { mode: "shared", server: "http://user:secret@example.test" },
  { mode: "shared", server: "https://example.test/?token=synthetic" },
  { mode: "shared", server: "https://example.test/#key" },
  { mode: "shared", server: "https://example.test/api" },
  { mode: "shared", server: "not a URL" },
])("rejects unsafe or incompatible backend choices: %j", (input) => {
  expect(() => validateSelection(input)).toThrow()
})

test("the shared endpoint limit counts UTF-8 bytes", () => {
  const origin = "http://127.0.0.1:4096/"
  const padded = `${origin}${"\u00a0".repeat(1013)}`
  expect(new TextEncoder().encode(padded).length).toBe(2048)
  expect(validateSelection({ mode: "shared", server: padded })).toEqual({ mode: "shared", server: origin })
  expect(() => validateSelection({ mode: "shared", server: `${padded}\u00a0` })).toThrow("Enter a valid shared endpoint.")
})

test("remembers mode and a separate safe endpoint without private credentials or hydration effects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-preferences-"))
  const file = path.join(root, "preferences.json")
  try {
    expect(await readPreferences(file)).toEqual({})
    await savePreferences(file, { mode: "shared", server: "http://127.0.0.1:54321/" })
    expect(await readPreferences(file)).toEqual({ selection: { mode: "shared", server: "http://127.0.0.1:54321/" }, sharedEndpoint: "http://127.0.0.1:54321/" })
    const stored = JSON.parse(await fs.readFile(file, "utf8"))
    expect(stored).toEqual({ mode: "shared", sharedEndpoint: "http://127.0.0.1:54321/" })
    await savePreferences(file, { mode: "own" })
    expect(await readPreferences(file)).toEqual({ selection: { mode: "own" }, sharedEndpoint: "http://127.0.0.1:54321/" })
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ mode: "own", sharedEndpoint: "http://127.0.0.1:54321/" })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("reports corrupt or blocked preferences without overwriting them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-corrupt-"))
  const file = path.join(root, "preferences.json")
  try {
    await fs.writeFile(file, "{")
    expect((await readPreferences(file)).error).toContain("read")
    await expect(savePreferences(file, { mode: "own" })).rejects.toThrow("read")
    expect(await fs.readFile(file, "utf8")).toBe("{")
    expect((await readPreferences(root)).error).toContain("read")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("the app log appends timestamped lines and keeps one bounded previous file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-log-"))
  const file = path.join(directory, "logs", "desktop.log")
  await appendAppLog(file, "first line", 64)
  expect(await fs.readFile(file, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z first line\n$/)
  await appendAppLog(file, "x".repeat(100), 64)
  await appendAppLog(file, "after rotation", 64)
  expect(await fs.readFile(file + ".1", "utf8")).toContain("x".repeat(100))
  const current = await fs.readFile(file, "utf8")
  expect(current).toContain("after rotation")
  expect(current).not.toContain("first line")
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  await expect(appendAppLog(path.join(file, "nested", "desktop.log"), "unwritable", 64)).resolves.toBeUndefined()
})
