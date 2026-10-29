import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import {
  acceptCcaNoiseHandshake,
  createCcaNoiseIdentity,
  type AcceptCcaNoiseHandshakeInput,
  type CcaNoisePublicKey,
} from "../src/remote-control/cca-noise"
import {
  decodeRelayMessageFrame,
  encodeRelayMessageFrame,
  frameMessage,
  MessageDecoder,
  RELAY_MESSAGE_FRAME_VERSION,
  type CcaChannel,
  type RelayMessageFrame,
} from "../src/remote-control/cca-relay"
import { startCcaExecutorTransport, type WebSocketLike } from "../src/remote-control/cca-executor-transport"

const referenceBinaryPath =
  process.env.CCA_NOISE_REFERENCE_BIN ?? "/tmp/ycoding-cargo-target/release/cca-noise-reference"

function requireReferenceBinary(): void {
  if (!existsSync(referenceBinaryPath)) {
    throw new Error(
      `CCA Noise reference binary not found at ${referenceBinaryPath}; build it with: ` +
        "CARGO_HOME=/tmp/ycoding-cargo-home CARGO_TARGET_DIR=/tmp/ycoding-cargo-target CARGO_BUILD_JOBS=2 " +
        "cargo build --release --manifest-path packages/cli/test/fixture/cca-noise-reference/Cargo.toml",
    )
  }
}

class RustPeerClient {
  private child: ReturnType<typeof spawn>
  private buffer: string = ""
  private resolvers: Array<(value: any) => void> = []

  constructor() {
    this.child = spawn(referenceBinaryPath, [], {
      stdio: ["pipe", "pipe", "inherit"],
    })
    this.child.stdout?.setEncoding("utf8")
    this.child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk
      let newlineIdx: number
      while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim()
        this.buffer = this.buffer.slice(newlineIdx + 1)
        if (line) {
          const parsed = JSON.parse(line)
          const resolve = this.resolvers.shift()
          if (resolve) resolve(parsed)
        }
      }
    })
  }

  private sendCommand(command: any): Promise<any> {
    return new Promise((resolve) => {
      this.resolvers.push(resolve)
      this.child.stdin?.write(JSON.stringify(command) + "\n")
    })
  }

  async start(
    responderPublicKey: CcaNoisePublicKey,
    envId: string,
    regId: string,
    streamId: string,
    payloadHex: string,
  ) {
    return await this.sendCommand({
      command: "start",
      responder_public_key: responderPublicKey,
      environment_id: envId,
      executor_registration_id: regId,
      stream_id: streamId,
      payload_hex: payloadHex,
    })
  }

  async finish(responseHex: string) {
    return await this.sendCommand({
      command: "finish",
      response_hex: responseHex,
    })
  }

  async encrypt(plaintextHex: string) {
    return await this.sendCommand({
      command: "encrypt",
      plaintext_hex: plaintextHex,
    })
  }

  async decrypt(ciphertextHex: string) {
    return await this.sendCommand({
      command: "decrypt",
      ciphertext_hex: ciphertextHex,
    })
  }

  close() {
    this.child.stdin?.end()
    this.child.kill()
  }
}

class FakeSocketEnd {
  peer: FakeSocketEnd | undefined
  closed = false
  private listeners = new Map<string, Array<(...args: any[]) => void>>()

  on(event: string, listener: (...args: any[]) => void): void {
    const existing = this.listeners.get(event) ?? []
    existing.push(listener)
    this.listeners.set(event, existing)
  }

  addEventListener(event: string, listener: (...args: any[]) => void): void {
    this.on(event, listener)
  }

  send(data: Uint8Array | string): void {
    const peer = this.peer
    if (!peer || peer.closed || this.closed) return
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
    queueMicrotask(() => peer.emit("message", bytes))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit("close")
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args)
    }
  }
}

function makeSocketPair(): [FakeSocketEnd, FakeSocketEnd] {
  const a = new FakeSocketEnd()
  const b = new FakeSocketEnd()
  a.peer = b
  b.peer = a
  return [a, b]
}

class FrameCollector {
  private frames: RelayMessageFrame[] = []
  private waiters: Array<(frame: RelayMessageFrame) => void> = []

