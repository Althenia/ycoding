import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRemoteControlStateStore } from "../src/remote-control/state"

const directories: string[] = []
afterEach(async () => {
  while (directories.length) await rm(directories.pop()!, { recursive: true, force: true })
})

async function stateFile() {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-rc-state-"))
  directories.push(directory)
  return path.join(directory, "remote-control.json")
}

const enrollment = { serverID: "synthetic-server-1", environmentID: "synthetic-environment-1", serverName: "Synthetic desk", remoteControlEnabled: true, updatedAt: 1 }

test("a new state file persists one installation ID for every store and restart before any enrollment", async () => {
  const file = await stateFile()
  const [first, second] = await Promise.all([createRemoteControlStateStore(file).load(), createRemoteControlStateStore(file).load()])
  expect(first.installationID.length).toBeGreaterThan(0)
  expect(second.installationID).toBe(first.installationID)
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ installationID: first.installationID, enrollments: {} })
  const restarted = createRemoteControlStateStore(file)
  expect((await restarted.load()).installationID).toBe(first.installationID)
  await restarted.saveEnrollment({ websocketURL: "wss://synthetic.test/rc", accountHash: "synthetic-hash", enrollment })
  expect((await createRemoteControlStateStore(file).load()).installationID).toBe(first.installationID)
})

test("an established installation ID and its enrollments are never replaced", async () => {
  const file = await stateFile()
  const store = createRemoteControlStateStore(file)
  await writeFile(file, JSON.stringify({ installationID: "synthetic-installation-1", enrollments: {} }), { mode: 0o600 })
  await store.saveEnrollment({ websocketURL: "wss://synthetic.test/rc", accountHash: "synthetic-hash", enrollment })
  const reloaded = await createRemoteControlStateStore(file).load()
  expect(reloaded.installationID).toBe("synthetic-installation-1")
  expect(Object.values(reloaded.enrollments)).toEqual([enrollment])
})

test.each([
  { name: "a missing installation ID", value: { enrollments: { synthetic: enrollment } } },
  { name: "an empty installation ID", value: { installationID: "", enrollments: {} } },
  { name: "a non-string installation ID", value: { installationID: 5, enrollments: {} } },
  { name: "unparseable state", value: "{not json" },
])("state with $name fails closed without minting or writing another installation", async ({ value }) => {
  const file = await stateFile()
  const before = typeof value === "string" ? value : JSON.stringify(value)
  await writeFile(file, before, { mode: 0o600 })
  const store = createRemoteControlStateStore(file)
  await expect(store.load()).rejects.toThrow()
  await expect(store.saveEnrollment({ websocketURL: "wss://synthetic.test/rc", accountHash: "synthetic-hash", enrollment })).rejects.toThrow()
  expect(await readFile(file, "utf8")).toBe(before)
})
