import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { WebSocket, WebSocketServer, type NodeWebSocket } from "ws"

import { createCcaExecutor } from "@ycoding-ai/core/cca/executor"
import { runCcaChannelRpc } from "../src/remote-control/cca-channel-rpc"
import { fixedScopeFor } from "./fixture/cca-scope"
import {
  startCcaExecutorTransport,
  type CcaChannel,
  type CcaExecutorCredential,
  type CcaNoiseIdentity,
  type CcaNoisePublicKey,
  type CcaNoiseTransport,
} from "../src/remote-control/cca-executor-transport"
import {
  decodeRelayMessageFrame,
  encodeRelayMessageFrame,
  frameMessage,
  MessageDecoder,
  type RelayMessageFrame,
} from "../src/remote-control/cca-relay"

const syntheticCredential: CcaExecutorCredential = {
  accessToken: "synthetic_access_token_stack_integ",
  accountID: "synthetic_account_id_stack_integ",
}

const mockPublicKey: CcaNoisePublicKey = {
  suite: "noise_hybrid_ik_v1",
  x25519_public_key: "synthetic_x25519_stack_b64",
  mlkem768_public_key: "synthetic_mlkem768_stack_b64",
}

const mockIdentity: CcaNoiseIdentity = {
  publicKey: mockPublicKey,
}

const testEnvId = "env_stack_integ_001"
const testStreamId = "550e8400-e29b-41d4-a716-446655440000"

const fakeCipher: CcaNoiseTransport = {
  async encrypt(bytes: Uint8Array): Promise<Uint8Array> {
    const ciphertext = new Uint8Array(bytes.length + 1)
    ciphertext[0] = 0x8b
    ciphertext.set(bytes, 1)
    return ciphertext
  },
  async decrypt(bytes: Uint8Array): Promise<Uint8Array> {
    if (bytes.length === 0 || bytes[0] !== 0x8b) {
      throw new Error("Fake cipher decryption failed: invalid tag")
    }
    return bytes.subarray(1)
  },
}

type CleanupItem = () => Promise<void> | void
const cleanupStack: CleanupItem[] = []

afterEach(async () => {
  while (cleanupStack.length > 0) {
    const fn = cleanupStack.pop()
    if (fn) {
      try {
        await fn()
      } catch {
      }
    }
  }
})