  constructor(socket: FakeSocketEnd) {
    socket.on("message", (data: Uint8Array) => {
      const frame = decodeRelayMessageFrame(data)
      const waiter = this.waiters.shift()
      if (waiter) waiter(frame)
      else this.frames.push(frame)
    })
  }

  next(): Promise<RelayMessageFrame> {
    const frame = this.frames.shift()
    if (frame) return Promise.resolve(frame)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  get pendingCount(): number {
    return this.frames.length
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe("cca-noise carrier integration", () => {
  test("handshake response follows registry validation and framed bytes flow both ways", async () => {
    requireReferenceBinary()

    const identity = await createCcaNoiseIdentity()
    const envID = "env-carrier-1"
    const regID = "reg-carrier-1"
    const streamID = crypto.randomUUID()
    const authorization = "synthetic-carrier-authorization"

    let registerBody: any
    let validateBody: any
    let validateHeaders: Record<string, string> | undefined
    let validateURL = ""
    const validateCalled = deferred<void>()
    const validateGate = deferred<void>()

    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith(`/cloud/environment/${envID}/register`)) {
        registerBody = JSON.parse(String(init?.body))
        return Response.json({
          environment_id: envID,
          security_profile: "noise_hybrid_ik_v1",
          executor_registration_id: regID,
          url: "wss://relay.chatgpt.com/noise",
        })
      }
      if (url.endsWith(`/cloud/environment/${envID}/validate`)) {
        validateURL = url
        validateBody = JSON.parse(String(init?.body))
        validateHeaders = init?.headers as Record<string, string>
        validateCalled.resolve()
        await validateGate.promise
        return Response.json({ valid: true })
      }
      throw new Error(`Unexpected registry URL ${url}`)
    }

    const [executorEnd, harnessEnd] = makeSocketPair()
    const collector = new FrameCollector(harnessEnd)
    let wsURL = ""
    let wsHeaders: Record<string, string> = {}
    let channelCount = 0
    const channelReady = deferred<CcaChannel>()

    const peer = new RustPeerClient()
    const transport = await startCcaExecutorTransport({
      environmentID: envID,
      credential: { accessToken: "synthetic-token", accountID: "synthetic-account" },
      identity,
      fetch: fakeFetch,
      connectWebSocket: async (url, headers) => {
        wsURL = url
        wsHeaders = headers
        return executorEnd as unknown as WebSocketLike
      },
      acceptHandshake: (input) =>
        acceptCcaNoiseHandshake(input as unknown as AcceptCcaNoiseHandshakeInput),
      onChannel: (channel) => {
        channelCount++
        channelReady.resolve(channel)
      },
    })
    try {
      expect(registerBody.security_profile).toBe("noise_hybrid_ik_v1")
      expect(registerBody.executor_public_key).toEqual(identity.publicKey)
      expect(wsURL).toBe("wss://relay.chatgpt.com/noise")
      expect(Object.keys(wsHeaders)).toEqual(["x-request-id"])

      const startRes = await peer.start(
        identity.publicKey,
        envID,
        regID,
        streamID,
        Buffer.from(authorization, "utf8").toString("hex"),
      )
      expect(startRes.status).toBe("ok")

      harnessEnd.send(
        encodeRelayMessageFrame({
          version: RELAY_MESSAGE_FRAME_VERSION,
          stream_id: streamID,
          body: { kind: "handshake", handshake: { payload: Buffer.from(startRes.request_hex, "hex") } },
        }),
      )

      await validateCalled.promise
      expect(collector.pendingCount).toBe(0)
      expect(channelCount).toBe(0)
      expect(validateURL).toContain(`/cloud/environment/${envID}/validate`)
      expect(validateBody.executor_registration_id).toBe(regID)
      expect(validateBody.harness_public_key).toEqual(startRes.initiator_public_key)
      expect(validateBody.harness_key_authorization).toBe(authorization)
      expect(validateHeaders?.["x-codex-noise-stream-id"]).toBe(streamID)
      expect(validateHeaders?.authorization).toBe("Bearer synthetic-token")
      expect(validateHeaders?.["chatgpt-account-id"]).toBe("synthetic-account")

      validateGate.resolve()

      const responseFrame = await collector.next()
      expect(responseFrame.body?.kind).toBe("handshake")
      if (responseFrame.body?.kind !== "handshake") throw new Error("expected handshake response")
      const finishRes = await peer.finish(Buffer.from(responseFrame.body.handshake.payload).toString("hex"))
      expect(finishRes.status).toBe("ok")

      const channel = await channelReady.promise
      expect(channel.streamID).toBe(streamID)

      const appBytes = Buffer.from('{"jsonrpc":"2.0","method":"ping"}', "utf8")
      const enc = await peer.encrypt(Buffer.from(frameMessage(appBytes)).toString("hex"))
      expect(enc.status).toBe("ok")
      harnessEnd.send(
        encodeRelayMessageFrame({
          version: RELAY_MESSAGE_FRAME_VERSION,
          stream_id: streamID,
          body: {
            kind: "data",
            data: { seq: 0, segment_index: 0, segment_count: 1, payload: Buffer.from(enc.ciphertext_hex, "hex") },
          },
        }),
      )
      const iterator = channel.messages[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(first.done).toBe(false)
      expect(Buffer.from(first.value!).equals(appBytes)).toBe(true)

      const replyBytes = Buffer.from('{"jsonrpc":"2.0","result":"pong"}', "utf8")
      await channel.send(replyBytes)
      const dataFrame = await collector.next()
      expect(dataFrame.body?.kind).toBe("data")
      if (dataFrame.body?.kind !== "data") throw new Error("expected data frame")
      expect(dataFrame.body.data.seq).toBe(0)
      const dec = await peer.decrypt(Buffer.from(dataFrame.body.data.payload).toString("hex"))
      expect(dec.status).toBe("ok")
      const reassembled = new MessageDecoder().push(Buffer.from(dec.plaintext_hex, "hex"))
      expect(reassembled.length).toBe(1)
      expect(Buffer.from(reassembled[0]!).equals(replyBytes)).toBe(true)
    } finally {
      await transport.close()
      peer.close()
    }
  }, 30_000)

  test("registry validation rejection resets the stream and delivers no channel", async () => {
    requireReferenceBinary()

    const identity = await createCcaNoiseIdentity()
    const envID = "env-carrier-2"
    const regID = "reg-carrier-2"
    const streamID = crypto.randomUUID()

    const fakeFetch = async (url: string, _init?: RequestInit): Promise<Response> => {
      if (url.endsWith(`/cloud/environment/${envID}/register`)) {
        return Response.json({
          environment_id: envID,
          security_profile: "noise_hybrid_ik_v1",
          executor_registration_id: regID,
          url: "wss://relay.chatgpt.com/noise",
        })
      }
      if (url.endsWith(`/cloud/environment/${envID}/validate`)) {
        return Response.json({ valid: false })
      }
      throw new Error(`Unexpected registry URL ${url}`)
    }

    const [executorEnd, harnessEnd] = makeSocketPair()
    const collector = new FrameCollector(harnessEnd)
    let channelCount = 0

    const peer = new RustPeerClient()
    const transport = await startCcaExecutorTransport({
      environmentID: envID,
      credential: { accessToken: "synthetic-token", accountID: "synthetic-account" },
      identity,
      fetch: fakeFetch,
      connectWebSocket: async () => executorEnd as unknown as WebSocketLike,
      acceptHandshake: (input) =>
        acceptCcaNoiseHandshake(input as unknown as AcceptCcaNoiseHandshakeInput),
      onChannel: () => {
        channelCount++
      },
    })
    try {
      const startRes = await peer.start(
        identity.publicKey,
        envID,
        regID,
        streamID,
        Buffer.from("synthetic-carrier-authorization", "utf8").toString("hex"),
      )
      expect(startRes.status).toBe("ok")

      harnessEnd.send(
        encodeRelayMessageFrame({
          version: RELAY_MESSAGE_FRAME_VERSION,
          stream_id: streamID,
          body: { kind: "handshake", handshake: { payload: Buffer.from(startRes.request_hex, "hex") } },
        }),
      )

      const frame = await collector.next()
      expect(frame.body?.kind).toBe("reset")
      if (frame.body?.kind === "reset") {
        expect(frame.body.reset.reason).toBe("noise_relay_protocol_error")
      }
      expect(channelCount).toBe(0)
      expect(collector.pendingCount).toBe(0)
    } finally {
      await transport.close()
      peer.close()
    }
  }, 30_000)
})
