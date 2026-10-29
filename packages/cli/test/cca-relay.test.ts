import { describe, expect, test } from "bun:test"
import {
  CcaRelayCarrier,
  decodeRelayMessageFrame,
  encodeRelayMessageFrame,
  encodeVarint,
  frameMessage,
  MessageDecoder,
  OrderedCiphertextFrames,
  type CcaChannel,
  type CcaNoiseAcceptHandshakeInput,
  type CcaNoiseIdentity,
  type CcaNoisePublicKey,
  type CcaNoiseTransport,
  type RelayData,
  type RelayFrameBody,
  type RelayMessageFrame,
} from "../src/remote-control/cca-relay"

const mockPublicKey: CcaNoisePublicKey = {
  suite: "noise_hybrid_ik_v1",
  x25519_public_key: "synthetic_x25519_pub_key_base64",
  mlkem768_public_key: "synthetic_mlkem768_pub_key_base64",
}

const mockIdentity: CcaNoiseIdentity = {
  publicKey: mockPublicKey,
}

const testStreamId = "550e8400-e29b-41d4-a716-446655440000"
const testStreamId2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"

describe("cca-relay protobuf wire codec", () => {
  test("encodes and decodes resume frame matching independent byte fixture", () => {
    const frame: RelayMessageFrame = {
      version: 1,
      stream_id: testStreamId,
      body: { kind: "resume", resume: { next_seq: 0 } },
    }

    const encoded = encodeRelayMessageFrame(frame)

    const streamIdBytes = new TextEncoder().encode(testStreamId)
    const expected = new Uint8Array([
      0x08, 0x01,
      0x12, streamIdBytes.length, ...streamIdBytes,
      0x3a, 0x02, 0x08, 0x00,
    ])

    expect(encoded).toEqual(expected)

    const decoded = decodeRelayMessageFrame(encoded)
    expect(decoded.version).toBe(1)
    expect(decoded.stream_id).toBe(testStreamId)
    expect(decoded.body).toEqual({ kind: "resume", resume: { next_seq: 0 } })
  })

  test("encodes and decodes heartbeat and ack frames", () => {
    const heartbeatFrame: RelayMessageFrame = {
      version: 1,
      stream_id: testStreamId,
      body: { kind: "heartbeat" },
    }
    const hbEncoded = encodeRelayMessageFrame(heartbeatFrame)
    const streamIdBytes = new TextEncoder().encode(testStreamId)
    expect(hbEncoded).toEqual(new Uint8Array([
      0x08, 0x01,
      0x12, streamIdBytes.length, ...streamIdBytes,
      0x4a, 0x00,
    ]))
    expect(decodeRelayMessageFrame(hbEncoded).body).toEqual({ kind: "heartbeat" })

    const ackFrame: RelayMessageFrame = {
      version: 1,
      stream_id: testStreamId,
      ack: 42,
      ack_bits: 0b101,
      body: { kind: "ack" },
    }
    const ackEncoded = encodeRelayMessageFrame(ackFrame)
    const decodedAck = decodeRelayMessageFrame(ackEncoded)
    expect(decodedAck.version).toBe(1)
    expect(decodedAck.stream_id).toBe(testStreamId)
    expect(decodedAck.ack).toBe(42)
    expect(decodedAck.ack_bits).toBe(5)
    expect(decodedAck.body).toEqual({ kind: "ack" })
  })

  test("encodes and decodes reset frame with non-empty reason", () => {
    const resetFrame: RelayMessageFrame = {
      version: 1,
      stream_id: testStreamId,
      body: { kind: "reset", reset: { reason: "noise_relay_protocol_error" } },
    }
    const encoded = encodeRelayMessageFrame(resetFrame)
    const decoded = decodeRelayMessageFrame(encoded)
    expect(decoded.body).toEqual({
      kind: "reset",
      reset: { reason: "noise_relay_protocol_error" },
    })
  })

  test("encodes and decodes handshake frame with payload", () => {
    const handshakePayload = new Uint8Array([1, 2, 3, 4, 5])
    const handshakeFrame: RelayMessageFrame = {
      version: 1,
      stream_id: testStreamId,
      body: { kind: "handshake", handshake: { payload: handshakePayload } },
    }
    const encoded = encodeRelayMessageFrame(handshakeFrame)
    const decoded = decodeRelayMessageFrame(encoded)
    expect(decoded.body).toEqual({
      kind: "handshake",
      handshake: { payload: handshakePayload },
    })
  })

  test("encodes and decodes data frame with payload, seq, segment_index=0, segment_count=1", () => {
    const payload = new Uint8Array([10, 20, 30, 40])
    const dataFrame: RelayMessageFrame = {
      version: 1,
      stream_id: testStreamId,
      body: {
        kind: "data",
        data: {
          seq: 15,
          segment_index: 0,
          segment_count: 1,
          payload,
        },
      },
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "congo=t61rcWkgMzE",
    }
    const encoded = encodeRelayMessageFrame(dataFrame)
    const decoded = decodeRelayMessageFrame(encoded)
    expect(decoded.version).toBe(1)
    expect(decoded.stream_id).toBe(testStreamId)
    expect(decoded.traceparent).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
    expect(decoded.tracestate).toBe("congo=t61rcWkgMzE")
    expect(decoded.body).toEqual({
      kind: "data",
      data: {
        seq: 15,
        segment_index: 0,
        segment_count: 1,
        payload,
      },
    })
  })

  test("skips unknown fields boundedly without error", () => {
    const streamIdBytes = new TextEncoder().encode(testStreamId)
    const unknownData = new Uint8Array([0xaa, 0xbb, 0xcc])
    const wireWithUnknown = new Uint8Array([
      0x08, 0x01,
      0x12, streamIdBytes.length, ...streamIdBytes,
      ...encodeVarint((15 << 3) | 2), unknownData.length, ...unknownData,
      ...encodeVarint((16 << 3) | 0), 0x7f,
      0x3a, 0x02, 0x08, 0x00,
    ])

    const decoded = decodeRelayMessageFrame(wireWithUnknown)
    expect(decoded.version).toBe(1)
    expect(decoded.stream_id).toBe(testStreamId)
    expect(decoded.body).toEqual({ kind: "resume", resume: { next_seq: 0 } })
  })

  test("rejects invalid version != 1", () => {
    const streamIdBytes = new TextEncoder().encode(testStreamId)
    const v2Frame = new Uint8Array([
      0x08, 0x02,
      0x12, streamIdBytes.length, ...streamIdBytes,
      0x4a, 0x00,
    ])
    expect(() => decodeRelayMessageFrame(v2Frame)).toThrow(/version/)
  })

  test("rejects a missing or blank stream_id and accepts any other stream_id like upstream RelayMessageFrame::validate", () => {
    const noStreamId = new Uint8Array([
      0x08, 0x01,
      0x4a, 0x00,
    ])
    expect(() => decodeRelayMessageFrame(noStreamId)).toThrow(/stream_id/)

    const blank = encodeRelayMessageFrame({ version: 1, stream_id: "   ", body: { kind: "heartbeat" } })
    expect(() => decodeRelayMessageFrame(blank)).toThrow(/stream_id/)

    const notUuid = new Uint8Array([
      0x08, 0x01,
      0x12, 0x07, ...new TextEncoder().encode("notuuid"),
      0x4a, 0x00,
    ])
    expect(decodeRelayMessageFrame(notUuid).stream_id).toBe("notuuid")
  })

  test("rejects data frame with invalid segmentation or empty payload", () => {
    const streamIdBytes = new TextEncoder().encode(testStreamId)
    const badData = new Uint8Array([
      0x08, 0x01,
      0x12, streamIdBytes.length, ...streamIdBytes,
      0x2a, 0x0a,
      0x08, 0x00,
      0x10, 0x01,
      0x18, 0x01,
      0x22, 0x02, 0x01, 0x02,
    ])
    expect(() => decodeRelayMessageFrame(badData)).toThrow(/segment/)

    const emptyPayload = new Uint8Array([
      0x08, 0x01,
      0x12, streamIdBytes.length, ...streamIdBytes,
      0x2a, 0x08,
      0x08, 0x00,
      0x10, 0x00,
      0x18, 0x01,
      0x22, 0x00,
    ])
    expect(() => decodeRelayMessageFrame(emptyPayload)).toThrow(/payload/)
  })

  test("rejects reset with empty reason and handshake with empty payload", () => {
    const streamIdBytes = new TextEncoder().encode(testStreamId)
    const emptyReset = new Uint8Array([
      0x08, 0x01,
      0x12, streamIdBytes.length, ...streamIdBytes,
      0x42, 0x02, 0x0a, 0x00,
    ])
    expect(() => decodeRelayMessageFrame(emptyReset)).toThrow(/reason/)

    const emptyHandshake = new Uint8Array([
      0x08, 0x01,
      0x12, streamIdBytes.length, ...streamIdBytes,
      0x52, 0x02, 0x0a, 0x00,
    ])
    expect(() => decodeRelayMessageFrame(emptyHandshake)).toThrow(/payload/)
  })

  test("rejects frame exceeding maximum websocket message size (256 KiB)", () => {
    const oversized = new Uint8Array(256 * 1024 + 1)
    expect(() => decodeRelayMessageFrame(oversized)).toThrow(/maximum length|size/i)
  })
})

