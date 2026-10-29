import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import net, { type AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { WebSocket, WebSocketServer, type NodeWebSocket } from "ws"
import { ccaNetworkProxyCapabilities } from "@ycoding-ai/core/cca/network-proxy"
import { CcaPolicy } from "@ycoding-ai/core/cca/policy"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import { upstreamOs } from "@ycoding-ai/core/util/platform"
import { createCcaExecutorHost } from "../src/remote-control/cca-executor-host"
import { ccaExecutorCapabilityRoots } from "../src/remote-control/cca-executor-registration"
import { unrecordedTranscript } from "./fixture/cca-scope"
import {
  ccaCompatibleExecServerVersion,
  ccaExecServerPrependPathDir,
  ccaExecServerProviderId,
  ccaExecServerUserAgent,
} from "../src/remote-control/cca-executor-transport"
import type { CcaNoisePublicKey, CcaNoiseTransport } from "../src/remote-control/cca-executor-transport"
import {
  decodeRelayMessageFrame,
  encodeRelayMessageFrame,
  frameMessage,
  MessageDecoder,
  type RelayMessageFrame,
} from "../src/remote-control/cca-relay"

const access = "synthetic-access-token-host-integ"
const accountID = "synthetic-account-host-integ"
const executorID = "ccarenv_b64_synthetic-executor-host-integ"
const defaultStreamID = "550e8400-e29b-41d4-a716-446655440000"
const streamID = defaultStreamID
const taskThreadID = "0199a8f2-1111-7222-8333-944455550001"
const harnessKey: CcaNoisePublicKey = {
  suite: "noise_hybrid_ik_v1",
  x25519_public_key: "synthetic_x25519_host_integ",
  mlkem768_public_key: "synthetic_mlkem768_host_integ",
}

const fakeCipher: CcaNoiseTransport = {
  async encrypt(bytes) {
    const ciphertext = new Uint8Array(bytes.length + 1)
    ciphertext[0] = 0x6d
    ciphertext.set(bytes, 1)
    return ciphertext
  },
  async decrypt(bytes) {
    if (bytes[0] !== 0x6d) throw new Error("Synthetic cipher rejected the record")
    return bytes.subarray(1)
  },
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

class Harness {
  private readonly frames: RelayMessageFrame[] = []
  private readonly responses = new Map<number, any>()
  private readonly decoder = new MessageDecoder()
  private wake: (() => void) | undefined
  private seq = 0

  constructor(readonly socket: NodeWebSocket, readonly streamID = defaultStreamID) {
    socket.on("message", (data) => {
      const frame = decodeRelayMessageFrame(new Uint8Array(data as Buffer))
      if (frame.stream_id !== this.streamID) return
      this.frames.push(frame)
      this.wake?.()
    })
  }

  stream(streamID: string) {
    return new Harness(this.socket, streamID)
  }

  private async frame() {
    while (this.frames.length === 0) await new Promise<void>((resolve) => { this.wake = resolve })
    this.wake = undefined
    return this.frames.shift()!
  }

  async handshake() {
    this.socket.send(encodeRelayMessageFrame({ version: 1, stream_id: this.streamID, body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } } }))
    while ((await this.frame()).body?.kind !== "handshake") {}
  }

  async send(message: { readonly id?: number; readonly method: string; readonly params?: unknown }) {
    const payload = await fakeCipher.encrypt(frameMessage(new TextEncoder().encode(JSON.stringify(message))))
    this.socket.send(encodeRelayMessageFrame({
      version: 1,
      stream_id: this.streamID,
      body: { kind: "data", data: { seq: this.seq++, segment_index: 0, segment_count: 1, payload } },
    }))
  }

  readonly received: any[] = []
  answer: ((request: any) => unknown) | undefined

  async reply(id: number, result: unknown) {
    const payload = await fakeCipher.encrypt(frameMessage(new TextEncoder().encode(JSON.stringify({ id, result }))))
    this.socket.send(encodeRelayMessageFrame({
      version: 1,
      stream_id: this.streamID,
      body: { kind: "data", data: { seq: this.seq++, segment_index: 0, segment_count: 1, payload } },
    }))
  }

  private async pump() {
    const frame = await this.frame()
    if (frame.body?.kind !== "data") return
    for (const message of this.decoder.push(await fakeCipher.decrypt(frame.body.data.payload))) {
      const parsed = JSON.parse(new TextDecoder().decode(message))
      this.received.push(parsed)
      if (parsed.id === undefined) continue
      if (parsed.method === undefined) this.responses.set(parsed.id, parsed)
      else if (this.answer !== undefined) void this.reply(parsed.id, this.answer(parsed))
    }
  }

  async run(id: number, params: { readonly processId: string } & Record<string, unknown>) {
    const started = await this.request(id, "process/start", params)
    expect(started.error).toBeUndefined()
    await this.until((received) => received.some((message) => message.method === "process/closed" && message.params.processId === params.processId))
    return this.received
      .filter((message) => message.method === "process/output" && message.params.processId === params.processId)
      .map((message) => Buffer.from(message.params.chunk, "base64").toString("utf8"))
      .join("")
  }

  async request(id: number, method: string, params?: unknown) {
    await this.send({ id, method, ...(params === undefined ? {} : { params }) })
    while (!this.responses.has(id)) await this.pump()
    return this.responses.get(id)
  }

  async until(done: (received: readonly any[]) => boolean) {
    while (!done(this.received)) await this.pump()
  }

  async initialize(resumeSessionId?: string) {
    const response = await this.request(1, "initialize", { clientName: "synthetic-harness", ...(resumeSessionId === undefined ? {} : { resumeSessionId }) })
    if (response.result !== undefined) await this.send({ method: "initialized" })
    return response
  }

  async startSleeper(home: string) {
    const started = await this.request(2, "process/start", {
      processId: "sleeper",
      argv: ["/bin/sh", "-c", "echo $$; exec sleep 30"],
      cwd: pathToFileURL(home).href,
      env: {},
    })
    expect(started.error).toBeUndefined()
    let output = ""
    for (let id = 3; !output.includes("\n"); id++) {
      const read = await this.request(id, "process/read", { processId: "sleeper", waitMs: 1_000 })
      for (const chunk of read.result.chunks) output += Buffer.from(chunk.chunk, "base64").toString("utf8")
      if (read.result.exited) throw new Error("Synthetic sleeper exited early")
    }
    return Number(output.trim())
  }

  reset() {
    this.socket.send(encodeRelayMessageFrame({ version: 1, stream_id: this.streamID, body: { kind: "reset", reset: { reason: "synthetic" } } }))
  }
}

