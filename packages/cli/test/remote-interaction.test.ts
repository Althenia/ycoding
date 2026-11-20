import { expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import type { RemoteRequest } from "@ycoding-ai/remote"
import { createLocalServer, type LocalServer } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"

test("connector forwards only closed Interaction operations after verifying the owning Session", async () => {
  const generation = crypto.randomUUID()
  const owner: SessionInfo = {
    id: "ses_interaction_owner", projectID: "global", scope: "bound", title: "Fixture", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 }, location: { directory: process.cwd() },
  }
  const calls: string[][] = []
  const boundary = {
    listPage: async () => ({ data: [owner] }),
    getSession: async (id) => {
      if (id !== owner.id) throw new Error("unexpected Session lookup")
      return owner
    },
    interactionStatus: async (id) => {
      calls.push(["status", id])
      return { state: "active", generation, platform: "chrome", label: "Fixture" }
    },
    interactionPreview: async (id, fence) => {
      calls.push(["preview", id, fence])
      return { state: "unavailable", generation: fence }
    },
    interactionStop: async (id, fence) => {
      calls.push(["stop", id, fence])
      return { state: "stopped", generation: fence, platform: "chrome", reason: "stopped", cleanup: "pending" }
    },
  } satisfies Partial<LocalServer>
  const local = new Proxy(createLocalServer({ url: "https://example.invalid" }), { get(_target, member) {
    if (Object.hasOwn(boundary, member)) return Reflect.get(boundary, member)
    return () => Promise.reject(new Error("unexpected local operation"))
  } })
  const sessions = createSessionRegistry({ local })
  await sessions.refresh()
  const subscriptions = createSubscriptions()
  const run = async (operation: RemoteRequest["operation"], sessionID: string, input?: RemoteRequest["input"]) => {
    const frames = await executeRemoteOperation({ local, sessions, subscriptions, request: {
      type: "request", id: crypto.randomUUID(), operation, sessionID, ...(input ? { input } : {}),
    } })
    return frames[0]
  }
  expect(await run("session.interaction.stop", "ses_unshared", { generation })).toMatchObject({
    ok: false, error: { code: "session_not_allowed" },
  })
  expect(await run("session.interaction.preview", owner.id, { generation, directory: "/foreign" })).toMatchObject({
    ok: false, error: { code: "invalid_message" },
  })
  expect(calls).toEqual([])
  expect(await run("session.interaction.status", owner.id)).toMatchObject({ ok: true, value: { data: { state: "active", generation } } })
  expect(await run("session.interaction.preview", owner.id, { generation })).toMatchObject({ ok: true, value: { data: { state: "unavailable", generation } } })
  expect(await run("session.interaction.stop", owner.id, { generation })).toMatchObject({ ok: true, value: { data: { state: "stopped", generation } } })
  expect(calls).toEqual([["status", owner.id], ["preview", owner.id, generation], ["stop", owner.id, generation]])
})
