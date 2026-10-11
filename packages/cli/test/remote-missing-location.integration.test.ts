import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createLocalServer } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"
import { createSession, password, startServer } from "./remote-harness"

test("a remote catalog refuses a missing recorded directory before booting its Location and remains recoverable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-missing-location-"))
  const directory = path.join(root, "worktree")
  await mkdir(directory)
  const server = await startServer(root)
  const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
  const sessions = createSessionRegistry({ local })
  try {
    await createSession(server, "ses_missing", directory)
    await sessions.refresh()
    await rename(directory, `${directory}-moved`)
    const before = server.logs.filter((line) => line.includes("location services booted")).length
    const request = { type: "request", id: "req_catalog", operation: "session.catalog", sessionID: "ses_missing" } as const
    expect(await executeRemoteOperation({ request, local, sessions, subscriptions: createSubscriptions() })).toEqual([
      { type: "response", id: "req_catalog", ok: false, error: { code: "invalid_message", message: "The recorded directory is unavailable on this device; restore it before retrying" } },
    ])
    expect(server.logs.filter((line) => line.includes("location services booted"))).toHaveLength(before)
    expect(sessions.ids()).toContain("ses_missing")
    await rename(`${directory}-moved`, directory)
    expect(await executeRemoteOperation({ request: { ...request, id: "req_restored" }, local, sessions, subscriptions: createSubscriptions() })).toMatchObject([
      { id: "req_restored", ok: true, value: { agents: expect.any(Array), models: expect.any(Array) } },
    ])
  } finally { await server.close(); await rm(root, { recursive: true, force: true }) }
}, 15_000)