async function fixture(options: { readonly deny?: boolean; readonly ttlMs?: number } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "ycoding-cca-host-integ-"))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const statePath = path.join(home, "cca-executor.json")
  await writeFile(statePath, JSON.stringify({
    installationID: "synthetic-installation",
    accountHash: createHash("sha256").update(accountID).digest("hex"),
    status: "completed",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    executorID,
    selectedCapabilityRoots: ccaExecutorCapabilityRoots(home, home),
  }), { mode: 0o600 })

  const registrations: any[] = []
  const registryHeaders: http.IncomingHttpHeaders[] = []
  const registry = http.createServer((request, response) => {
    registryHeaders.push(request.headers)
    let text = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => { text += chunk })
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" })
      if (request.url?.endsWith("/validate")) {
        response.end(JSON.stringify({ valid: true }))
        return
      }
      registrations.push(JSON.parse(text))
      response.end(JSON.stringify({
        environment_id: executorID,
        security_profile: "noise_hybrid_ik_v1",
        executor_registration_id: `synthetic-registration-${registrations.length}`,
        url: "wss://rendezvous.chatgpt.com/cloud-agent/ws?sig=synthetic",
      }))
    })
  })
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", () => resolve()))
  cleanups.push(() => new Promise<void>((resolve) => registry.close(() => resolve())))

  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await new Promise<void>((resolve) => server.on("listening", () => resolve()))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const harnesses: Harness[] = []
  const closed: Promise<void>[] = []
  const connected: ReturnType<typeof deferred<Harness>>[] = [deferred<Harness>()]
  server.on("connection", (socket) => {
    const harness = new Harness(socket)
    const ended = deferred()
    socket.on("close", () => ended.resolve())
    closed.push(ended.promise)
    harnesses.push(harness)
    connected[harnesses.length - 1]!.resolve(harness)
    connected.push(deferred<Harness>())
  })

  let configuration: NativeDots.Configuration = {
    enabled: true, accessRevision: 1, profile: "dots", credentialID: "credential-1", accountID, accountGeneration: 1,
  }
  const listeners = new Set<() => void>()
  const scopes: {
    readonly sessionID: string
    readonly input: { readonly environmentID: string; readonly threadID?: string; readonly cwd?: string }
    readonly closed: ReturnType<typeof deferred<void>>
    pid?: number
    pidAliveAtClose?: boolean
    opened: number
    closes: number
    authorizations: string[]
    releases: number
  }[] = []
  const workspaceCalls: { readonly method: string; readonly input: unknown }[] = []
  const openScope = async (input: { readonly environmentID: string; readonly threadID?: string; readonly cwd?: string }): Promise<NativeDots.ThreadScope> => {
    const sessionID = input.threadID === undefined ? "synthetic-session-unattributed" : `synthetic-session-${input.threadID}`
    let scope = scopes.find((entry) => entry.sessionID === sessionID)
    if (scope === undefined) {
      scope = { sessionID, input, closed: deferred(), opened: 0, closes: 0, authorizations: [], releases: 0 }
      scopes.push(scope)
    }
    const current = scope
    current.opened++
    let closing: Promise<void> | undefined
    return {
      sessionID,
      directory: home,
      roots: [home],
      transcript: unrecordedTranscript,
      authorization: {
        authorize: async (request) => {
          if (options.deny) throw new Error("Synthetic denial")
          current.authorizations.push(request.action)
          return { release: async () => { current.releases++ } }
        },
        close: async () => {},
      },
      close: () => (closing ??= (async () => {
        current.closes++
        if (current.closes < current.opened) return
        current.pidAliveAtClose = current.pid === undefined ? undefined : alive(current.pid)
        current.closed.resolve()
      })()),
    }
  }
  const diagnostics: string[] = []
  const host = createCcaExecutorHost({
    native: {
      configuration: async () => configuration,
      credential: async (profile) => configuration.enabled
        ? { access, accountID, key: "credential-key-1", profile, credentialID: "credential-1", accountGeneration: 1 }
        : undefined,
      subscribeConfiguration: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      threadScope: (input) => openScope(input),
      unattributedScope: (input) => openScope(input),
      projectCatalog: async (input) => {
        workspaceCalls.push({ method: "projectCatalog", input })
        return { environmentId: input.environmentID, projects: [] }
      },
      assignProject: async (input) => {
        workspaceCalls.push({ method: "assignProject", input })
        return { environmentId: input.environmentID, projectId: input.projectID, threadId: input.threadID }
      },
      prepareWorkspace: async (input) => {
        workspaceCalls.push({ method: "prepareWorkspace", input })
        const cwd = path.join(home, "YCoding", "task")
        return { cwd, runtimeWorkspaceRoots: [cwd] }
      },
    },
    statePath,
    installationID: async () => "synthetic-installation",
    homeDirectory: home,
    dataDirectory: home,
    registryBaseURL: `http://127.0.0.1:${(registry.address() as AddressInfo).port}`,
    fetch: (url, init) => {
      if (!url.startsWith("http://127.0.0.1:")) throw new Error("Unexpected non-loopback request")
      return fetch(url, init)
    },
    connectWebSocket: (_url, headers) => new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, { headers }),
    acceptHandshake: async (input) => {
      await input.authorize(harnessKey, "synthetic-harness-authorization")
      return { response: new Uint8Array([0x42]), transport: fakeCipher }
    },
    wait: async () => {},
    detachedSessionTtlMs: options.ttlMs ?? 20,
    onDiagnostic: (message) => { diagnostics.push(message) },
  })
  cleanups.push(() => host.stop())
  return {
    home, host, harnesses, closed, registrations, registryHeaders, scopes, workspaceCalls, diagnostics,
    connection: (index: number) => connected[index]!.promise,
    set: (next: NativeDots.Configuration) => {
      configuration = next
      for (const listener of [...listeners]) listener()
    },
  }
}

