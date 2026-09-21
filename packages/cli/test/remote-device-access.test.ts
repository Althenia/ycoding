import { expect, test } from "bun:test"
import type { RemoteRequest } from "@ycoding-ai/remote"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalServer } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"
import { createSession, password, startServer } from "./remote-harness"

test("resolves a real Session beyond 200 backend results across authoritative Locations", async () => {
  const root = await mkdtemp(join(tmpdir(), "ycoding-remote-many-sessions-"))
  const first = join(root, "first")
  const second = join(root, "second")
  await Promise.all([mkdir(first), mkdir(second)])
  const server = await startServer(first)
  try {
    for (let index = 0; index < 205; index++) {
      await createSession(server, `ses_${index.toString().padStart(3, "0")}`, index % 2 === 0 ? first : second)
    }
    const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
    const registry = createSessionRegistry({ local, staleMs: 0 })
    const request: RemoteRequest = {
      type: "request",
      id: "req_1",
      operation: "session.messages",
      sessionID: "ses_203",
    }

    const frames = await executeRemoteOperation({ request, sessions: registry, subscriptions: createSubscriptions(), local })

    expect(frames).toEqual([{ type: "response", id: "req_1", ok: true, value: { data: [] } }])
    expect((await registry.list()).map((session) => session.id)).toContain("ses_204")
    expect((await registry.get("ses_203"))?.location.directory).toBe(second)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
