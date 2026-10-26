import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { OpenAICodex } from "@ycoding-ai/core/plugin/provider/openai-codex"
import {
  buildConnectHeaders,
  buildEnrollHeaders,
  buildEnrollRequest,
  decodeEnrollResponse,
  decodePairingStartResponse,
  deviceKindFromMachineName,
  enrollOs,
  enrollURL,
  nextActionForHttp,
  recognizedMissingAppServer,
  reconnectDelay,
  refreshURL,
  websocketURL,
} from "../src/remote-control/types"
import { Reassembler, encodeOutbound } from "../src/remote-control/envelope"
import { createRemoteControlAppServer, type RemoteControlBackend } from "../src/remote-control/app-server"
import { createRemoteControlStateStore } from "../src/remote-control/state"
import { createRemoteControlHost, type RemoteControlSocket } from "../src/remote-control/host"

const credential = { access: "access-token-value", accountID: "account-id-value", key: "credkey", profile: "Work" }

describe("remote-control wire types", () => {
  test("builds enroll request in settled field order with imported Codex identity", () => {
    const request = buildEnrollRequest({ name: "box.local", installationID: "install-1" })
    expect(Object.keys(request)).toEqual(["name", "os", "arch", "app_server_version", "installation_id"])
    expect(request.name).toBe("box.local")
    expect(request.installation_id).toBe("install-1")
    expect(request.app_server_version).toBe(OpenAICodex.catalogClientVersion)
    expect(request.os).toBe(enrollOs)
    expect(request.arch).toBe(process.arch)
    expect("server_id" in request).toBe(false)
    expect(buildEnrollRequest({ name: "box.local", installationID: "install-1", serverID: "srv-1" }).server_id).toBe("srv-1")
  })

  test("derives endpoint URLs from the backend base", () => {
    expect(enrollURL()).toBe("https://chatgpt.com/backend-api/wham/remote/control/server/enroll")
    expect(refreshURL()).toBe("https://chatgpt.com/backend-api/wham/remote/control/server/refresh")
    expect(websocketURL()).toBe("wss://chatgpt.com/backend-api/wham/remote/control")
  })

  test("decodes enroll responses tolerantly and requires the persisted outcome fields", () => {
    expect(
      decodeEnrollResponse({
        server_id: "srv-1",
        environment_id: "env-1",
        remote_control_token: "tok-1",
        expires_at: "2030-01-01T00:00:00Z",
        extra: true,
      }),
    ).toEqual({
      serverID: "srv-1",
      environmentID: "env-1",
      remoteControlToken: "tok-1",
      expiresAt: "2030-01-01T00:00:00Z",
    })
    expect(decodeEnrollResponse({ server_id: "s", environment_id: "e", remote_control_token: "t", expires_at: 1_893_456_000 })?.expiresAt)
      .toBe(new Date(1_893_456_000_000).toISOString())
    expect(decodeEnrollResponse({ server_id: "s", environment_id: "e", remote_control_token: "t", expires_at: "1893456000" })?.expiresAt)
      .toBe(new Date(1_893_456_000_000).toISOString())
    expect(
      decodePairingStartResponse({ pairing_code: "123456", manual_pairing_code: "654321", server_id: "srv-1", environment_id: "env-1", expires_at: 1_893_456_000 }),
    ).toEqual({ pairingCode: "123456", manualPairingCode: "654321", serverID: "srv-1", environmentID: "env-1", expiresAt: new Date(1_893_456_000_000).toISOString() })
    expect(decodePairingStartResponse({ server_id: "srv-1" })).toBeUndefined()
    expect(decodeEnrollResponse({ server_id: "srv-1", environment_id: "env-1" })).toBeUndefined()
    expect(decodeEnrollResponse("nope")).toBeUndefined()
    expect(
      decodeEnrollResponse({ serverId: "srv-2", environmentId: "env-2", remoteControlToken: "tok-2" })?.serverID,
    ).toBe("srv-2")
  })

  test("builds enroll and websocket connect headers without leaking them into other fields", () => {
    const enroll = buildEnrollHeaders({ credential, installationID: "install-1" })
    expect(enroll.authorization).toBe("Bearer access-token-value")
    expect(enroll["chatgpt-account-id"]).toBe("account-id-value")
    expect(enroll["x-codex-installation-id"]).toBe("install-1")

    const connect = buildConnectHeaders({
      serverID: "srv-1",
      serverName: "box.local",
      token: "tok-1",
      installationID: "install-1",
      deviceKind: "mac_mini",
    })
    expect(connect["x-codex-server-id"]).toBe("srv-1")
    expect(connect["x-codex-name"]).toBe("box.local")
    expect(connect["x-codex-protocol-version"]).toBe("3")
    expect(connect.authorization).toBe("Bearer tok-1")
    expect(connect["x-codex-host-device-kind"]).toBe("mac_mini")
    expect(connect["x-codex-installation-id"]).toBe("install-1")
    expect("x-codex-subscribe-cursor" in connect).toBe(false)
    const withCursor = buildConnectHeaders({
      serverID: "srv-1",
      serverName: "box.local",
      token: "tok-1",
      installationID: "install-1",
      subscribeCursor: "cur-9",
    })
    expect(withCursor["x-codex-subscribe-cursor"]).toBe("cur-9")
    expect("x-codex-host-device-kind" in withCursor).toBe(false)
  })

  test("reports mac_mini only for a mini machine name and omits every other kind", () => {
    expect(deviceKindFromMachineName("Mac mini")).toBe("mac_mini")
    expect(deviceKindFromMachineName("MacBook Pro")).toBeUndefined()
    expect(deviceKindFromMachineName("Mac Studio")).toBeUndefined()
    expect(deviceKindFromMachineName(undefined)).toBeUndefined()
  })

  test("classifies 404 and auth transitions", () => {
    expect(nextActionForHttp({ phase: "refresh", status: 404 })).toBe("delete_reenroll")
    expect(nextActionForHttp({ phase: "enroll", status: 404, recognizedMissingAppServer: true })).toBe("delete_reenroll")
    expect(nextActionForHttp({ phase: "enroll", status: 404 })).toBe("preserve_retry")
    expect(nextActionForHttp({ phase: "websocket", status: 401 })).toBe("refresh_reconnect")
    expect(nextActionForHttp({ phase: "websocket", status: 403 })).toBe("refresh_reconnect")
    expect(nextActionForHttp({ phase: "enroll", status: 429 })).toBe("preserve_retry")
    expect(recognizedMissingAppServer(JSON.stringify({ error: { code: "app_server_not_found" } }))).toBe(true)
    expect(recognizedMissingAppServer(JSON.stringify({ error: { code: "nope" } }))).toBe(false)
    expect(recognizedMissingAppServer("not json")).toBe(false)
  })

  test("reconnect delay honors Retry-After and caps backoff with jitter", () => {
    expect(reconnectDelay({ attempt: 0, random: () => 0 })).toBe(1_000)
    expect(reconnectDelay({ attempt: 30, random: () => 0 })).toBe(30_000)
    expect(reconnectDelay({ attempt: 0, retryAfterMs: 5_000, random: () => 0 })).toBe(5_000)
    const jittered = reconnectDelay({ attempt: 0, random: () => 0.999 })
    expect(jittered).toBeGreaterThan(1_000)
    expect(jittered).toBeLessThanOrEqual(1_250)
  })
})