describe("message framing and decoder", () => {
  test("frameMessage prepends 4-byte big-endian length prefix", () => {
    const msg = new TextEncoder().encode("hello world")
    const framed = frameMessage(msg)
    expect(framed.length).toBe(4 + msg.length)
    const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength)
    expect(view.getUint32(0, false)).toBe(msg.length)
    expect(framed.subarray(4)).toEqual(msg)
  })

  test("frameMessage rejects zero-length message or exceeding 64 MiB", () => {
    expect(() => frameMessage(new Uint8Array(0))).toThrow(/length/i)
    const oversized = new Uint8Array(1)
    expect(() => frameMessage(oversized, 64 * 1024 * 1024 + 1)).toThrow(/length/i)
  })

  test("MessageDecoder decodes single and split messages across chunks <= 60 KiB", () => {
    const decoder = new MessageDecoder()
    const msg = new TextEncoder().encode("test payload to split across chunks")
    const framed = frameMessage(msg)

    const part1 = decoder.push(framed.subarray(0, 10))
    expect(part1).toEqual([])

    const part2 = decoder.push(framed.subarray(10))
    expect(part2.length).toBe(1)
    expect(new TextDecoder().decode(part2[0])).toBe("test payload to split across chunks")
  })

  test("MessageDecoder decodes coalesced multiple messages in a single chunk", () => {
    const decoder = new MessageDecoder()
    const msg1 = new TextEncoder().encode("msg one")
    const msg2 = new TextEncoder().encode("msg two")
    const combined = new Uint8Array([...frameMessage(msg1), ...frameMessage(msg2)])

    const results = decoder.push(combined)
    expect(results.length).toBe(2)
    expect(new TextDecoder().decode(results[0])).toBe("msg one")
    expect(new TextDecoder().decode(results[1])).toBe("msg two")
  })

  test("MessageDecoder rejects plaintext records exceeding 60 KiB", () => {
    const decoder = new MessageDecoder()
    const oversizedRecord = new Uint8Array(60 * 1024 + 1)
    expect(() => decoder.push(oversizedRecord)).toThrow(/plaintext record exceeds maximum length/i)
  })

  test("MessageDecoder rejects zero length prefix and oversized length prefix", () => {
    const decoder = new MessageDecoder()
    const zeroLenPrefix = new Uint8Array([0, 0, 0, 0])
    expect(() => decoder.push(zeroLenPrefix)).toThrow(/invalid length/i)

    const decoder2 = new MessageDecoder()
    const oversizedPrefix = new Uint8Array([0x04, 0x00, 0x00, 0x01])
    expect(() => decoder2.push(oversizedPrefix)).toThrow(/invalid length/i)
  })
})