function createDeferred<T = void>() {
  let resolve!: (val: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer))
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cca-stack-test-"))
  cleanupStack.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe("cca-executor-stack offline integration", () => {
  test("end-to-end full-stack RPC execution over real transport and real subprocess", async () => {
    const tempRoot = await makeTempDir()

    const registryCalls: { path: string; headers: http.IncomingHttpHeaders; body: any }[] = []
    const registryServer = http.createServer((req, res) => {
      let bodyText = ""
      req.setEncoding("utf8")
      req.on("data", (chunk) => {
        bodyText += chunk
      })
      req.on("end", () => {
        let parsedBody: any = null
        try {
          parsedBody = JSON.parse(bodyText)
        } catch {}
        registryCalls.push({
          path: req.url ?? "",
          headers: req.headers,
          body: parsedBody,
        })

        if (req.url?.includes(`/cloud/environment/${testEnvId}/register`)) {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(
            JSON.stringify({
              environment_id: testEnvId,
              url: "wss://rendezvous.chatgpt.com/cloud-agent/ws?role=environment&sig=fake_token_stack",
              security_profile: "noise_hybrid_ik_v1",
              executor_registration_id: "exec-reg-stack-001",
            }),
          )
        } else if (req.url?.includes(`/cloud/environment/${testEnvId}/validate`)) {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ valid: true }))
        } else {
          res.writeHead(404)
          res.end("not found")
        }
      })
    })

    await new Promise<void>((r) => registryServer.listen(0, "127.0.0.1", () => r()))
    const regAddr = registryServer.address() as AddressInfo
    cleanupStack.push(() => new Promise((r) => registryServer.close(() => r())))

    const wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" })
    await new Promise<void>((r) => wsServer.on("listening", () => r()))
    const wsAddr = wsServer.address() as AddressInfo
    cleanupStack.push(() => new Promise((r) => wsServer.close(() => r())))

    let wsConnectionHeaders: http.IncomingHttpHeaders | undefined
    let serverWs: NodeWebSocket | undefined
    const serverConnected = createDeferred<NodeWebSocket>()
    const incomingHarnessQueue: Uint8Array[] = []
    let harnessMessageWaiter: (() => void) | undefined

    wsServer.on("connection", (socket, request) => {
      serverWs = socket
      wsConnectionHeaders = request.headers
      serverConnected.resolve(socket)

      socket.on("message", (data) => {
        const bytes = new Uint8Array(data as Buffer)
        incomingHarnessQueue.push(bytes)
        if (harnessMessageWaiter) {
          const w = harnessMessageWaiter
          harnessMessageWaiter = undefined
          w()
        }
      })
    })

    let authorizeCallCount = 0
    const authorizeSpy = async (_input: { action: string; resources: readonly string[] }) => {
      authorizeCallCount++
      return { release: async () => {} }
    }

    const executor = createCcaExecutor({ scopeFor: fixedScopeFor([tempRoot], authorizeSpy) })
    cleanupStack.push(() => executor.close())

    const transportHandle = await startCcaExecutorTransport({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      registryBaseURL: `http://127.0.0.1:${regAddr.port}`,
      connectWebSocket: async (_url, headers) => new WebSocket(`ws://127.0.0.1:${wsAddr.port}`, { headers }),
      acceptHandshake: async (input) => {
        await input.authorize(mockPublicKey, "auth-token-stack")
        return {
          response: new Uint8Array([0x42]),
          transport: fakeCipher,
        }
      },
      onChannel: (channel: CcaChannel) => {
        void runCcaChannelRpc({
          channel,
          environmentInfo: {
            shell: { name: "sh", path: "/bin/sh" },
            executorVersion: "1.0.0",
            capabilities: {},
          },
          handler: executor,
        }).catch(() => {})
      },
    })
    cleanupStack.push(() => transportHandle.close())

    const harnessSocket = await withTimeout(serverConnected.promise, 1000, "ws server connection")

    expect(wsConnectionHeaders).toBeDefined()
    expect(wsConnectionHeaders!["authorization"]).toBeUndefined()
    expect(wsConnectionHeaders!["chatgpt-account-id"]).toBeUndefined()
    expect(wsConnectionHeaders!["sec-websocket-protocol"]).toBeUndefined()
    expect(wsConnectionHeaders!["x-request-id"]).toMatch(/^req_[0-9a-f-]+$/i)

    let harnessOutboundSeq = 0
    const harnessDecoder = new MessageDecoder()
    const responseWaiters = new Map<number | string, (res: any) => void>()
    const receivedResponses = new Map<number | string, any>()
    const receivedNotifications: any[] = []

    async function sendHarnessFrame(frame: RelayMessageFrame) {
      harnessSocket.send(encodeRelayMessageFrame(frame))
    }

    async function receiveHarnessFrame(): Promise<RelayMessageFrame> {
      while (incomingHarnessQueue.length === 0) {
        await new Promise<void>((r) => {
          harnessMessageWaiter = r
        })
      }
      const raw = incomingHarnessQueue.shift()!
      return decodeRelayMessageFrame(raw)
    }

    async function pumpNextFrame(): Promise<void> {
      const frame = await receiveHarnessFrame()
      if (frame.body?.kind === "data") {
        const plaintext = await fakeCipher.decrypt(frame.body.data.payload)
        const messages = harnessDecoder.push(plaintext)
        for (const msgBytes of messages) {
          const parsed = JSON.parse(new TextDecoder().decode(msgBytes))
          if (parsed.id !== undefined) {
            const waiter = responseWaiters.get(parsed.id)
            if (waiter) {
              responseWaiters.delete(parsed.id)
              waiter(parsed)
            } else {
              receivedResponses.set(parsed.id, parsed)
            }
          } else {
            receivedNotifications.push(parsed)
          }
        }
      }
    }

    async function sendHarnessJsonRpc(msg: { id?: number | string; method: string; params?: unknown }) {
      const jsonBytes = new TextEncoder().encode(JSON.stringify(msg))
      const framed = frameMessage(jsonBytes)
      const ciphertext = await fakeCipher.encrypt(framed)
      await sendHarnessFrame({
        version: 1,
        stream_id: testStreamId,
        body: {
          kind: "data",
          data: {
            seq: harnessOutboundSeq++,
            segment_index: 0,
            segment_count: 1,
            payload: ciphertext,
          },
        },
      })
    }

    async function receiveHarnessResponse(id: number | string): Promise<any> {
      if (receivedResponses.has(id)) {
        const res = receivedResponses.get(id)
        receivedResponses.delete(id)
        return res
      }
      return new Promise((resolve) => {
        responseWaiters.set(id, resolve)
        const drain = async () => {
          while (responseWaiters.has(id)) {
            await pumpNextFrame()
          }
        }
        drain()
      })
    }

    await sendHarnessFrame({
      version: 1,
      stream_id: testStreamId,
      body: { kind: "handshake", handshake: { payload: new Uint8Array([0x11]) } },
    })

    const hsResp = await withTimeout(receiveHarnessFrame(), 1000, "handshake response")
    expect(hsResp.body?.kind).toBe("handshake")

    await sendHarnessJsonRpc({
      id: 1,
      method: "initialize",
      params: { clientName: "stack-integ-client" },
    })
    const initResp = await withTimeout(receiveHarnessResponse(1), 1000, "initialize response")
    expect(initResp.id).toBe(1)
    expect(initResp.result.sessionId).toBeDefined()
    expect(initResp.result.environmentInfo).toBeDefined()

    await sendHarnessJsonRpc({
      method: "initialized",
    })

    await sendHarnessJsonRpc({
      id: 2,
      method: "environment/status",
    })
    const statusResp = await withTimeout(receiveHarnessResponse(2), 1000, "environment/status response")
    expect(statusResp.id).toBe(2)
    expect(statusResp.result.status).toBe("ready")

    const testEchoString = "hello from real subprocess echo via cca transport!"
    await sendHarnessJsonRpc({
      id: 3,
      method: "process/start",
      params: {
        processId: "proc-echo-1",
        argv: [process.execPath, "-e", `process.stdout.write("${testEchoString}")`],
        cwd: pathToFileURL(tempRoot).href,
        env: {},
      },
    })
    const startResp = await withTimeout(receiveHarnessResponse(3), 2000, "process/start response")
    expect(startResp.id).toBe(3)
    expect(startResp.result.processId).toBe("proc-echo-1")

    let combinedStdout = ""
    let exited = false
    let afterSeq: number | undefined

    for (let attempt = 0; attempt < 20 && !exited; attempt++) {
      const readReqId = 4 + attempt
      await sendHarnessJsonRpc({
        id: readReqId,
        method: "process/read",
        params: {
          processId: "proc-echo-1",
          afterSeq,
          waitMs: 50,
        },
      })
      const readResp = await withTimeout(receiveHarnessResponse(readReqId), 1000, `process/read response ${readReqId}`)
      expect(readResp.result).toBeDefined()
      for (const chunk of readResp.result.chunks) {
        if (chunk.stream === "stdout") {
          combinedStdout += Buffer.from(chunk.chunk, "base64").toString("utf8")
        }
      }
      afterSeq = readResp.result.nextSeq
      if (readResp.result.exited) {
        exited = true
        expect(readResp.result.exitCode).toBe(0)
      }
    }
    expect(exited).toBe(true)
    expect(combinedStdout).toBe(testEchoString)

    const testFilePath = path.join(tempRoot, "test-file.txt")
    const testFileUri = pathToFileURL(testFilePath).href
    const fileContent = "roundtrip content via cca fs methods"
    const fileBase64 = Buffer.from(fileContent).toString("base64")

    await sendHarnessJsonRpc({
      id: 30,
      method: "fs/writeFile",
      params: {
        path: testFileUri,
        dataBase64: fileBase64,
      },
    })
    const writeResp = await withTimeout(receiveHarnessResponse(30), 1000, "fs/writeFile response")
    expect(writeResp.id).toBe(30)
    expect(writeResp.error).toBeUndefined()

    await sendHarnessJsonRpc({
      id: 31,
      method: "fs/readFile",
      params: {
        path: testFileUri,
      },
    })
    const readResp = await withTimeout(receiveHarnessResponse(31), 1000, "fs/readFile response")
    expect(readResp.id).toBe(31)
    expect(readResp.result.dataBase64).toBe(fileBase64)
    expect(Buffer.from(readResp.result.dataBase64, "base64").toString("utf8")).toBe(fileContent)

    const outsideUri = pathToFileURL(path.join(os.tmpdir(), "outside-root.txt")).href
    await sendHarnessJsonRpc({
      id: 32,
      method: "fs/readFile",
      params: {
        path: outsideUri,
      },
    })
    const outsideResp = await withTimeout(receiveHarnessResponse(32), 1000, "fs/readFile outside root")
    expect(outsideResp.id).toBe(32)
    expect(outsideResp.error).toBeDefined()
    expect(outsideResp.result).toBeUndefined()

    expect(authorizeCallCount).toBeGreaterThan(0)

    await transportHandle.close()
  })

  test("authorize-deny instance returns error -32001 and spawns no process", async () => {
    const tempRoot = await makeTempDir()

    const registryServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      if (req.url?.includes("/validate")) {
        res.end(JSON.stringify({ valid: true }))
        return
      }
      res.end(
        JSON.stringify({
          environment_id: testEnvId,
          url: "wss://rendezvous.chatgpt.com/ws",
          security_profile: "noise_hybrid_ik_v1",
          executor_registration_id: "exec-reg-deny",
        }),
      )
    })
    await new Promise<void>((r) => registryServer.listen(0, "127.0.0.1", () => r()))
    const regAddr = registryServer.address() as AddressInfo
    cleanupStack.push(() => new Promise((r) => registryServer.close(() => r())))

    const wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" })
    await new Promise<void>((r) => wsServer.on("listening", () => r()))
    const wsAddr = wsServer.address() as AddressInfo
    cleanupStack.push(() => new Promise((r) => wsServer.close(() => r())))

    let serverWs: NodeWebSocket | undefined
    const serverConnected = createDeferred<NodeWebSocket>()
    const incomingQueue: Uint8Array[] = []
    let waiter: (() => void) | undefined

    wsServer.on("connection", (socket) => {
      serverWs = socket
      serverConnected.resolve(socket)
      socket.on("message", (data) => {
        incomingQueue.push(new Uint8Array(data as Buffer))
        if (waiter) {
          const w = waiter
          waiter = undefined
          w()
        }
      })
    })

    const denyingAuthorize = async (_input: { action: string }): Promise<never> => {
      throw new Error("unauthorized action: process execution denied by policy")
    }

    const executor = createCcaExecutor({ scopeFor: fixedScopeFor([tempRoot], denyingAuthorize) })
    cleanupStack.push(() => executor.close())

    const transportHandle = await startCcaExecutorTransport({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      registryBaseURL: `http://127.0.0.1:${regAddr.port}`,
      connectWebSocket: async (_url, headers) => new WebSocket(`ws://127.0.0.1:${wsAddr.port}`, { headers }),
      acceptHandshake: async (input) => {
        await input.authorize(mockPublicKey, "auth-token-stack")
        return {
          response: new Uint8Array([1]),
          transport: fakeCipher,
        }
      },
      onChannel: (channel) => {
        void runCcaChannelRpc({
          channel,
          environmentInfo: { shell: { name: "sh", path: "/bin/sh" }, capabilities: {} },
          handler: executor,
        }).catch(() => {})
      },
    })
    cleanupStack.push(() => transportHandle.close())

    const harnessSocket = await withTimeout(serverConnected.promise, 1000, "ws connection")
    const decoder = new MessageDecoder()
    const test2Responses = new Map<number | string, any>()
    const test2Waiters = new Map<number | string, (res: any) => void>()

    async function sendFrame(frame: RelayMessageFrame) {
      harnessSocket.send(encodeRelayMessageFrame(frame))
    }

    async function receiveFrame(): Promise<RelayMessageFrame> {
      while (incomingQueue.length === 0) {
        await new Promise<void>((r) => {
          waiter = r
        })
      }
      return decodeRelayMessageFrame(incomingQueue.shift()!)
    }

    let seq = 0
    async function sendJsonRpc(msg: any) {
      const framed = frameMessage(new TextEncoder().encode(JSON.stringify(msg)))
      const ciphertext = await fakeCipher.encrypt(framed)
      await sendFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "data", data: { seq: seq++, segment_index: 0, segment_count: 1, payload: ciphertext } },
      })
    }

    async function pumpTest2Frame(): Promise<void> {
      const frame = await receiveFrame()
      if (frame.body?.kind === "data") {
        const plaintext = await fakeCipher.decrypt(frame.body.data.payload)
        for (const msgBytes of decoder.push(plaintext)) {
          const parsed = JSON.parse(new TextDecoder().decode(msgBytes))
          if (parsed.id !== undefined) {
            const w = test2Waiters.get(parsed.id)
            if (w) {
              test2Waiters.delete(parsed.id)
              w(parsed)
            } else {
              test2Responses.set(parsed.id, parsed)
            }
          }
        }
      }
    }

    async function receiveJsonRpcResponse(id: number | string): Promise<any> {
      if (test2Responses.has(id)) {
        const res = test2Responses.get(id)
        test2Responses.delete(id)
        return res
      }
      return new Promise((resolve) => {
        test2Waiters.set(id, resolve)
        const drain = async () => {
          while (test2Waiters.has(id)) {
            await pumpTest2Frame()
          }
        }
        drain()
      })
    }

    await sendFrame({
      version: 1,
      stream_id: testStreamId,
      body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
    })
    await receiveFrame()

    await sendJsonRpc({ id: 1, method: "initialize", params: { clientName: "deny-client" } })
    await receiveJsonRpcResponse(1)
    await sendJsonRpc({ method: "initialized" })

    const markerFile = path.join(tempRoot, "should-not-exist.marker")
    await sendJsonRpc({
      id: 2,
      method: "process/start",
      params: {
        processId: "proc-denied",
        argv: [process.execPath, "-e", `require('fs').writeFileSync("${markerFile}", "ran")`],
        cwd: pathToFileURL(tempRoot).href,
        env: {},
      },
    })

    const denyResp = await withTimeout(receiveJsonRpcResponse(2), 1000, "process/start deny response")
    expect(denyResp.id).toBe(2)
    expect(denyResp.error).toBeDefined()
    expect(denyResp.error.code).toBe(-32001)

    const fileExists = await readFile(markerFile).then(() => true).catch(() => false)
    expect(fileExists).toBe(false)

    await transportHandle.close()
  })

  test("abrupt websocket close causes executor close to terminate long-running child process", async () => {
    const tempRoot = await makeTempDir()

    const registryServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      if (req.url?.includes("/validate")) {
        res.end(JSON.stringify({ valid: true }))
        return
      }
      res.end(
        JSON.stringify({
          environment_id: testEnvId,
          url: "wss://rendezvous.chatgpt.com/ws",
          security_profile: "noise_hybrid_ik_v1",
          executor_registration_id: "exec-reg-sleep",
        }),
      )
    })
    await new Promise<void>((r) => registryServer.listen(0, "127.0.0.1", () => r()))
    const regAddr = registryServer.address() as AddressInfo
    cleanupStack.push(() => new Promise((r) => registryServer.close(() => r())))

    const wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" })
    await new Promise<void>((r) => wsServer.on("listening", () => r()))
    const wsAddr = wsServer.address() as AddressInfo
    cleanupStack.push(() => new Promise((r) => wsServer.close(() => r())))

    let serverSocket: NodeWebSocket | undefined
    const serverConnected = createDeferred<NodeWebSocket>()
    const incomingQueue: Uint8Array[] = []
    let waiter: (() => void) | undefined

    wsServer.on("connection", (socket) => {
      serverSocket = socket
      serverConnected.resolve(socket)
      socket.on("message", (data) => {
        incomingQueue.push(new Uint8Array(data as Buffer))
        if (waiter) {
          const w = waiter
          waiter = undefined
          w()
        }
      })
    })

    const executor = createCcaExecutor({ scopeFor: fixedScopeFor([tempRoot], async () => ({ release: async () => {} })) })
    cleanupStack.push(() => executor.close())

    const rpcCompleted = createDeferred<void>()
    const transportHandle = await startCcaExecutorTransport({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      registryBaseURL: `http://127.0.0.1:${regAddr.port}`,
      connectWebSocket: async (_url, headers) => new WebSocket(`ws://127.0.0.1:${wsAddr.port}`, { headers }),
      acceptHandshake: async (input) => {
        await input.authorize(mockPublicKey, "auth-token-stack")
        return {
          response: new Uint8Array([1]),
          transport: fakeCipher,
        }
      },
      onChannel: (channel) => {
        void (async () => {
          try {
            await runCcaChannelRpc({
              channel,
              environmentInfo: { shell: { name: "sh", path: "/bin/sh" }, capabilities: {} },
              handler: executor,
            })
          } catch {
          } finally {
            rpcCompleted.resolve()
          }
        })()
      },
    })
    cleanupStack.push(() => transportHandle.close())

    const harnessSocket = await withTimeout(serverConnected.promise, 1000, "ws connection")
    const decoder = new MessageDecoder()

    async function sendFrame(frame: RelayMessageFrame) {
      harnessSocket.send(encodeRelayMessageFrame(frame))
    }

    async function receiveFrame(): Promise<RelayMessageFrame> {
      while (incomingQueue.length === 0) {
        await new Promise<void>((r) => {
          waiter = r
        })
      }
      return decodeRelayMessageFrame(incomingQueue.shift()!)
    }

    let seq = 0
    async function sendJsonRpc(msg: any) {
      const framed = frameMessage(new TextEncoder().encode(JSON.stringify(msg)))
      const ciphertext = await fakeCipher.encrypt(framed)
      await sendFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "data", data: { seq: seq++, segment_index: 0, segment_count: 1, payload: ciphertext } },
      })
    }

    async function receiveJsonRpc(): Promise<any> {
      while (true) {
        const frame = await receiveFrame()
        if (frame.body?.kind === "data") {
          const plaintext = await fakeCipher.decrypt(frame.body.data.payload)
          const messages = decoder.push(plaintext)
          if (messages.length > 0) {
            return JSON.parse(new TextDecoder().decode(messages[0]))
          }
        }
      }
    }

    await sendFrame({
      version: 1,
      stream_id: testStreamId,
      body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
    })
    await receiveFrame()

    await sendJsonRpc({ id: 1, method: "initialize", params: { clientName: "sleep-client" } })
    await receiveJsonRpc()
    await sendJsonRpc({ method: "initialized" })

    const pidFile = path.join(tempRoot, "child.pid")
    await sendJsonRpc({
      id: 2,
      method: "process/start",
      params: {
        processId: "proc-sleep-1",
        argv: [
          process.execPath,
          "-e",
          `require('fs').writeFileSync("${pidFile}", String(process.pid)); setTimeout(() => {}, 60000)`,
        ],
        cwd: pathToFileURL(tempRoot).href,
        env: {},
      },
    })
    const startResp = await withTimeout(receiveJsonRpc(), 1000, "start sleep process")
    expect(startResp.result?.processId).toBe("proc-sleep-1")

    let childPid: number | undefined
    for (let i = 0; i < 50; i++) {
      try {
        const text = await readFile(pidFile, "utf8")
        const parsed = parseInt(text.trim(), 10)
        if (!isNaN(parsed) && parsed > 0) {
          childPid = parsed
          break
        }
      } catch {
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    expect(childPid).toBeDefined()

    const isAlive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(isAlive(childPid!)).toBe(true)

    serverSocket!.terminate()

    await withTimeout(rpcCompleted.promise, 1000, "rpc loop completion")

    await executor.close()
    await transportHandle.close()

    let processDead = false
    for (let i = 0; i < 50; i++) {
      if (!isAlive(childPid!)) {
        processDead = true
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(processDead).toBe(true)
  })
})