describe("remote-control envelope", () => {
  const address = { clientID: "client-1", streamID: "s1", envID: "env-1" }

  test("round-trips a small message as one server_message frame with seq and address fields", () => {
    const text = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })
    const frames = encodeOutbound({ text, ...address, seqID: 7 })
    expect(frames).toHaveLength(1)
    const outbound = JSON.parse(frames[0]!)
    expect(outbound).toMatchObject({ type: "server_message", client_id: "client-1", seq_id: 7, stream_id: "s1", env_id: "env-1", message: text })
    const inbound = { ...outbound, type: "client_message" }
    delete inbound.seq_id
    const reassembler = new Reassembler()
    expect(reassembler.push(JSON.stringify(inbound))).toEqual({ kind: "message", ...address, text })
  })

  test("client_message has no seq_id while server_message requires one", () => {
    const reassembler = new Reassembler()
    expect(reassembler.push(JSON.stringify({ type: "client_message", client_id: "c", stream_id: "s", env_id: "e", message: "{}" })).kind).toBe("message")
    expect(reassembler.push(JSON.stringify({ type: "client_message", stream_id: "s", env_id: "e", message: "{}" })).kind).toBe("drop")
    expect(reassembler.push(JSON.stringify({ type: "ack", client_id: "c", stream_id: "s", env_id: "e", seq_id: 1 })).kind).toBe("drop")
  })

  test("slices messages above 102400 bytes into base64 chunks within the envelope bound and reassembles by stream", () => {
    const text = JSON.stringify({ data: "x".repeat(250_000) })
    const frames = encodeOutbound({ text, ...address, seqID: 3 })
    expect(frames).toHaveLength(3)
    for (const frame of frames) expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(153_600)
    const reassembler = new Reassembler()
    let result: ReturnType<Reassembler["push"]> | undefined
    for (const frame of frames) result = reassembler.push(frame.replace("server_message_chunk", "client_message_chunk").replace(/"seq_id":3,/, ""))
    expect(result).toEqual({ kind: "message", ...address, text })
    const first = JSON.parse(frames[0]!)
    expect(first.type).toBe("server_message_chunk")
    expect(first.message_size_bytes).toBe(new TextEncoder().encode(text).byteLength)
    expect(first.segment_count).toBe(frames.length)
    expect(first.seq_id).toBe(3)
  })

  test("drops out-of-order, mismatched, missing-address, and over-cap chunks", () => {
    const chunk = (patch: Record<string, unknown>) =>
      JSON.stringify({
        type: "client_message_chunk",
        client_id: "c",
        stream_id: "s1",
        env_id: "e",
        segment_id: 0,
        segment_count: 2,
        message_size_bytes: 4,
        message_chunk_base64: Buffer.from("ab").toString("base64"),
        ...patch,
      })
    const missing = new Reassembler()
    expect(missing.push(JSON.stringify({ type: "client_message", message: "{}" })).kind).toBe("drop")

    const order = new Reassembler()
    expect(order.push(chunk({ segment_id: 1 })).kind).toBe("drop")

    const mismatch = new Reassembler()
    expect(mismatch.push(chunk({})).kind).toBe("pending")
    expect(mismatch.push(chunk({ segment_id: 1, segment_count: 3, message_chunk_base64: Buffer.from("cd").toString("base64") })).kind).toBe("drop")

    const overflow = new Reassembler()
    expect(overflow.push(chunk({ message_size_bytes: 1_073_741_825 })).kind).toBe("drop")
    expect(overflow.push(chunk({ segment_count: 10_487 })).kind).toBe("drop")

    const invalid = new Reassembler()
    expect(invalid.push("not json").kind).toBe("drop")
    expect(invalid.push(JSON.stringify({ type: "ping", client_id: "c", stream_id: "s", env_id: "e", state: "foreground", skip_history: true })))
      .toEqual({ kind: "ping", clientID: "c", streamID: "s", envID: "e" })
    expect(invalid.push(JSON.stringify({ type: "client_closed", client_id: "c", stream_id: "s", env_id: "e" })))
      .toEqual({ kind: "closed", clientID: "c", streamID: "s", envID: "e" })
  })
})

