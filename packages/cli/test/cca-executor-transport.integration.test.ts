import { afterEach, describe, expect, test } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { WebSocket, WebSocketServer, type NodeWebSocket } from "ws"
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
  type RelayMessageFrame,
} from "../src/remote-control/cca-relay"

const syntheticCredential: CcaExecutorCredential = {
  accessToken: "synthetic_access_token_integ_12345",
  accountID: "synthetic_account_id_integ_67890",
}

const mockPublicKey: CcaNoisePublicKey = {
  suite: "noise_hybrid_ik_v1",
  x25519_public_key: "synthetic_x25519_integ_b64",
  mlkem768_public_key: "synthetic_mlkem768_integ_b64",
}

const mockIdentity: CcaNoiseIdentity = {
  publicKey: mockPublicKey,
}

const testEnvId = "env_integ_test_001"
const testStreamId = "550e8400-e29b-41d4-a716-446655440000"

const fakeCipher: CcaNoiseTransport = {
  async encrypt(bytes: Uint8Array): Promise<Uint8Array> {
    const ciphertext = new Uint8Array(bytes.length + 1)
    ciphertext[0] = 0x7a
    ciphertext.set(bytes, 1)
    return ciphertext
  },
  async decrypt(bytes: Uint8Array): Promise<Uint8Array> {
    if (bytes.length === 0 || bytes[0] !== 0x7a) {
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

describe("cca-executor-transport integration with real loopback HTTP registry and real ws server", () => {
  test("runs full lifecycle: registration, handshake, validate, bidirectional data, keepalive, and close", async () => {
    const registryCalls: { path: string; headers: http.IncomingHttpHeaders; body: any }[] = []
    const validateRequestSeen = createDeferred<void>()

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
        } catch {
        }
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
              url: "wss://rendezvous.chatgpt.com/cloud-agent/ws?role=environment&sig=signed_token_123",
              security_profile: "noise_hybrid_ik_v1",
              executor_registration_id: "exec-reg-integ-001",
            }),
          )
        } else if (req.url?.includes(`/cloud/environment/${testEnvId}/validate`)) {
          validateRequestSeen.resolve()
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ valid: true }))
        } else {
          res.writeHead(404)
          res.end("not found")
        }
      })
    })

    await new Promise<void>((resolve) => registryServer.listen(0, "127.0.0.1", () => resolve()))
    const registryAddr = registryServer.address() as AddressInfo
    const registryBaseURL = `http://127.0.0.1:${registryAddr.port}`
    cleanupStack.push(() => new Promise((resolve) => registryServer.close(() => resolve())))

    const wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" })
    await new Promise<void>((resolve) => wsServer.on("listening", () => resolve()))
    const wsAddr = wsServer.address() as AddressInfo
    const wsUrl = `ws://127.0.0.1:${wsAddr.port}`
    cleanupStack.push(() => new Promise((resolve) => wsServer.close(() => resolve())))

    let wsConnectionHeaders: http.IncomingHttpHeaders | undefined
    let serverClientSocket: NodeWebSocket | undefined
    const serverConnected = createDeferred<NodeWebSocket>()
    const serverReceivedDataFrames: RelayMessageFrame[] = []
    const pingReceivedOnServer = createDeferred<void>()
    const dataFrameReceivedOnServer = createDeferred<RelayMessageFrame>()
    const handshakeResponseReceived = createDeferred<RelayMessageFrame>()

    wsServer.on("connection", (socket, request) => {
      serverClientSocket = socket
      wsConnectionHeaders = request.headers
      serverConnected.resolve(socket)

      socket.on("message", (data) => {
        const bytes = new Uint8Array(data as Buffer)
        const frame = decodeRelayMessageFrame(bytes)
        serverReceivedDataFrames.push(frame)
        if (frame.body?.kind === "handshake") {
          handshakeResponseReceived.resolve(frame)
        } else if (frame.body?.kind === "data") {
          dataFrameReceivedOnServer.resolve(frame)
        }
      })

      socket.on("ping", () => {
        pingReceivedOnServer.resolve()
        socket.pong()
      })
    })

    let dispatchedChannel: CcaChannel | undefined
    const channelReady = createDeferred<CcaChannel>()

    const transportHandle = await startCcaExecutorTransport({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      registryBaseURL,
      keepaliveIntervalMs: 30,
      pongTimeoutMs: 60,
      connectWebSocket: async (_url, headers) => {
        return new WebSocket(wsUrl, { headers })
      },
      acceptHandshake: async (input) => {
        await input.authorize(mockPublicKey, "auth-harness-key-token")
        return {
          response: new Uint8Array([0x55, 0xaa]),
          transport: fakeCipher,
        }
      },
      onChannel: (ch) => {
        dispatchedChannel = ch
        channelReady.resolve(ch)
      },
    })
    cleanupStack.push(() => transportHandle.close())

    expect(registryCalls.length).toBe(1)
    expect(registryCalls[0].path).toBe(`/cloud/environment/${testEnvId}/register`)
    expect(registryCalls[0].headers["authorization"]).toBe(`Bearer ${syntheticCredential.accessToken}`)
    expect(registryCalls[0].headers["chatgpt-account-id"]).toBe(syntheticCredential.accountID)
    expect(registryCalls[0].body).toEqual({
      security_profile: "noise_hybrid_ik_v1",
      executor_public_key: mockPublicKey,
    })

    const serverWs = await withTimeout(serverConnected.promise, 1000, "WebSocket server connection")
    expect(wsConnectionHeaders).toBeDefined()
    expect(wsConnectionHeaders!["authorization"]).toBeUndefined()
    expect(wsConnectionHeaders!["chatgpt-account-id"]).toBeUndefined()
    expect(wsConnectionHeaders!["sec-websocket-protocol"]).toBeUndefined()
    expect(wsConnectionHeaders!["x-request-id"]).toMatch(/^req_[0-9a-f-]+$/i)

    const handshakeReqPayload = new Uint8Array([1, 2, 3, 4])
    const handshakeFrame = encodeRelayMessageFrame({
      version: 1,
      stream_id: testStreamId,
      body: { kind: "handshake", handshake: { payload: handshakeReqPayload } },
    })
    serverWs.send(handshakeFrame)

    await withTimeout(validateRequestSeen.promise, 1000, "registry /validate call")
    expect(registryCalls.length).toBe(2)
    expect(registryCalls[1].path).toBe(`/cloud/environment/${testEnvId}/validate`)
    expect(registryCalls[1].headers["authorization"]).toBe(`Bearer ${syntheticCredential.accessToken}`)
    expect(registryCalls[1].headers["chatgpt-account-id"]).toBe(syntheticCredential.accountID)
    expect(registryCalls[1].headers["x-codex-noise-stream-id"]).toBe(testStreamId)
    expect(registryCalls[1].body).toEqual({
      executor_registration_id: "exec-reg-integ-001",
      harness_public_key: mockPublicKey,
      harness_key_authorization: "auth-harness-key-token",
    })

    const channel = await withTimeout(channelReady.promise, 1000, "channel dispatch")
    expect(channel.streamID).toBe(testStreamId)

    const hsRespFrame = await withTimeout(handshakeResponseReceived.promise, 1000, "handshake response on server")
    expect(hsRespFrame.body).toEqual({
      kind: "handshake",
      handshake: { payload: new Uint8Array([0x55, 0xaa]) },
    })

    const appMessageText = "hello from integration test harness through real loopback socket!"
    const appMessageBytes = new TextEncoder().encode(appMessageText)
    const framedAppMessage = frameMessage(appMessageBytes)

    const half = Math.floor(framedAppMessage.length / 2)
    const chunk0 = framedAppMessage.subarray(0, half)
    const chunk1 = framedAppMessage.subarray(half)

    const cipher0 = await fakeCipher.encrypt(chunk0)
    const cipher1 = await fakeCipher.encrypt(chunk1)

    const receivedMessages: Uint8Array[] = []
    const messageReceived = createDeferred<Uint8Array>()
    ;(async () => {
      for await (const msg of channel.messages) {
        receivedMessages.push(msg)
        messageReceived.resolve(msg)
        break
      }
    })()

    serverWs.send(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "data", data: { seq: 1, segment_index: 0, segment_count: 1, payload: cipher1 } },
      }),
    )

    serverWs.send(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "data", data: { seq: 0, segment_index: 0, segment_count: 1, payload: cipher0 } },
      }),
    )

    const reassembled = await withTimeout(messageReceived.promise, 1000, "out-of-order reassembly")
    expect(new TextDecoder().decode(reassembled)).toBe(appMessageText)

    const clientSendText = "outbound message from executor channel"
    await channel.send(new TextEncoder().encode(clientSendText))

    const clientFrame = await withTimeout(dataFrameReceivedOnServer.promise, 1000, "client outbound data frame")
    expect(clientFrame.stream_id).toBe(testStreamId)
    if (clientFrame.body?.kind !== "data") {
      throw new Error("expected data frame from client")
    }

    const decryptedOutbound = await fakeCipher.decrypt(clientFrame.body.data.payload)
    const outboundLen = new DataView(decryptedOutbound.buffer, decryptedOutbound.byteOffset, 4).getUint32(0, false)
    const outboundPayload = decryptedOutbound.subarray(4, 4 + outboundLen)
    expect(new TextDecoder().decode(outboundPayload)).toBe(clientSendText)

    await withTimeout(pingReceivedOnServer.promise, 1000, "WebSocket keepalive ping")

    await transportHandle.close()
    expect(channel.signal.aborted).toBe(true)
  })

  test("abrupt server socket termination aborts active channel signal and close resolves cleanly", async () => {
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
          executor_registration_id: "exec-reg-integ-002",
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
    const connected = createDeferred<NodeWebSocket>()
    wsServer.on("connection", (socket) => {
      serverSocket = socket
      connected.resolve(socket)
    })

    const channelReady = createDeferred<CcaChannel>()
    const transportHandle = await startCcaExecutorTransport({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      registryBaseURL: `http://127.0.0.1:${regAddr.port}`,
      connectWebSocket: async (_url, headers) => new WebSocket(`ws://127.0.0.1:${wsAddr.port}`, { headers }),
      acceptHandshake: async (input) => {
        await input.authorize(mockPublicKey, "auth-harness-key-token")
        return {
          response: new Uint8Array([1]),
          transport: fakeCipher,
        }
      },
      onChannel: (ch) => channelReady.resolve(ch),
    })
    cleanupStack.push(() => transportHandle.close())

    const sSocket = await withTimeout(connected.promise, 1000, "connection")
    sSocket.send(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )

    const channel = await withTimeout(channelReady.promise, 1000, "channel")
    expect(channel.signal.aborted).toBe(false)

    sSocket.terminate()

    const abortDeferred = createDeferred<void>()
    if (channel.signal.aborted) {
      abortDeferred.resolve()
    } else {
      channel.signal.addEventListener("abort", () => abortDeferred.resolve())
    }
    await withTimeout(abortDeferred.promise, 1000, "channel abort on abrupt close")
    expect(channel.signal.aborted).toBe(true)

    await expect(transportHandle.close()).resolves.toBeUndefined()
  })

  test("server sending frame exceeding 256 KiB triggers websocket closure under maxPayload", async () => {
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
          executor_registration_id: "exec-reg-integ-003",
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
    const connected = createDeferred<NodeWebSocket>()
    const socketClosedOnServer = createDeferred<{ code: number; reason: string }>()

    wsServer.on("connection", (socket) => {
      serverSocket = socket
      connected.resolve(socket)
      socket.on("close", (code, reason) => {
        socketClosedOnServer.resolve({ code, reason: reason.toString() })
      })
    })

    const channelReady = createDeferred<CcaChannel>()
    const transportHandle = await startCcaExecutorTransport({
      environmentID: testEnvId,
      credential: syntheticCredential,
      identity: mockIdentity,
      registryBaseURL: `http://127.0.0.1:${regAddr.port}`,
      connectWebSocket: async (_url, headers) =>
        new WebSocket(`ws://127.0.0.1:${wsAddr.port}`, {
          headers,
          maxPayload: 256 * 1024,
        }),
      acceptHandshake: async (input) => {
        await input.authorize(mockPublicKey, "auth-harness-key-token")
        return {
          response: new Uint8Array([1]),
          transport: fakeCipher,
        }
      },
      onChannel: (ch) => channelReady.resolve(ch),
    })
    cleanupStack.push(() => transportHandle.close())

    const sSocket = await withTimeout(connected.promise, 1000, "connection")
    sSocket.send(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )

    const channel = await withTimeout(channelReady.promise, 1000, "channel")

    const oversized = new Uint8Array(256 * 1024 + 10)
    sSocket.send(oversized)

    const closeInfo = await withTimeout(socketClosedOnServer.promise, 1000, "socket close on oversized payload")
    expect(closeInfo.code).toBe(1009)

    const abortDeferred = createDeferred<void>()
    if (channel.signal.aborted) {
      abortDeferred.resolve()
    } else {
      channel.signal.addEventListener("abort", () => abortDeferred.resolve())
    }
    await withTimeout(abortDeferred.promise, 1000, "client channel abort on oversized frame close")
    expect(channel.signal.aborted).toBe(true)

    await transportHandle.close()
  })
})
