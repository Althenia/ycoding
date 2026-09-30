import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { parseAgentMessage, type RemoteCompletions, type RemoteStatus } from "@ycoding-ai/remote"
import { createRelay } from "../../../infra/cloudflare/src/relay/core"
import { createNoticeStore } from "../../../infra/cloudflare/src/relay/notice-store"
import { createNoticeStorage } from "../../../infra/cloudflare/test/notice-storage"
import { deltaChunk, finishChunk, toolCallChunk } from "../../ai/test/lib/openai-chunks"
import { RemoteAgent, type ConnectionInput } from "../src/remote-bridge"
import { createLocalServer } from "../src/remote-local"
import { createSession, password, startServer } from "./remote-harness"

async function until(check: () => boolean | Promise<boolean>, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Completion flow did not settle")
    await Bun.sleep(10)
  }
}

test("a real task declaration and settled answer reach the authenticated completion API and one relay notice", async () => {
  const scratch = join(import.meta.dir, "../../../.cache/tmp")
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, "work-completion-flow-"))
  let taskRequests = 0
  const server = await startServer(directory, { provider: {
    text: "Verified completion",
    reply: (request) => {
      const tools = typeof request === "object" && request !== null ? Reflect.get(request, "tools") : undefined
      const declares = Array.isArray(tools) && tools.some((tool) => tool?.function?.name === "task_complete")
      if (!declares) return [deltaChunk({ role: "assistant", content: "Verified completion" }), finishChunk("stop")]
      taskRequests++
      return taskRequests === 1
        ? [toolCallChunk("call_verified_completion", "task_complete", "{}"), finishChunk("tool_calls")]
        : [deltaChunk({ role: "assistant", content: "Implemented and verified." }), finishChunk("stop")]
    },
  } })
  const database = new Database(":memory:")
  const notices = createNoticeStore(createNoticeStorage(database))
  const pushed: string[] = []
  const frames: RemoteCompletions[] = []
  const closes: number[] = []
  let status: RemoteStatus | undefined
  let input: ConnectionInput | undefined
  let reopen!: () => Promise<void>
  const relay = createRelay({
    now: Date.now, newID: () => crypto.randomUUID(), send: () => {},
    close: (_id, code) => { closes.push(code) },
    saveSubscriptions: () => {}, savePending: () => {}, notices, saveNoticeSubscription: () => {},
    loadStatus: async () => status, saveStatus: async (value) => { status = value },
    loadOfflineCheck: async () => undefined, saveOfflineCheck: async () => {},
    authorizeClientCommand: async () => ({ ok: true }), authorizeAgentCommand: async () => ({ ok: true }),
    authorityTtlMs: 60_000,
    notifyPush: async (_ownerID, event) => {
      pushed.push(event.category)
      return []
    },
  })
  const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
  const bridge = new RemoteAgent({
    relayURL: "https://relay.example", local,
    credentials: async () => ({ accessToken: "isolated-token", accessExpiresAt: Date.now() + 600_000 }),
    refreshIntervalMs: 3_600_000,
    createConnection: (value) => {
      input = value
      reopen = async () => {
        await relay.attach({ connectionID: "agent", role: "agent", ownerID: "usr_completion", deviceID: "dev_completion", browserSessionID: "dev_completion", credentialExpiresAt: Date.now() + 600_000, subscriptions: [], noticesSubscribed: false, pending: [] })
        value.onOpen()
      }
      return {
        connect: reopen, onMessage: () => {}, disconnect: async () => { relay.detach("agent") },
        send: async (raw) => {
          const parsed = parseAgentMessage(raw)
          if (!parsed.ok) throw new Error("Invalid connector envelope")
          await relay.handleAgentMessage("agent", raw)
          if (parsed.value.type === "completions") frames.push(parsed.value)
        },
      }
    },
  })
  try {
    if (!server.provider) throw new Error("Missing isolated provider")
    const model = { providerID: server.provider.providerID, id: server.provider.modelID }
    await createSession(server, "ses_verified_completion", directory, model)
    await createSession(server, "ses_plain_answer", directory, model)
    expect((await fetch(`${server.base}/api/session/completions`)).status).toBe(401)
    expect((await server.request("/api/session/completions?limit=201")).status).toBe(400)
    expect(await local.completions({ limit: 1 })).toEqual({ data: [] })
    await bridge.connect()
    await until(() => frames.some((frame) => !frame.more))
    const response = await server.request("/api/session/ses_verified_completion/prompt", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "msg_verified_completion", text: "Complete the requested work and verify it." }),
    })
    expect(response.status).toBe(200)
    await until(() => notices.page().total === 1)
    expect(taskRequests).toBe(2)
    const accepted = await local.completions({ limit: 1 })
    expect(accepted.data).toMatchObject([{ sessionID: "ses_verified_completion", inputID: "msg_verified_completion" }])
    expect(accepted.data[0]?.assistantMessageID).toStartWith("msg_")
    expect(accepted.data[0]?.seq).toBeGreaterThan(0)
    expect(notices.page().notices).toMatchObject([{ category: "agent-completed", sessionID: "ses_verified_completion", createdAt: accepted.data[0]?.created }])
    expect(pushed).toEqual(["agent-completed"])
    expect(await local.completions({ limit: 1, after: "ses_verified_completion" })).toEqual({ data: [] })

    const previous = frames.length
    input?.onClose(1006)
    relay.detach("agent")
    await reopen()
    await until(() => frames.length > previous && frames.at(-1)?.more === false)
    expect(notices.page().total).toBe(1)
    expect(pushed).toEqual(["agent-completed"])

    const plain = await server.request("/api/session/ses_plain_answer/prompt", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "msg_plain_answer", text: "Answer without declaring work complete." }),
    })
    expect(plain.status).toBe(200)
    await until(async () => {
      if (taskRequests < 3) return false
      const active = await local.activeSessions()
      return typeof active === "object" && active !== null && !Array.isArray(active) && Object.keys(active).length === 0
    })
    expect((await local.completions({ limit: 200 })).data).toEqual(accepted.data)
    expect(notices.page().total).toBe(1)
    expect(pushed).toEqual(["agent-completed"])
    expect(closes).toEqual([])
  } finally {
    await bridge.close()
    await server.close()
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