function fakeBackend() {
  const prompts: Array<Parameters<RemoteControlBackend["prompt"]>[1] & { threadID: string }> = []
  const interrupts: string[] = []
  const thread = { id: "ses_1", title: "First", directory: "/work/repo" }
  const backend: RemoteControlBackend = {
    resolveLocation: async (directory) => (directory === "/work/repo" ? { directory } : undefined),
    createThread: async () => thread,
    getThread: async (id) => (id === thread.id ? thread : undefined),
    listThreads: async () => [thread],
    readMessages: async () => [
      { id: "m1", role: "user", text: "hello" },
      { id: "m2", role: "assistant", text: "hi there" },
      { id: "m3", role: "user", text: "again" },
    ],
    prompt: async (threadID, input) => {
      prompts.push({ threadID, ...input })
      return { messageID: "msg_1" }
    },
    interrupt: async (threadID) => {
      interrupts.push(threadID)
    },
    models: async () => [{ id: "model-1", providerID: "openai" }],
    skills: async () => [{ id: "skill-1", name: "Skill One" }],
    account: async () => ({ profile: "Work" }),
    pendingApprovals: async () => [{ id: "perm-1", kind: "permission" }],
  }
  return { backend, prompts, interrupts, thread }
}

async function rpc(server: ReturnType<typeof createRemoteControlAppServer>, method: string, params?: unknown, id: unknown = 1) {
  const reply = await server.handle(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  return reply === undefined ? undefined : JSON.parse(reply)
}

async function initialized(server: ReturnType<typeof createRemoteControlAppServer>) {
  await rpc(server, "initialize", { clientInfo: { name: "Codex Desktop", title: "Codex Desktop", version: "1.0" }, capabilities: {} })
  await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }))
}