describe("CCA executor host over a loopback registry and WebSocket relay", () => {
  test("serves each session through one home-rooted executor scope and closes executor before scope once the detached session expires", async () => {
    const harness = await fixture()
    await harness.host.start()
    const relay = await harness.connection(0)
    await relay.handshake()
    const initialized = await relay.initialize()
    expect(initialized.result.environmentInfo).toMatchObject({
      cwd: CcaPolicy.toPathUri(harness.home),
      userHomeDir: CcaPolicy.toPathUri(harness.home),
      platformOs: upstreamOs(),
      executorVersion: ccaCompatibleExecServerVersion,
      providerId: ccaExecServerProviderId,
    })
    expect(ccaCompatibleExecServerVersion).toBe("0.165.0-alpha.1.2")
    expect(ccaExecServerProviderId).toBe("sha256:6c00ea8010dd56f75443a655293fd43e86b65f038786b1a257324d4a6028d4cf")
    expect("prependPathDirs" in initialized.result.environmentInfo).toBe(existsSync(ccaExecServerPrependPathDir))
    const masking = ccaNetworkProxyCapabilities({ shell: initialized.result.environmentInfo.shell.path }).credentialMasking
    const maskingCapabilities: [string, boolean][] = masking ? [["credentialMasking", true], ["credentialMaskingCustomProviders", true]] : []
    expect(Object.entries(initialized.result.environmentInfo.capabilities).filter(([, enabled]) => enabled !== false)).toEqual([
      ["networkProxyLaunch", true],
      ["networkProxyReviewDomains", true],
      ...maskingCapabilities,
      ["capabilityDiscoverySandbox", true],
      ["capabilityDiscoveryV2", true],
      ["environmentConfigRead", true],
      ["httpHeaderEnvVars", true],
      ["sandboxedFileStreaming", true],
      ["fileWriteStreaming", true],
      ["shellSnapshotV2", true],
    ])
    expect(harness.scopes).toEqual([])
    const pid = await relay.startSleeper(harness.home)
    expect(harness.scopes).toHaveLength(1)
    expect(harness.scopes[0]!.input).toEqual({ environmentID: executorID })
    harness.scopes[0]!.pid = pid

    relay.reset()
    await harness.scopes[0]!.closed.promise
    expect(harness.scopes[0]!.pidAliveAtClose).toBe(false)
    expect(harness.scopes[0]!.releases).toBeGreaterThan(0)
    expect(harness.scopes).toHaveLength(1)
    expect(harness.harnesses).toHaveLength(1)
  })

  test("a closed channel reports one payload-free summary of its RPC methods and outcomes", async () => {
    const harness = await fixture()
    await harness.host.start()
    const relay = await harness.connection(0)
    await relay.handshake()
    await relay.initialize()
    const started = await relay.request(2, "process/start", {
      processId: "synthetic-summary-process",
      argv: ["/bin/sh", "-c", "printf 'synthetic-summary-output\\n'"],
      cwd: pathToFileURL(harness.home).href,
      env: {},
    })
    expect(started.error).toBeUndefined()
    for (let id = 3; ; id++) {
      const read = await relay.request(id, "process/read", { processId: "synthetic-summary-process", waitMs: 1_000 })
      if (read.result.closed) break
    }
    expect(harness.diagnostics.filter((message) => message.startsWith("CCA executor channel-summary"))).toEqual([])

    relay.reset()
    await harness.scopes[0]!.closed.promise
    const summaries = harness.diagnostics.filter((message) => message.startsWith("CCA executor channel-summary"))
    expect(summaries).toHaveLength(1)
    const [prefix, rpc] = summaries[0]!.split(" rpc=")
    expect(prefix).toBe("CCA executor channel-summary end=channel")
    const tokens = rpc!.split(",")
    expect(tokens.slice(0, 5)).toEqual([">initialize", "<initialize=result", ">initialized", ">process/start", "<process/start=result"])
    for (const token of ["~process/output", "~process/exited", "~process/closed", ">process/read", "<process/read=result"])
      expect(tokens).toContain(token)
    for (const secret of ["synthetic-summary-process", "synthetic-summary-output", harness.home, access, accountID, executorID, streamID, "synthetic-session"])
      expect(summaries[0]).not.toContain(secret)
  })

  test("a process/start with the task-workspace argv shape is answered by YCoding instead of running the script", async () => {
    const harness = await fixture()
    await harness.host.start()
    const relay = await harness.connection(0)
    await relay.handshake()
    await relay.initialize()
    const request = Buffer.from(JSON.stringify({ id: "task-workspace", jsonrpc: "2.0", method: "taskWorkspace/prepare", params: { environmentId: executorID, cwd: null, includeModelDefaults: true } })).toString("base64")
    const argv = ["/bin/sh", "-c", "printf null", "task-workspace", "synthetic-node-client", request, "true"]
    const started = await relay.request(2, "process/start", { processId: "task-workspace-script", argv, cwd: pathToFileURL(harness.home).href, env: {}, metadata: { threadId: taskThreadID } })
    expect(started.result).toEqual({ processId: "task-workspace-script", sandboxType: "none" })
    let stdout = ""
    let exitCode: number | null = null
    let afterSeq = 0
    for (let id = 3; ; id++) {
      const read = await relay.request(id, "process/read", { processId: "task-workspace-script", afterSeq, waitMs: 1_000 })
      for (const chunk of read.result.chunks) stdout += Buffer.from(chunk.chunk, "base64").toString("utf8")
      afterSeq = read.result.nextSeq - 1
      if (read.result.exited) exitCode = read.result.exitCode
      if (read.result.closed) break
    }
    const cwd = path.join(harness.home, "YCoding", "task")
    expect({ stdout, exitCode }).toEqual({ stdout: JSON.stringify({ cwd, runtimeWorkspaceRoots: [cwd] }), exitCode: 0 })
    expect(harness.workspaceCalls).toEqual([{ method: "prepareWorkspace", input: { environmentID: executorID, threadID: taskThreadID, cwd: null } }])
    expect(harness.scopes.map((scope) => scope.input)).toEqual([{ environmentID: executorID, threadID: taskThreadID, cwd: harness.home }])
    expect(harness.scopes[0]!.authorizations).toContain("shell")

    relay.reset()
    await harness.scopes[0]!.closed.promise
  })

  test("process starts open one Session per thread and an unattributed Session otherwise, never one per channel", async () => {
    const harness = await fixture()
    await harness.host.start()
    const relay = await harness.connection(0)
    await relay.handshake()
    await relay.initialize()
    const other = relay.stream("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
    await other.handshake()
    await other.initialize()
    expect(harness.scopes).toEqual([])

    const cwd = pathToFileURL(harness.home).href
    expect(await relay.run(2, { processId: "unattributed", argv: ["/bin/sh", "-c", "printf a"], cwd, env: {} })).toBe("a")
    expect(await other.run(2, { processId: "threaded", argv: ["/bin/sh", "-c", "printf b"], cwd, env: {}, metadata: { threadId: taskThreadID } })).toBe("b")
    expect(await other.run(3, { processId: "threaded-again", argv: ["/bin/sh", "-c", "printf c"], cwd, env: {}, metadata: { threadId: taskThreadID } })).toBe("c")

    expect(harness.scopes.map((scope) => scope.input)).toEqual([
      { environmentID: executorID },
      { environmentID: executorID, threadID: taskThreadID, cwd: harness.home },
    ])
    expect(harness.scopes.map((scope) => scope.authorizations.filter((action) => action === "shell").length)).toEqual([1, 2])
  })

  test("a session resumed after a reconnect keeps its thread binding", async () => {
    const harness = await fixture({ ttlMs: 5_000 })
    await harness.host.start()
    const first = await harness.connection(0)
    await first.handshake()
    const sessionId = (await first.initialize()).result.sessionId
    const cwd = pathToFileURL(harness.home).href
    expect(await first.run(2, { processId: "before", argv: ["/bin/sh", "-c", "printf a"], cwd, env: {}, metadata: { threadId: taskThreadID } })).toBe("a")
    first.socket.terminate()

    const second = await harness.connection(1)
    await second.handshake()
    expect((await second.initialize(sessionId)).result.sessionId).toBe(sessionId)
    expect(await second.run(2, { processId: "after", argv: ["/bin/sh", "-c", "printf b"], cwd, env: {} })).toBe("b")

    expect(harness.scopes.map((scope) => scope.input)).toEqual([{ environmentID: executorID, threadID: taskThreadID, cwd: harness.home }])
    expect(harness.scopes[0]!.authorizations.filter((action) => action === "shell")).toHaveLength(2)
  })

  test("the eight extended filesystem methods answer the official success and error shapes through the stack", async () => {
    const harness = await fixture()
    await harness.host.start()
    const relay = await harness.connection(0)
    await relay.handshake()
    await relay.initialize()
    const work = path.join(harness.home, "w")
    await mkdir(path.join(work, "src", "sub"), { recursive: true })
    await writeFile(path.join(work, "src", "a.txt"), "hello")
    await writeFile(path.join(work, "src", "sub", "b.txt"), "x")
    const uri = (...parts: string[]) => pathToFileURL(path.join(work, ...parts)).href
    const notFound = { code: -32004, message: "No such file or directory (os error 2)" }
    let id = 10
    const call = async (method: string, params: unknown) => {
      const response = await relay.request(++id, method, params)
      return response.error === undefined ? { result: response.result } : { error: response.error }
    }
    const walkOptions = { maxDepth: 4, maxDirectories: 10, maxEntries: 10, followDirectorySymlinks: false }

    expect(await call("fs/createDirectory", { path: uri("new", "deep"), recursive: true })).toEqual({ result: {} })
    expect(await call("fs/createDirectory", { path: uri("nope", "deep"), recursive: false })).toEqual({ error: notFound })
    expect(await call("fs/open", { handleId: "h1", path: uri("src", "a.txt"), mode: "read" })).toEqual({ result: { handleId: "h1" } })
    expect(await call("fs/readBlock", { handleId: "h1", offset: 1, len: 3 })).toEqual({ result: { chunk: "ZWxs", eof: false } })
    expect(await call("fs/close", { handleId: "h1" })).toEqual({ result: {} })
    expect(await call("fs/readBlock", { handleId: "h1", offset: 0, len: 3 })).toEqual({ error: { code: -32004, message: "unknown file handle `h1`" } })
    expect(await call("fs/open", { handleId: "h2", path: uri("out.txt"), mode: "replace" })).toEqual({ result: { handleId: "h2" } })
    expect(await call("fs/writeBlock", { handleId: "h2", offset: 0, chunk: "aGk=" })).toEqual({ result: {} })
    expect(await call("fs/close", { handleId: "h2" })).toEqual({ result: {} })
    expect(await readFile(path.join(work, "out.txt"), "utf8")).toBe("hi")
    expect(await call("fs/writeBlock", { handleId: "h9", offset: 0, chunk: "aGk=" })).toEqual({ error: { code: -32004, message: "unknown file handle `h9`" } })
    expect(await call("fs/open", { handleId: "h3", path: uri("missing.txt"), mode: "read" })).toEqual({ error: notFound })
    expect(await call("fs/close", {})).toEqual({ error: { code: -32602, message: "missing field `handleId`" } })
    expect(await call("fs/walk", { path: uri("src"), options: walkOptions })).toEqual({
      result: {
        entries: [
          { path: uri("src", "a.txt"), kind: "file" },
          { path: uri("src", "sub"), kind: "directory" },
          { path: uri("src", "sub", "b.txt"), kind: "file" },
        ],
        errors: [],
        truncated: false,
      },
    })
    expect(await call("fs/walk", { path: uri("missing"), options: walkOptions })).toEqual({ error: notFound })
    expect(await call("fs/copy", { sourcePath: uri("src"), destinationPath: uri("copy"), recursive: true })).toEqual({ result: {} })
    expect(await call("fs/copy", { sourcePath: uri("src"), destinationPath: uri("copy2"), recursive: false })).toEqual({
      error: { code: -32600, message: "fs/copy requires recursive: true when sourcePath is a directory" },
    })
    expect(await call("fs/remove", { path: uri("copy"), recursive: true })).toEqual({ result: {} })
    expect(await call("fs/remove", { path: uri("copy"), recursive: true, force: false })).toEqual({ error: notFound })
  })

  test("http/request answers buffered and streamed loopback responses the way the official executor does", async () => {
    const server = http.createServer((request, response) => {
      if (request.method === "POST") {
        const chunks: Buffer[] = []
        request.on("data", (chunk) => chunks.push(chunk))
        request.on("end", () => {
          const body = Buffer.concat(chunks)
          response.writeHead(201, { "content-length": String(body.length) })
          response.end(body)
        })
        return
      }
      response.writeHead(200, { "content-type": "text/plain", "x-synthetic": "1", "content-length": "10" })
      response.end("hello-body")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const harness = await fixture()
    await harness.host.start()
    const relay = await harness.connection(0)
    await relay.handshake()
    await relay.initialize()

    const buffered = await relay.request(20, "http/request", { method: "GET", url: `${base}/x`, headers: [], requestId: "r1", streamResponse: false })
    expect(buffered.result.status).toBe(200)
    expect(buffered.result.bodyBase64).toBe("aGVsbG8tYm9keQ==")
    expect(buffered.result.headers).toContainEqual({ name: "x-synthetic", value: "1" })
    const posted = await relay.request(21, "http/request", { method: "POST", url: `${base}/y`, headers: [{ name: "content-type", value: "text/plain" }], bodyBase64: "cGluZw==", requestId: "r2" })
    expect({ status: posted.result.status, bodyBase64: posted.result.bodyBase64 }).toEqual({ status: 201, bodyBase64: "cGluZw==" })

    const streamed = await relay.request(22, "http/request", { method: "GET", url: `${base}/s`, headers: [], requestId: "r3", streamResponse: true })
    expect({ status: streamed.result.status, bodyBase64: streamed.result.bodyBase64 }).toEqual({ status: 200, bodyBase64: "" })
    await relay.until((received) => received.some((message) => message.method === "http/request/bodyDelta" && message.params.done))
    const responseIndex = relay.received.findIndex((message) => message.id === 22)
    const deltas = relay.received.filter((message) => message.method === "http/request/bodyDelta")
    expect(deltas.map((message) => message.params)).toEqual([
      { requestId: "r3", seq: 1, deltaBase64: "aGVsbG8tYm9keQ==", done: false, error: null },
      { requestId: "r3", seq: 2, deltaBase64: "", done: true, error: null },
    ])
    expect(relay.received.indexOf(deltas[0])).toBeGreaterThan(responseIndex)

    expect((await relay.request(23, "http/request", { method: "GET", url: "http://127.0.0.1:1/x", headers: [], requestId: "r4" })).error).toEqual({
      code: -32603,
      message: "http/request failed: error sending request for url (http://127.0.0.1:1/x)",
    })
    expect((await relay.request(24, "http/request", { url: "http://127.0.0.1:1/x", requestId: "r5" })).error).toEqual({ code: -32602, message: "missing field `method`" })
  })

  function networkProxy(overrides: Record<string, unknown> = {}, launch: Record<string, unknown> = {}) {
    return {
      proxy: {
        enabled: true,
        credentialMasking: false,
        credentialProviders: {},
        enableSocks5: false,
        enableSocks5Udp: false,
        allowUpstreamProxy: false,
        dangerouslyAllowAllUnixSockets: false,
        mode: "full",
        domains: { localhost: "allow", "127.0.0.1": "allow", "denied.invalid": "deny" },
        reviewDomains: ["127.0.0.1"],
        allowLocalBinding: false,
        ...overrides,
      },
      auditMetadata: {},
      ...launch,
    }
  }

  test("a networkProxy launch proxies allowlisted and denied hosts and decides a review host over network/policyRequest", async () => {
    const upstream = http.createServer((request, response) => response.end(`upstream ${request.url}`))
    await new Promise<void>((resolve) => upstream.listen(0, "::", () => resolve()))
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())))
    const port = (upstream.address() as AddressInfo).port
    const harness = await fixture()
    await harness.host.start()
    const relay = await harness.connection(0)
    await relay.handshake()
    await relay.initialize()
    const policyRequests: any[] = []
    relay.answer = (request) => {
      policyRequests.push(request)
      return { decision: { type: "allow" } }
    }
    const script = [
      `curl -s -w ' %{http_code}' http://localhost:${port}/a`,
      "echo",
      "curl -s -o /dev/null -D - http://denied.invalid/ | tr -d '\\r' | grep -i -E '^(HTTP/|x-proxy-error)'",
      `curl -s -w ' %{http_code}' http://127.0.0.1:${port}/r`,
      "echo",
      "echo PROXY=$http_proxy",
    ].join("; ")
    const output = await relay.run(30, {
      processId: "proxied",
      argv: ["/bin/bash", "-c", script],
      cwd: pathToFileURL(harness.home).href,
      env: { PATH: "/usr/bin:/bin" },
      networkProxy: networkProxy({}, { policyDecisionTimeoutMs: 5_000 }),
    })
    const lines = output.trimEnd().split("\n")
    expect(lines.slice(0, -1).join("\n")).toBe(`upstream /a 200\nHTTP/1.1 403 Forbidden\nx-proxy-error: blocked-by-denylist\nupstream /r 200`)
    const proxyPort = Number(/^PROXY=http:\/\/127\.0\.0\.1:(\d+)$/.exec(lines.at(-1)!)?.[1])
    expect(proxyPort).toBeGreaterThan(0)
    const refused = () => new Promise<boolean>((resolve) => {
      const socket = net.connect(proxyPort, "127.0.0.1")
      socket.once("connect", () => { socket.destroy(); resolve(false) })
      socket.once("error", () => resolve(true))
    })
    let closed = await refused()
    for (let attempt = 0; !closed && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      closed = await refused()
    }
    expect(closed).toBe(true)
    expect(policyRequests).toEqual([
      { id: 1, method: "network/policyRequest", params: { processId: "proxied", request: { protocol: "http", host: "127.0.0.1", port } } },
    ])
    const decisions = relay.received.filter((message) => message.method === "network/policyDecision").map((message) => message.params)
    for (const decision of decisions) {
      expect(Object.keys(decision)).toEqual(["processId", "timestamp", "scope", "decision", "source", "reason", "protocol", "host", "port", "method", "client", "policyOverride"])
    }
    expect(decisions.map(({ timestamp, client, ...rest }) => rest)).toEqual([
      { processId: "proxied", scope: "domain", decision: "allow", source: "baseline_policy", reason: "allow", protocol: "http", host: "localhost", port, method: "GET", policyOverride: false },
      { processId: "proxied", scope: "domain", decision: "deny", source: "baseline_policy", reason: "denied", protocol: "http", host: "denied.invalid", port: 80, method: "GET", policyOverride: false },
      { processId: "proxied", scope: "domain", decision: "allow", source: "decider", reason: "not_allowed", protocol: "http", host: "127.0.0.1", port, method: "GET", policyOverride: true },
    ])
  }, 30_000)

  test("a networkProxy launch with credential masking hands a bash -c child a masked synthetic credential and the executor CA bundle", async () => {
    const harness = await fixture()
    await harness.host.start()
    const relay = await harness.connection(0)
    await relay.handshake()
    await relay.initialize()
    const secret = "ghp_synthetic0123456789abcdefABCDEF0123"
    const output = await relay.run(30, {
      processId: "masked",
      argv: ["/bin/bash", "-c", "echo GH=$GITHUB_TOKEN; echo ACTIVE=$CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE; echo CA=$SSL_CERT_FILE"],
      cwd: pathToFileURL(harness.home).href,
      env: { PATH: "/usr/bin:/bin", GITHUB_TOKEN: secret },
      networkProxy: networkProxy({ credentialMasking: true }),
    })
    expect(output).not.toContain(secret)
    const [token, active, ca] = output.trimEnd().split("\n")
    expect(token).toMatch(/^GH=ghp_masked[A-Za-z0-9]+$/)
    expect(token!.length - "GH=".length).toBe(40)
    expect(active).toBe("ACTIVE=1")
    expect(ca).toMatch(new RegExp(`^CA=${path.join(harness.home, "cca-proxy").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/ca-bundle-[0-9a-f]{64}\\.pem$`))
  }, 30_000)

  test("a shellSnapshot scope captures the login shell once and replays it for later starts in the same scope", async () => {
    const harness = await fixture()
    await harness.host.start()
    const relay = await harness.connection(0)
    await relay.handshake()
    await relay.initialize()
    const shellHome = path.join(harness.home, "shell-home")
    await mkdir(shellHome)
    const profile = 'echo sourced >> "$HOME/count"\nexport SNAP_VAR=from-profile\n'
    await writeFile(path.join(shellHome, ".zshrc"), profile)
    await writeFile(path.join(shellHome, ".zprofile"), profile)
    const sourced = async () => (await readFile(path.join(shellHome, "count"), "utf8").catch(() => "")).split("\n").filter(Boolean).length
    const counts: number[] = []
    let id = 40
    for (const [index, scopeId] of ["s1", "s1", "s2"].entries()) {
      const output = await relay.run(++id, {
        processId: `snapshot-${index}`,
        argv: ["/bin/zsh", "-lc", "echo VAR=$SNAP_VAR"],
        cwd: pathToFileURL(harness.home).href,
        env: { PATH: "/usr/bin:/bin", HOME: shellHome },
        shellSnapshot: { scopeId, shell: { name: "zsh", path: "/bin/zsh" } },
      })
      expect(output).toBe("VAR=from-profile\n")
      counts.push(await sourced())
    }
    expect(counts).toEqual([2, 2, 4])
  }, 30_000)

  test("denied authorization answers -32001 and writes nothing", async () => {
    const harness = await fixture({ deny: true })
    await harness.host.start()
    const relay = await harness.connection(0)
    await relay.handshake()
    await relay.initialize()
    const target = path.join(harness.home, "denied.txt")
    const response = await relay.request(2, "fs/writeFile", {
      path: pathToFileURL(target).href,
      dataBase64: Buffer.from("synthetic").toString("base64"),
    })
    expect(response.error).toEqual({ code: -32001, message: "Permission denied" })
    expect(existsSync(target)).toBe(false)
  })

  test("access turning off closes the socket, kills executor processes, and closes the scope", async () => {
    const harness = await fixture()
    await harness.host.start()
    const relay = await harness.connection(0)
    await relay.handshake()
    await relay.initialize()
    const pid = await relay.startSleeper(harness.home)
    harness.scopes[0]!.pid = pid

    harness.set({ enabled: false })
    await harness.closed[0]
    await harness.scopes[0]!.closed.promise
    expect(harness.scopes[0]!.pidAliveAtClose).toBe(false)
    await harness.host.stop()
    expect(alive(pid)).toBe(false)
    expect(harness.registrations).toHaveLength(1)
  })

  test("a dropped relay socket reconnects on the same registration and key, and the harness resumes its session and process", async () => {
    const harness = await fixture({ ttlMs: 5_000 })
    await harness.host.start()
    const first = await harness.connection(0)
    await first.handshake()
    const initialized = await first.initialize()
    const sessionId = initialized.result.sessionId
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
    const pid = await first.startSleeper(harness.home)
    first.socket.terminate()

    const second = await harness.connection(1)
    await second.handshake()
    const resumed = await second.initialize(sessionId)
    expect(resumed.result.sessionId).toBe(sessionId)
    const read = await second.request(2, "process/read", { processId: "sleeper", waitMs: 0 })
    expect(read.result.exited).toBe(false)
    expect(alive(pid)).toBe(true)
    expect(harness.scopes).toHaveLength(1)
    expect(harness.registrations).toHaveLength(1)
    expect(harness.registryHeaders[0]).toMatchObject({ originator: "codex_cli_rs", "user-agent": ccaExecServerUserAgent() })
    expect(harness.diagnostics.filter((message) => !message.startsWith("CCA executor channel-summary"))).toEqual([
      "CCA executor connected",
      "CCA executor channel-opened",
      "CCA executor connection-dropped",
      "CCA executor connected",
      "CCA executor channel-opened",
    ])

    await harness.host.stop()
    await harness.closed[1]
    expect(harness.scopes[0]!.closed).toBeDefined()
    await harness.scopes[0]!.closed.promise
    expect(alive(pid)).toBe(false)
  })

  test("resume on one connection: -32010 while attached, -32600 when unknown or expired, retry allowed on the same stream", async () => {
    const harness = await fixture({ ttlMs: 150 })
    await harness.host.start()
    const relay = await harness.connection(0)
    await relay.handshake()
    const sessionId = (await relay.initialize()).result.sessionId
    const pid = await relay.startSleeper(harness.home)
    harness.scopes[0]!.pid = pid

    const other = relay.stream("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
    await other.handshake()
    const busy = await other.request(1, "initialize", { clientName: "synthetic-harness", resumeSessionId: sessionId })
    expect(busy.error).toEqual({ code: -32010, message: `session ${sessionId} is already attached to another connection` })
    const unknown = await other.request(2, "initialize", { clientName: "synthetic-harness", resumeSessionId: "synthetic-unknown-session" })
    expect(unknown.error).toEqual({ code: -32600, message: "unknown session id synthetic-unknown-session" })

    relay.reset()
    for (let attempt = 0; attempt < 50 && harness.diagnostics.every((message) => !message.startsWith("CCA executor channel-summary")); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    const resumed = await other.request(3, "initialize", { clientName: "synthetic-harness", resumeSessionId: sessionId })
    expect(resumed.result.sessionId).toBe(sessionId)
    await other.send({ method: "initialized" })
    const read = await other.request(4, "process/read", { processId: "sleeper", waitMs: 0 })
    expect(read.result.exited).toBe(false)

    other.reset()
    await harness.scopes[0]!.closed.promise
    expect(harness.scopes[0]!.pidAliveAtClose).toBe(false)
    const late = relay.stream("7ba7b810-9dad-11d1-80b4-00c04fd430c8")
    await late.handshake()
    const expired = await late.request(1, "initialize", { clientName: "synthetic-harness", resumeSessionId: sessionId })
    expect(expired.error).toEqual({ code: -32600, message: `unknown session id ${sessionId}` })
    expect(harness.scopes).toHaveLength(1)
  })
})