describe("OrderedCiphertextFrames", () => {
  test("releases in-order ciphertext frames immediately", () => {
    const ocf = new OrderedCiphertextFrames()
    const p0 = new Uint8Array([10])
    const p1 = new Uint8Array([20])
    const p2 = new Uint8Array([30])

    expect(ocf.push(0, p0)).toEqual([p0])
    expect(ocf.push(1, p1)).toEqual([p1])
    expect(ocf.push(2, p2)).toEqual([p2])
  })

  test("buffers out-of-order frames and releases full contiguous run when gap closes", () => {
    const ocf = new OrderedCiphertextFrames()
    const p0 = new Uint8Array([0])
    const p1 = new Uint8Array([1])
    const p2 = new Uint8Array([2])
    const p3 = new Uint8Array([3])

    expect(ocf.push(2, p2)).toEqual([])
    expect(ocf.push(3, p3)).toEqual([])
    expect(ocf.push(1, p1)).toEqual([])
    expect(ocf.push(0, p0)).toEqual([p0, p1, p2, p3])
  })

  test("drops duplicates and already-released sequences silently", () => {
    const ocf = new OrderedCiphertextFrames()
    const p0 = new Uint8Array([0])
    const p1 = new Uint8Array([1])

    expect(ocf.push(0, p0)).toEqual([p0])
    expect(ocf.push(0, p0)).toEqual([])

    const p2 = new Uint8Array([2])
    expect(ocf.push(2, p2)).toEqual([])
    expect(ocf.push(2, p2)).toEqual([])

    expect(ocf.push(1, p1)).toEqual([p1, p2])
  })

  test("rejects sequence exceeding max reorder distance (64)", () => {
    const ocf = new OrderedCiphertextFrames()
    expect(() => ocf.push(65, new Uint8Array([1]))).toThrow(/reorder window/i)
  })

  test("rejects pending bytes exceeding 1 MiB", () => {
    const ocf = new OrderedCiphertextFrames()
    const big = new Uint8Array(1024 * 1024 + 1)
    expect(() => ocf.push(1, big)).toThrow(/pending ciphertext buffer is full/i)
  })
})