describe("remote-control app-server mapping", () => {
  test("handshake presents imported Codex identity and rejects double initialize and bad names", async () => {
    const fake = fakeBackend()
    const server = createRemoteControlAppServer({ backend: fake.backend, codexHome: "/home/user/.codex" })
    const early = await rpc(server, "thread/list")
    expect(early.error).toBeDefined()

    const bad = createRemoteControlAppServer({ backend: fake.backend, codexHome: "/h" })
    const rejected = await rpc(bad, "initialize", { clientInfo: { name: "bad\r\nname" } })
    expect(rejected.error).toBeDefined()

    const init = await rpc(server, "initialize", {
      clientInfo: { name: "Codex Desktop", title: "Codex Desktop", version: "1.0" },
      capabilities: {},
    })
    expect(init.result.userAgent).toBe(OpenAICodex.userAgent())
    expect(init.result.codexHome).toBe("/home/user/.codex")
    expect(init.result.platformOs).toBe(process.platform)
    expect(typeof init.result.platformFamily).toBe("string")

    const again = await rpc(server, "initialize", { clientInfo: { name: "Codex Desktop" } })
    expect(again.error).toBeDefined()
  })

  test("thread start resolves Location only from backend inventory", async () => {
    const fake = fakeBackend()
    const server = createRemoteControlAppServer({ backend: fake.backend, codexHome: "/h" })
    await initialized(server)
    const ok = await rpc(server, "thread/start", { cwd: "/work/repo" })
    expect(ok.result.thread.id).toBe("ses_1")
    expect(ok.result.thread.cwd).toBe("/work/repo")
    const unknown = await rpc(server, "thread/start", { cwd: "/elsewhere" })
    expect(unknown.error).toBeDefined()
    const resumed = await rpc(server, "thread/resume", { threadId: "ses_1" })
    expect(resumed.result.thread.id).toBe("ses_1")
    const missing = await rpc(server, "thread/resume", { threadId: "ses_nope" })
    expect(missing.error).toBeDefined()
    const list = await rpc(server, "thread/list")
    expect(list.result.data).toHaveLength(1)
  })

  test("thread read synthesizes turns and items from projected messages", async () => {
    const fake = fakeBackend()
    const server = createRemoteControlAppServer({ backend: fake.backend, codexHome: "/h" })
    await initialized(server)
    const read = await rpc(server, "thread/read", { threadId: "ses_1", includeTurns: true })
    expect(read.result.thread.turns).toHaveLength(2)
    expect(read.result.thread.turns[0].items.map((item: { type: string }) => item.type)).toEqual(["userMessage", "agentMessage"])
    expect(read.result.thread.turns[0].items[0].content).toContain("hello")
  })

  test("turn start and steer admit prompts stamped as plugin external input; interrupt delegates", async () => {
    const fake = fakeBackend()
    const server = createRemoteControlAppServer({ backend: fake.backend, codexHome: "/h" })
    await initialized(server)
    const started = await rpc(server, "turn/start", { threadId: "ses_1", input: [{ type: "text", text: "do it" }] })
    expect(started.result.turn.id).toBe("msg_1")
    expect(fake.prompts).toHaveLength(1)
    expect(fake.prompts[0]!.text).toBe("do it")
    expect(fake.prompts[0]!.origin).toBe("plugin")
    expect(fake.prompts[0]!.externalSource).toEqual({ kind: "remote-control" })
    await rpc(server, "turn/steer", { threadId: "ses_1", input: [{ type: "text", text: "more" }] })
    expect(fake.prompts[1]!.delivery).toBe("steer")
    await rpc(server, "turn/interrupt", { threadId: "ses_1" })
    expect(fake.interrupts).toEqual(["ses_1"])
  })

  test("account, auth, config, model, and skill reads come from the backend without account identifiers", async () => {
    const fake = fakeBackend()
    const server = createRemoteControlAppServer({ backend: fake.backend, codexHome: "/h" })
    await initialized(server)
    const account = await rpc(server, "account/read")
    expect(JSON.stringify(account)).toContain("Work")
    expect(JSON.stringify(account)).not.toContain("account-id-value")
    const auth = await rpc(server, "getAuthStatus")
    expect(auth.result.authMethod).toBe("chatgpt")
    expect((await rpc(server, "config/read")).result.config).toEqual({})
    expect((await rpc(server, "model/list")).result.data[0].id).toBe("model-1")
    expect((await rpc(server, "skills/list")).result.data[0].id).toBe("skill-1")
  })

  test("pending approvals surface as notifications and client decisions never settle anything", async () => {
    const fake = fakeBackend()
    const notifications: Array<{ method: string; params: unknown }> = []
    const server = createRemoteControlAppServer({
      backend: fake.backend,
      codexHome: "/h",
      notify: (method, params) => notifications.push({ method, params }),
    })
    await initialized(server)
    await rpc(server, "thread/read", { threadId: "ses_1", includeTurns: true })
    expect(notifications.some((entry) => entry.method === "item/approvalRequested")).toBe(true)

    const reply = await rpc(server, "item/commandExecution/requestApproval", { threadId: "ses_1", decision: "accept" })
    expect(reply.error.code).toBe(-32601)
    const asResponse = await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 99, result: { decision: "accept" } }))
    expect(asResponse).toBeUndefined()
    expect(fake.interrupts).toEqual([])
    expect(fake.prompts).toEqual([])
  })

  test("raw exec, process, and filesystem methods are not implemented", async () => {
    const fake = fakeBackend()
    const server = createRemoteControlAppServer({ backend: fake.backend, codexHome: "/h" })
    await initialized(server)
    for (const method of ["command/exec", "process/write", "fs/readFile", "fs/writeFile", "unknown/method"]) {
      const reply = await rpc(server, method, {})
      expect(reply.error.code).toBe(-32601)
    }
    expect(fake.prompts).toEqual([])
  })
})

