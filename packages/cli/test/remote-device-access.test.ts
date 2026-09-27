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
    const registry = createSessionRegistry({ local })
    const request: RemoteRequest = {
      type: "request",
      id: "req_1",
      operation: "session.messages",
      sessionID: "ses_203",
    }

    const frames = await executeRemoteOperation({ request, sessions: registry, subscriptions: createSubscriptions(), local })

    expect(frames).toEqual([{ type: "response", id: "req_1", ok: true, value: { data: [] } }])
    await registry.refresh()
    expect(registry.snapshot().map((session) => session.id)).toContain("ses_204")
    expect((await registry.get("ses_203"))?.location.directory).toBe(second)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)

test("reads the real bounded direct-child page at the verified parent's Location", async () => {
  const root = await mkdtemp(join(tmpdir(), "ycoding-remote-team-"))
  const server = await startServer(root)
  try {
    await createSession(server, "ses_team_root", root)
    const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
    const page = await local.subagentPage("ses_team_root", { directory: root })
    if (typeof page !== "object" || page === null) throw new Error("expected a task page")
    const summary = Reflect.get(page, "summary")
    const cursor = Reflect.get(page, "cursor")
    expect(Reflect.get(page, "data")).toEqual([])
    expect(typeof summary === "object" && summary !== null ? Reflect.get(summary, "total") : undefined).toBe(0)
    expect(typeof cursor === "object" && cursor !== null ? Reflect.get(cursor, "next") : undefined).toBeUndefined()
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