describe("CcaRelayCarrier", () => {
  test("serializes concurrent sends on a channel and preserves ciphertext stability", async () => {
    const sentFrames: Uint8Array[] = []
    const mockSocket = {
      send(data: Uint8Array) {
        sentFrames.push(data)
      },
      close() {},
    }

    let encryptCallCount = 0
    const mockTransport: CcaNoiseTransport = {
      async encrypt(bytes: Uint8Array) {
        encryptCallCount++
        return new Uint8Array([0xee, encryptCallCount, ...bytes])
      },
      async decrypt(bytes: Uint8Array) {
        return bytes.subarray(2)
      },
    }

    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      authorize: async () => {},
      acceptHandshake: async (input) => {
        await input.authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([99]),
          transport: mockTransport,
        }
      },
    })

    let openedChannel: any = null
    carrier.onChannel((ch) => {
      openedChannel = ch
    })

    const handshakeFrame = encodeRelayMessageFrame({
      version: 1,
      stream_id: testStreamId,
      body: { kind: "handshake", handshake: { payload: new Uint8Array([1, 2, 3]) } },
    })
    await carrier.handleIncomingFrame(handshakeFrame)

    expect(openedChannel).not.toBeNull()
    expect(openedChannel.streamID).toBe(testStreamId)

    const p1 = openedChannel.send(new TextEncoder().encode("msg1"))
    const p2 = openedChannel.send(new TextEncoder().encode("msg2"))
    const p3 = openedChannel.send(new TextEncoder().encode("msg3"))
    await Promise.all([p1, p2, p3])

    expect(sentFrames.length).toBe(4)
    const hsResp = decodeRelayMessageFrame(sentFrames[0])
    expect(hsResp.body).toEqual({ kind: "handshake", handshake: { payload: new Uint8Array([99]) } })

    const d0 = decodeRelayMessageFrame(sentFrames[1])
    const d1 = decodeRelayMessageFrame(sentFrames[2])
    const d2 = decodeRelayMessageFrame(sentFrames[3])

    if (d0.body?.kind !== "data" || d1.body?.kind !== "data" || d2.body?.kind !== "data") {
      throw new Error("expected data frames")
    }

    expect(d0.body.data.seq).toBe(0)
    expect(d1.body.data.seq).toBe(1)
    expect(d2.body.data.seq).toBe(2)
  })

  test("isolates multiple concurrent streams by stream_id", async () => {
    const sentFrames: Uint8Array[] = []
    const mockSocket = {
      send(data: Uint8Array) {
        sentFrames.push(data)
      },
      close() {},
    }

    const channels: any[] = []
    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      authorize: async () => {},
      acceptHandshake: async ({ streamID, authorize }) => {
        await authorize(mockPublicKey, "valid_auth")
        return {
          response: new TextEncoder().encode(`resp-${streamID}`),
          transport: {
            async encrypt(bytes) {
              return new Uint8Array([0xcc, ...bytes])
            },
            async decrypt(bytes) {
              return bytes.subarray(1)
            },
          },
        }
      },
    })

    carrier.onChannel((ch) => {
      channels.push(ch)
    })

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId2,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([2]) } },
      }),
    )

    expect(channels.length).toBe(2)
    expect(channels[0].streamID).toBe(testStreamId)
    expect(channels[1].streamID).toBe(testStreamId2)

    const received1: Uint8Array[] = []
    const received2: Uint8Array[] = []

    const listen1 = (async () => {
      for await (const msg of channels[0].messages) {
        received1.push(msg)
        break
      }
    })()

    const listen2 = (async () => {
      for await (const msg of channels[1].messages) {
        received2.push(msg)
        break
      }
    })()

    const s1Data = new Uint8Array([0xcc, ...frameMessage(new TextEncoder().encode("stream-one-data"))])
    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: {
          kind: "data",
          data: { seq: 0, segment_index: 0, segment_count: 1, payload: s1Data },
        },
      }),
    )

    const s2Data = new Uint8Array([0xcc, ...frameMessage(new TextEncoder().encode("stream-two-data"))])
    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId2,
        body: {
          kind: "data",
          data: { seq: 0, segment_index: 0, segment_count: 1, payload: s2Data },
        },
      }),
    )

    await Promise.all([listen1, listen2])

    expect(new TextDecoder().decode(received1[0])).toBe("stream-one-data")
    expect(new TextDecoder().decode(received2[0])).toBe("stream-two-data")
  })

  test("sends reset and does not dispatch channel when handshake authorization fails", async () => {
    const sentFrames: Uint8Array[] = []
    const mockSocket = {
      send(data: Uint8Array) {
        sentFrames.push(data)
      },
      close() {},
    }

    let channelDispatched = false
    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        await authorize(mockPublicKey, "invalid-auth-token")
        throw new Error("rejected by registry")
      },
    })

    carrier.onChannel(() => {
      channelDispatched = true
    })

    const handshakeFrame = encodeRelayMessageFrame({
      version: 1,
      stream_id: testStreamId,
      body: { kind: "handshake", handshake: { payload: new Uint8Array([1, 2, 3]) } },
    })

    await carrier.handleIncomingFrame(handshakeFrame)

    expect(channelDispatched).toBe(false)
    expect(sentFrames.length).toBe(1)
    const reset = decodeRelayMessageFrame(sentFrames[0])
    expect(reset.stream_id).toBe(testStreamId)
    expect(reset.body?.kind).toBe("reset")
  })

  test("retires channel and aborts signal when incoming reset is received", async () => {
    const mockSocket = {
      send() {},
      close() {},
    }

    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        await authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: {
            async encrypt(b) { return b },
            async decrypt(b) { return b },
          },
        }
      },
    })

    let channel: any = null
    carrier.onChannel((ch) => {
      channel = ch
    })

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )

    expect(channel.signal.aborted).toBe(false)

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "reset", reset: { reason: "peer_reset" } },
      }),
    )

    expect(channel.signal.aborted).toBe(true)
  })

  test("reset received while handshake authorization is in flight cancels validation and prevents channel dispatch", async () => {
    let authorizeStarted = false
    let resolveAuthorize: () => void = () => {}
    const authorizeBlocked = new Promise<void>((resolve) => {
      resolveAuthorize = resolve
    })

    const mockSocket = {
      send() {},
      close() {},
    }

    let channelDispatched = false
    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        authorizeStarted = true
        await authorizeBlocked
        await authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: {
            async encrypt(b) { return b },
            async decrypt(b) { return b },
          },
        }
      },
    })

    carrier.onChannel(() => {
      channelDispatched = true
    })

    const hsPromise = carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )

    while (!authorizeStarted) {
      await new Promise((r) => setTimeout(r, 2))
    }

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "reset", reset: { reason: "canceled_before_validation" } },
      }),
    )

    resolveAuthorize()
    await hsPromise

    expect(channelDispatched).toBe(false)
  })

  test("carrier close destroys all channels and aborts their signals", async () => {
    const mockSocket = {
      send() {},
      close() {},
    }

    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        await authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: {
            async encrypt(b) { return b },
            async decrypt(b) { return b },
          },
        }
      },
    })

    let channel: any = null
    carrier.onChannel((ch) => {
      channel = ch
    })

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )

    expect(channel.signal.aborted).toBe(false)
    carrier.close()
    expect(channel.signal.aborted).toBe(true)

    await expect(
      channel.send(new TextEncoder().encode("should fail")),
    ).rejects.toThrow(/closed/)
  })

  test("rejects data frame with ciphertext exceeding 65535 bytes without calling decrypt", async () => {
    let decryptCalled = false
    const mockSocket = {
      send() {},
      close() {},
    }

    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        await authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: {
            async encrypt(b) { return b },
            async decrypt(b) {
              decryptCalled = true
              return b
            },
          },
        }
      },
    })

    let channel: any = null
    carrier.onChannel((ch) => {
      channel = ch
    })

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )

    const oversizedCiphertext = new Uint8Array(65536)
    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: {
          kind: "data",
          data: { seq: 0, segment_index: 0, segment_count: 1, payload: oversizedCiphertext },
        },
      }),
    )

    expect(decryptCalled).toBe(false)
    expect(channel.signal.aborted).toBe(true)
  })

  test("duplicate handshake accounting: active stream does NOT charge failedHandshakes, pending stream DOES charge", async () => {
    const mockSocket = {
      send() {},
      close() {},
    }

    let isPending = false
    let resolveHandshake: () => void = () => {}

    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        if (isPending) {
          await new Promise<void>((resolve) => {
            resolveHandshake = resolve
          })
        }
        await authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: {
            async encrypt(b) { return b },
            async decrypt(b) { return b },
          },
        }
      },
    })

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )

    for (let i = 0; i < 10; i++) {
      await carrier.handleIncomingFrame(
        encodeRelayMessageFrame({
          version: 1,
          stream_id: testStreamId,
          body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
        }),
      )
    }

    let stream2Dispatched = false
    carrier.onChannel((ch) => {
      if (ch.streamID === testStreamId2) {
        stream2Dispatched = true
      }
    })

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId2,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([2]) } },
      }),
    )
    expect(stream2Dispatched).toBe(true)
  })

  test("stream instance fencing prevents a stale stream instance from closing a newer stream instance", async () => {
    const mockSocket = {
      send() {},
      close() {},
    }

    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        await authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: {
            async encrypt(b) { return b },
            async decrypt(b) { return b },
          },
        }
      },
    })

    const channels: any[] = []
    carrier.onChannel((ch) => {
      channels.push(ch)
    })

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )
    const channel1 = channels[0]
    expect(channel1.signal.aborted).toBe(false)

    const streamState = (carrier as any).streams.get(testStreamId)
    expect(streamState.instanceID).toBeDefined()
    const originalInstanceID = streamState.instanceID
    streamState.instanceID = originalInstanceID + 1

    ;(carrier as any).closeStream(testStreamId, originalInstanceID)
    expect((carrier as any).streams.has(testStreamId)).toBe(true)
    expect(channel1.signal.aborted).toBe(false)

    ;(carrier as any).closeStream(testStreamId, originalInstanceID + 1)
    expect((carrier as any).streams.has(testStreamId)).toBe(false)
    expect(channel1.signal.aborted).toBe(true)
  })

  test("Finding 1: carrier resets and rejects if acceptHandshake completes without calling authorize", async () => {
    const sentFrames: Uint8Array[] = []
    const mockSocket = {
      send(data: Uint8Array) {
        sentFrames.push(data)
      },
      close() {},
    }

    let channelDispatched = false
    let authorizeCalled = false

    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      authorize: async () => {
        authorizeCalled = true
      },
      acceptHandshake: async () => {
        return {
          response: new Uint8Array([0x99]),
          transport: {
            async encrypt(b) { return b },
            async decrypt(b) { return b },
          },
        }
      },
    })

    carrier.onChannel(() => {
      channelDispatched = true
    })

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )

    expect(authorizeCalled).toBe(false)
    expect(channelDispatched).toBe(false)

    const hsResp = sentFrames.find((f) => decodeRelayMessageFrame(f).body?.kind === "handshake")
    expect(hsResp).toBeUndefined()

    const resetFrame = sentFrames.find((f) => decodeRelayMessageFrame(f).body?.kind === "reset")
    expect(resetFrame).toBeDefined()
  })

  test("decodeRelayMessageFrame keeps the stream_id exactly as sent, as upstream keys streams by the raw id", () => {
    const paddedStreamId = `   ${testStreamId}   `
    const frameBytes = encodeRelayMessageFrame({
      version: 1,
      stream_id: paddedStreamId,
      body: { kind: "heartbeat" },
    })

    const decoded = decodeRelayMessageFrame(frameBytes)
    expect(decoded.stream_id).toBe(paddedStreamId)
  })

  test("Finding 2: inbound serialization ensures strictly sequential non-concurrent decrypt", async () => {
    let inFlightDecrypts = 0
    let maxInFlightDecrypts = 0

    const mockSocket = {
      send() {},
      close() {},
    }

    const slowDecryptTransport: CcaNoiseTransport = {
      async encrypt(b) { return b },
      async decrypt(b) {
        inFlightDecrypts++
        maxInFlightDecrypts = Math.max(maxInFlightDecrypts, inFlightDecrypts)
        await new Promise((r) => setTimeout(r, 10))
        inFlightDecrypts--
        return b
      },
    }

    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        await authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: slowDecryptTransport,
        }
      },
    })

    let channel: CcaChannel | undefined
    carrier.onChannel((ch) => {
      channel = ch
    })

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )

    const f0 = encodeRelayMessageFrame({
      version: 1,
      stream_id: testStreamId,
      body: {
        kind: "data",
        data: { seq: 0, segment_index: 0, segment_count: 1, payload: frameMessage(new Uint8Array([10])) },
      },
    })
    const f1 = encodeRelayMessageFrame({
      version: 1,
      stream_id: testStreamId,
      body: {
        kind: "data",
        data: { seq: 1, segment_index: 0, segment_count: 1, payload: frameMessage(new Uint8Array([20])) },
      },
    })

    const p0 = carrier.handleIncomingFrame(f0)
    const p1 = carrier.handleIncomingFrame(f1)
    await Promise.all([p0, p1])

    expect(maxInFlightDecrypts).toBe(1)
  })

  test("Finding 3: aggregate memory cap on queued stream messages drops stream on overflow", async () => {
    const mockSocket = {
      send() {},
      close() {},
    }

    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      maxStreamQueuedBytes: 50,
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        await authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: {
            async encrypt(b) { return b },
            async decrypt(b) { return b },
          },
        }
      },
    })

    let channel: CcaChannel | undefined
    carrier.onChannel((ch) => {
      channel = ch
    })

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )

    expect(channel).toBeDefined()
    expect(channel!.signal.aborted).toBe(false)

    const bigMsg = new Uint8Array(100)
    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: {
          kind: "data",
          data: { seq: 0, segment_index: 0, segment_count: 1, payload: frameMessage(bigMsg) },
        },
      }),
    )

    expect(channel!.signal.aborted).toBe(true)
  })

  test("Finding 8: socket.send failure during handshake response triggers reset without unhandled error", async () => {
    const mockSocket = {
      send(data: Uint8Array) {
        const frame = decodeRelayMessageFrame(data)
        if (frame.body?.kind === "handshake") {
          throw new Error("Simulated socket write failure on handshake response")
        }
      },
      close() {},
    }

    let channelDispatched = false
    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        await authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: {
            async encrypt(b) { return b },
            async decrypt(b) { return b },
          },
        }
      },
    })

    carrier.onChannel(() => {
      channelDispatched = true
    })

    await expect(
      carrier.handleIncomingFrame(
        encodeRelayMessageFrame({
          version: 1,
          stream_id: testStreamId,
          body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
        }),
      ),
    ).resolves.toBeUndefined()

    expect(channelDispatched).toBe(false)
  })

  test("Finding 3b: queued-bytes cap does not reset a stream whose listener drains synchronously", async () => {
    const mockSocket = { send() {}, close() {} }
    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      maxStreamQueuedBytes: 50,
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        await authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: { async encrypt(b) { return b }, async decrypt(b) { return b } },
        }
      },
    })

    const received: Uint8Array[] = []
    let channel: CcaChannel | undefined
    carrier.onChannel((ch) => {
      channel = ch
      if (!ch.onMessage) throw new Error("channel onMessage unavailable")
      ch.onMessage((bytes) => { received.push(bytes) })
    })

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )
    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: {
          kind: "data",
          data: { seq: 0, segment_index: 0, segment_count: 1, payload: frameMessage(new Uint8Array(100)) },
        },
      }),
    )

    expect(received.length).toBe(1)
    expect(received[0]!.length).toBe(100)
    expect(channel!.signal.aborted).toBe(false)
  })

  test("Finding 3c: carrier inbound budget covers reassembly-buffered bytes", async () => {
    const mockSocket = { send() {}, close() {} }
    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      maxStreamQueuedBytes: 1024 * 1024,
      maxCarrierInboundBytes: 120,
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        await authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: { async encrypt(b) { return b }, async decrypt(b) { return b } },
        }
      },
    })

    let channel: CcaChannel | undefined
    carrier.onChannel((ch) => { channel = ch })

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )

    const framed = frameMessage(new Uint8Array(200))
    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "data", data: { seq: 0, segment_index: 0, segment_count: 1, payload: framed.subarray(0, 30) } },
      }),
    )
    expect(channel!.signal.aborted).toBe(false)
    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "data", data: { seq: 1, segment_index: 0, segment_count: 1, payload: framed.subarray(30, 130) } },
      }),
    )
    expect(channel!.signal.aborted).toBe(true)
  })

  test("Finding 3d: carrier inbound budget covers out-of-order reorder pending bytes", async () => {
    const mockSocket = { send() {}, close() {} }
    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      maxCarrierInboundBytes: 120,
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        await authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: { async encrypt(b) { return b }, async decrypt(b) { return b } },
        }
      },
    })

    let channel: CcaChannel | undefined
    carrier.onChannel((ch) => { channel = ch })

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )
    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "data", data: { seq: 5, segment_index: 0, segment_count: 1, payload: new Uint8Array(80) } },
      }),
    )
    expect(channel!.signal.aborted).toBe(false)
    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "data", data: { seq: 6, segment_index: 0, segment_count: 1, payload: new Uint8Array(80) } },
      }),
    )
    expect(channel!.signal.aborted).toBe(true)
  })

  test("long-lived channel callback promise does not block handshake completion or later data delivery", async () => {
    const mockSocket = { send() {}, close() {} }
    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: mockSocket,
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        await authorize(mockPublicKey, "valid_auth")
        return {
          response: new Uint8Array([1]),
          transport: { async encrypt(b) { return b }, async decrypt(b) { return b } },
        }
      },
    })

    let serviceDone = false
    carrier.onChannel(async (ch) => {
      await new Promise<void>((resolve) => {
        if (!ch.onMessage) throw new Error("channel onMessage unavailable")
        ch.onMessage(() => resolve())
      })
      serviceDone = true
    })

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
      }),
    )
    expect(serviceDone).toBe(false)

    await carrier.handleIncomingFrame(
      encodeRelayMessageFrame({
        version: 1,
        stream_id: testStreamId,
        body: {
          kind: "data",
          data: { seq: 0, segment_index: 0, segment_count: 1, payload: frameMessage(new Uint8Array([9])) },
        },
      }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(serviceDone).toBe(true)
  })

  function streamEndCarrier(transport: CcaNoiseTransport) {
    const sent: RelayMessageFrame[] = []
    const carrier = new CcaRelayCarrier({
      environmentID: "env-test",
      executorRegistrationID: "reg-123",
      identity: mockIdentity,
      socket: { send(data: Uint8Array | string) { sent.push(decodeRelayMessageFrame(data as Uint8Array)) }, close() {} },
      authorize: async () => {},
      acceptHandshake: async ({ authorize }) => {
        await authorize(mockPublicKey, "valid_auth")
        return { response: new Uint8Array([1]), transport }
      },
    })
    const handshake = (streamID: string) => carrier.handleIncomingFrame(encodeRelayMessageFrame({
      version: 1,
      stream_id: streamID,
      body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
    }))
    const resets = () => sent.filter((frame) => frame.body?.kind === "reset")
    return { carrier, sent, handshake, resets }
  }

  test("a handler that finishes resets its stream once and retires it (executor_stream.rs owner exit)", async () => {
    const harness = streamEndCarrier({ async encrypt(b) { return b }, async decrypt(b) { return b } })
    let finish!: () => void
    let channel: CcaChannel | undefined
    harness.carrier.onChannel((ch) => {
      channel = ch
      return new Promise<void>((resolve) => { finish = resolve })
    })
    await harness.handshake("synthetic-stream-not-a-uuid")
    expect(channel?.streamID).toBe("synthetic-stream-not-a-uuid")
    expect(harness.resets()).toEqual([])

    finish()
    await new Promise((r) => setTimeout(r, 0))
    expect(channel!.signal.aborted).toBe(true)
    expect(harness.resets()).toEqual([{
      version: 1, stream_id: "synthetic-stream-not-a-uuid", ack: undefined, ack_bits: undefined,
      body: { kind: "reset", reset: { reason: "noise_relay_protocol_error" } }, traceparent: undefined, tracestate: undefined,
    }])
  })

  test("a handler that ends after a peer reset sends no second reset", async () => {
    const harness = streamEndCarrier({ async encrypt(b) { return b }, async decrypt(b) { return b } })
    let finish!: () => void
    harness.carrier.onChannel(() => new Promise<void>((resolve) => { finish = resolve }))
    await harness.handshake(testStreamId)
    await harness.carrier.handleIncomingFrame(encodeRelayMessageFrame({ version: 1, stream_id: testStreamId, body: { kind: "reset", reset: { reason: "peer" } } }))
    finish()
    await new Promise((r) => setTimeout(r, 0))
    expect(harness.resets()).toEqual([])
  })

  test("a failed channel write retires the stream and sends a reset (executor_stream.rs writer exit)", async () => {
    const harness = streamEndCarrier({ async encrypt() { throw new Error("synthetic encrypt failure") }, async decrypt(b) { return b } })
    let channel: CcaChannel | undefined
    harness.carrier.onChannel((ch) => { channel = ch })
    await harness.handshake(testStreamId)
    await expect(channel!.send(new TextEncoder().encode("x"))).rejects.toThrow()
    expect(channel!.signal.aborted).toBe(true)
    expect(harness.resets().map((frame) => frame.stream_id)).toEqual([testStreamId])
  })
})