describe("remote-control state and host lifecycle", () => {
  test("state store persists enrollment and profile but never the remote-control token", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ycoding-rc-"))
    const file = path.join(dir, "remote-control.json")
    const store = createRemoteControlStateStore(file)
    await store.save({ enabled: true, profile: "Work" })
    const loaded = await store.load()
    expect(loaded.enabled).toBe(true)
    expect(loaded.profile).toBe("Work")
    expect(loaded.installationID.length).toBeGreaterThan(0)
    await store.saveEnrollment({
      websocketURL: "wss://example.test/rc",
      accountHash: "hash-1",
      enrollment: {
        serverID: "srv-1",
        environmentID: "env-1",
        serverName: "box.local",
        remoteControlEnabled: true,
        updatedAt: 5,
      },
    })
    const text = await readFile(file, "utf8")
    expect(text).not.toContain("remote_control_token")
    expect(text).not.toContain("tok-")
    const found = await store.enrollment({ websocketURL: "wss://example.test/rc", accountHash: "hash-1" })
    expect(found?.serverID).toBe("srv-1")
  })

  test("host enrolls, connects with headers, serves one RPC, and answers ping with pong", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ycoding-rc-host-"))
    const store = createRemoteControlStateStore(path.join(dir, "remote-control.json"))
    await store.save({ enabled: true, profile: "Work" })
    const fake = fakeBackend()
    const sent: string[] = []
    let onMessage: ((text: string) => void) | undefined
    let connectHeaders: Record<string, string> | undefined
    const socket: RemoteControlSocket = {
      send: (text) => sent.push(text),
      close: () => {},
      onMessage: (handler) => {
        onMessage = handler
      },
      onClose: () => {},
      onError: () => {},
    }
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const host = createRemoteControlHost({
      store,
      backend: fake.backend,
      codexHome: "/h",
      hostname: () => "box.local",
      deviceKind: async () => "mac_mini",
      resolveCredential: async () => credential,
      fetchFn: async (url, init) => {
        requests.push({ url: String(url), init })
        return new Response(
          JSON.stringify({ server_id: "srv-1", environment_id: "env-1", remote_control_token: "tok-1", expires_at: 4_102_444_800 }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      },
      connect: async (url, headers) => {
        connectHeaders = headers
        expect(url).toBe(websocketURL())
        return socket
      },
    })
    await host.connectOnce()
    expect(requests[0]!.url).toBe(enrollURL())
    expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject({ name: "box.local", os: enrollOs })
    const enrollHeaders = new Headers(requests[0]!.init?.headers)
    expect(enrollHeaders.get("chatgpt-account-id")).toBe("account-id-value")
    expect(connectHeaders?.["x-codex-server-id"]).toBe("srv-1")
    expect(connectHeaders?.authorization).toBe("Bearer tok-1")

    onMessage?.(JSON.stringify({ type: "ping", client_id: "client-1", stream_id: "s1", env_id: "env-1", state: "foreground", skip_history: true }))
    const pong = sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "pong")
    expect(pong).toMatchObject({ type: "pong", client_id: "client-1", stream_id: "s1", env_id: "env-1", status: "active" })
    expect(typeof pong.seq_id).toBe("number")

    const rpcText = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "Codex Desktop" }, capabilities: {} },
    })
    onMessage?.(JSON.stringify({ type: "client_message", client_id: "client-1", stream_id: "s1", env_id: "env-1", message: rpcText }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const ack = sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "ack")
    expect(ack).toMatchObject({ type: "ack", client_id: "client-1", stream_id: "s1", env_id: "env-1" })
    expect(typeof ack.seq_id).toBe("number")
    const replyFrame = sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "server_message")
    expect(replyFrame).toMatchObject({ client_id: "client-1", stream_id: "s1", env_id: "env-1" })
    expect(JSON.parse(replyFrame.message).result.userAgent).toBe(OpenAICodex.userAgent())
    const stateText = await readFile(path.join(dir, "remote-control.json"), "utf8")
    expect(stateText).not.toContain("tok-1")
    expect(stateText).not.toContain("account-id-value")
    expect(stateText).not.toContain("access-token-value")
    await host.stop()
  })

  test("refresh 404 deletes the enrollment and re-enrolls; unrecognized enroll 404 preserves and fails closed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ycoding-rc-refresh-"))
    const store = createRemoteControlStateStore(path.join(dir, "remote-control.json"))
    await store.save({ enabled: true, profile: "Work" })
    const fake = fakeBackend()
    const seen: string[] = []
    const host = createRemoteControlHost({
      store,
      backend: fake.backend,
      codexHome: "/h",
      hostname: () => "box.local",
      resolveCredential: async () => credential,
      fetchFn: async (url) => {
        seen.push(String(url))
        if (String(url).endsWith("/enroll") && seen.filter((entry) => entry.endsWith("/enroll")).length === 1)
          return new Response(
            JSON.stringify({
              server_id: "srv-1",
              environment_id: "env-1",
              server_name: "box.local",
              remote_control_token: "tok-1",
              expires_at: new Date(Date.now() - 1_000).toISOString(),
            }),
            { status: 200 },
          )
        if (String(url).endsWith("/refresh")) return new Response("gone", { status: 404 })
        return new Response(
          JSON.stringify({ server_id: "srv-2", environment_id: "env-2", server_name: "box.local", remote_control_token: "tok-2" }),
          { status: 200 },
        )
      },
      connect: async () => ({
        send: () => {},
        close: () => {},
        onMessage: () => {},
        onClose: () => {},
        onError: () => {},
      }),
    })
    await host.connectOnce()
    await host.stop()
    await host.connectOnce()
    expect(seen.some((url) => url.endsWith("/refresh"))).toBe(true)
    expect(seen.filter((url) => url.endsWith("/enroll")).length).toBeGreaterThanOrEqual(2)
    await host.stop()

    const failing = createRemoteControlHost({
      store,
      backend: fake.backend,
      codexHome: "/h",
      hostname: () => "box.local",
      resolveCredential: async () => credential,
      fetchFn: async () => new Response(JSON.stringify({ error: { code: "other" } }), { status: 404 }),
      connect: async () => {
        throw new Error("must not connect")
      },
    })
    await expect(failing.connectOnce()).rejects.toThrow()
    const kept = (await store.load()).enrollments
    expect(Object.keys(kept).length).toBeGreaterThan(0)
  })
})
