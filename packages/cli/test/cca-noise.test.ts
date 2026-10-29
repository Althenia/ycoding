import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import {
  acceptCcaNoiseHandshake,
  buildNoisePrologue,
  createCcaNoiseIdentity,
  NOISE_SUITE,
  type CcaNoiseIdentity,
  type CcaNoisePublicKey,
} from "../src/remote-control/cca-noise"

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

async function completeHandshake(
  peer: RustPeerClient,
  identity: CcaNoiseIdentity,
  payloadHex: string = Buffer.from("token", "utf8").toString("hex"),
  authorize: (key: CcaNoisePublicKey, auth: string) => Promise<void> = async () => {},
) {
  const startRes = await peer.start(identity.publicKey, "env-1", "reg-1", "stream-1", payloadHex)
  expect(startRes.status).toBe("ok")
  const result = await acceptCcaNoiseHandshake({
    identity,
    environmentID: "env-1",
    registrationID: "reg-1",
    streamID: "stream-1",
    request: Buffer.from(startRes.request_hex, "hex"),
    authorize,
  })
  const finishRes = await peer.finish(Buffer.from(result.response).toString("hex"))
  expect(finishRes.status).toBe("ok")
  return { startRes, ...result }
}

describe("cca-noise identity and prologue", () => {
  test("generates identity with exact suite, 32-byte X25519, and 1184-byte ML-KEM-768 public keys", async () => {
    const identity = await createCcaNoiseIdentity()
    expect(identity.publicKey.suite).toBe(NOISE_SUITE)

    const x25519Bytes = Buffer.from(identity.publicKey.x25519_public_key, "base64")
    expect(x25519Bytes.length).toBe(32)

    const mlkemBytes = Buffer.from(identity.publicKey.mlkem768_public_key, "base64")
    expect(mlkemBytes.length).toBe(1184)
  })

  test("builds exact four-part u64-BE length-prefixed prologue", () => {
    const prologue = buildNoisePrologue("env-123", "reg-456", "stream-789")
    const view = new DataView(prologue.buffer, prologue.byteOffset, prologue.byteLength)

    let offset = 0
    const domainLen = Number(view.getBigUint64(offset, false))
    offset += 8
    expect(domainLen).toBe(32)
    const domain = Buffer.from(prologue.subarray(offset, offset + domainLen)).toString("utf8")
    expect(domain).toBe("codex-exec-server-relay-noise/v1")
    offset += domainLen

    const envLen = Number(view.getBigUint64(offset, false))
    offset += 8
    expect(envLen).toBe(7)
    const env = Buffer.from(prologue.subarray(offset, offset + envLen)).toString("utf8")
    expect(env).toBe("env-123")
    offset += envLen

    const regLen = Number(view.getBigUint64(offset, false))
    offset += 8
    expect(regLen).toBe(7)
    const reg = Buffer.from(prologue.subarray(offset, offset + regLen)).toString("utf8")
    expect(reg).toBe("reg-456")
    offset += regLen

    const streamLen = Number(view.getBigUint64(offset, false))
    offset += 8
    expect(streamLen).toBe(10)
    const stream = Buffer.from(prologue.subarray(offset, offset + streamLen)).toString("utf8")
    expect(stream).toBe("stream-789")
    offset += streamLen

    expect(offset).toBe(prologue.length)
  })
})

describe("cca-noise handshake and transport", () => {
  test("rejects malformed, truncated, or oversized handshake requests", async () => {
    const identity = await createCcaNoiseIdentity()
    const authorize = async () => {}

    await expect(
      acceptCcaNoiseHandshake({
        identity,
        environmentID: "env",
        registrationID: "reg",
        streamID: "stream",
        request: new Uint8Array(100),
        authorize,
      }),
    ).rejects.toThrow()

    await expect(
      acceptCcaNoiseHandshake({
        identity,
        environmentID: "env",
        registrationID: "reg",
        streamID: "stream",
        request: new Uint8Array(70000),
        authorize,
      }),
    ).rejects.toThrow()
  })

  test("runs bidirectional exchange with Rust Clatter reference peer", async () => {
    requireReferenceBinary()

    const peer = new RustPeerClient()
    try {
      const identity = await createCcaNoiseIdentity()
      const envId = "env-test-id"
      const regId = "reg-test-id"
      const streamId = "stream-test-uuid"
      const authSecret = "synthetic-harness-key-authorization-token"
      const authHex = Buffer.from(authSecret, "utf8").toString("hex")

      const startRes = await peer.start(identity.publicKey, envId, regId, streamId, authHex)
      expect(startRes.status).toBe("ok")
      expect(startRes.request_hex).toBeDefined()
      expect(startRes.initiator_public_key).toBeDefined()

      let authorizedKey: CcaNoisePublicKey | undefined
      let authorizedToken: string | undefined

      const requestBytes = Buffer.from(startRes.request_hex, "hex")
      const { response, transport } = await acceptCcaNoiseHandshake({
        identity,
        environmentID: envId,
        registrationID: regId,
        streamID: streamId,
        request: requestBytes,
        authorize: async (key, auth) => {
          authorizedKey = key
          authorizedToken = auth
        },
      })

      expect(authorizedToken).toBe(authSecret)
      expect(authorizedKey?.x25519_public_key).toBe(startRes.initiator_public_key.x25519_public_key)
      expect(authorizedKey?.mlkem768_public_key).toBe(startRes.initiator_public_key.mlkem768_public_key)

      const responseHex = Buffer.from(response).toString("hex")
      const finishRes = await peer.finish(responseHex)
      expect(finishRes.status).toBe("ok")

      const rustMsg = "hello from rust harness"
      const rustEnc = await peer.encrypt(Buffer.from(rustMsg, "utf8").toString("hex"))
      expect(rustEnc.status).toBe("ok")

      const bunDecrypted = await transport.decrypt(Buffer.from(rustEnc.ciphertext_hex, "hex"))
      expect(Buffer.from(bunDecrypted).toString("utf8")).toBe(rustMsg)

      const bunMsg = "hello from bun executor"
      const bunEnc = await transport.encrypt(Buffer.from(bunMsg, "utf8"))
      const rustDec = await peer.decrypt(Buffer.from(bunEnc).toString("hex"))
      expect(rustDec.status).toBe("ok")
      expect(Buffer.from(rustDec.plaintext_hex, "hex").toString("utf8")).toBe(bunMsg)

      for (let i = 0; i < 5; i++) {
        const msg = `ping pong ${i}`
        const ct = await transport.encrypt(Buffer.from(msg, "utf8"))
        const dec = await peer.decrypt(Buffer.from(ct).toString("hex"))
        expect(Buffer.from(dec.plaintext_hex, "hex").toString("utf8")).toBe(msg)
      }
    } finally {
      peer.close()
    }
  })

  test("authorization denial produces no response and no transport", async () => {
    requireReferenceBinary()

    const peer = new RustPeerClient()
    try {
      const identity = await createCcaNoiseIdentity()
      const startRes = await peer.start(
        identity.publicKey,
        "env-1",
        "reg-1",
        "stream-1",
        Buffer.from("token", "utf8").toString("hex"),
      )
      expect(startRes.status).toBe("ok")

      const requestBytes = Buffer.from(startRes.request_hex, "hex")
      await expect(
        acceptCcaNoiseHandshake({
          identity,
          environmentID: "env-1",
          registrationID: "reg-1",
          streamID: "stream-1",
          request: requestBytes,
          authorize: async () => {
            throw new Error("Authorization denied")
          },
        }),
      ).rejects.toThrow(/Authorization denied/)
    } finally {
      peer.close()
    }
  })

  test("wrong prologue environment, registration, or stream fails handshake", async () => {
    requireReferenceBinary()

    const peer = new RustPeerClient()
    try {
      const identity = await createCcaNoiseIdentity()
      const startRes = await peer.start(
        identity.publicKey,
        "env-A",
        "reg-A",
        "stream-A",
        Buffer.from("token", "utf8").toString("hex"),
      )
      expect(startRes.status).toBe("ok")

      const requestBytes = Buffer.from(startRes.request_hex, "hex")

      await expect(
        acceptCcaNoiseHandshake({
          identity,
          environmentID: "env-B",
          registrationID: "reg-A",
          streamID: "stream-A",
          request: requestBytes,
          authorize: async () => {},
        }),
      ).rejects.toThrow()

      await expect(
        acceptCcaNoiseHandshake({
          identity,
          environmentID: "env-A",
          registrationID: "reg-B",
          streamID: "stream-A",
          request: requestBytes,
          authorize: async () => {},
        }),
      ).rejects.toThrow()

      await expect(
        acceptCcaNoiseHandshake({
          identity,
          environmentID: "env-A",
          registrationID: "reg-A",
          streamID: "stream-B",
          request: requestBytes,
          authorize: async () => {},
        }),
      ).rejects.toThrow()
    } finally {
      peer.close()
    }
  })

  test("corrupted transport record is rejected and renders transport permanently unusable", async () => {
    requireReferenceBinary()

    const peer = new RustPeerClient()
    try {
      const identity = await createCcaNoiseIdentity()
      const startRes = await peer.start(
        identity.publicKey,
        "env-1",
        "reg-1",
        "stream-1",
        Buffer.from("token", "utf8").toString("hex"),
      )
      const { response, transport } = await acceptCcaNoiseHandshake({
        identity,
        environmentID: "env-1",
        registrationID: "reg-1",
        streamID: "stream-1",
        request: Buffer.from(startRes.request_hex, "hex"),
        authorize: async () => {},
      })
      await peer.finish(Buffer.from(response).toString("hex"))

      const rustEnc = await peer.encrypt(Buffer.from("msg", "utf8").toString("hex"))
      const corruptCt = Buffer.from(rustEnc.ciphertext_hex, "hex")
      corruptCt[0] ^= 0xff

      await expect(transport.decrypt(corruptCt)).rejects.toThrow()

      const validEnc = await peer.encrypt(Buffer.from("msg2", "utf8").toString("hex"))
      await expect(transport.decrypt(Buffer.from(validEnc.ciphertext_hex, "hex"))).rejects.toThrow()
      await expect(transport.encrypt(Buffer.from("after break", "utf8"))).rejects.toThrow()
    } finally {
      peer.close()
    }
  })

  test("serializes concurrent encrypt calls without nonce reuse", async () => {
    requireReferenceBinary()

    const peer = new RustPeerClient()
    try {
      const identity = await createCcaNoiseIdentity()
      const startRes = await peer.start(
        identity.publicKey,
        "env-1",
        "reg-1",
        "stream-1",
        Buffer.from("token", "utf8").toString("hex"),
      )
      const { response, transport } = await acceptCcaNoiseHandshake({
        identity,
        environmentID: "env-1",
        registrationID: "reg-1",
        streamID: "stream-1",
        request: Buffer.from(startRes.request_hex, "hex"),
        authorize: async () => {},
      })
      await peer.finish(Buffer.from(response).toString("hex"))

      const promises = Array.from({ length: 10 }, (_, i) => transport.encrypt(Buffer.from(`concurrent ${i}`, "utf8")))
      const ciphertexts = await Promise.all(promises)

      for (let i = 0; i < ciphertexts.length; i++) {
        const dec = await peer.decrypt(Buffer.from(ciphertexts[i]).toString("hex"))
        expect(dec.status).toBe("ok")
        expect(Buffer.from(dec.plaintext_hex, "hex").toString("utf8")).toBe(`concurrent ${i}`)
      }
    } finally {
      peer.close()
    }
  })

  test("rejects one-byte tampering in each message 1 region before authorize", async () => {
    requireReferenceBinary()

    const peer = new RustPeerClient()
    try {
      const identity = await createCcaNoiseIdentity()
      const regions: Array<{ name: string; offset: (len: number) => number }> = [
        { name: "kem ciphertext", offset: () => 10 },
        { name: "ephemeral dh", offset: () => 1088 + 5 },
        { name: "ephemeral kem", offset: () => 1120 + 5 },
        { name: "encrypted dh static", offset: () => 2304 + 5 },
        { name: "encrypted kem static", offset: () => 2352 + 5 },
        { name: "payload tag", offset: (len) => len - 1 },
      ]
      for (const region of regions) {
        const startRes = await peer.start(
          identity.publicKey,
          "env-1",
          "reg-1",
          "stream-1",
          Buffer.from("token", "utf8").toString("hex"),
        )
        expect(startRes.status).toBe("ok")
        const request = Buffer.from(startRes.request_hex, "hex")
        request[region.offset(request.length)]! ^= 0x01
        let authorizeCalls = 0
        await expect(
          acceptCcaNoiseHandshake({
            identity,
            environmentID: "env-1",
            registrationID: "reg-1",
            streamID: "stream-1",
            request,
            authorize: async () => {
              authorizeCalls++
            },
          }),
        ).rejects.toThrow()
        expect(authorizeCalls).toBe(0)
      }
    } finally {
      peer.close()
    }
  }, 30_000)

  test("calls authorize exactly once on success", async () => {
    requireReferenceBinary()

    const peer = new RustPeerClient()
    try {
      const identity = await createCcaNoiseIdentity()
      let authorizeCalls = 0
      await completeHandshake(peer, identity, undefined, async () => {
        authorizeCalls++
      })
      expect(authorizeCalls).toBe(1)
    } finally {
      peer.close()
    }
  })

  test("rejects oversized and non-UTF-8 authorization payloads before authorize, accepts exactly 4096 bytes", async () => {
    requireReferenceBinary()

    const peer = new RustPeerClient()
    try {
      const identity = await createCcaNoiseIdentity()
      for (const payload of [Buffer.alloc(4097, 0x61), Buffer.from([0xff, 0xfe, 0x61])]) {
        const startRes = await peer.start(
          identity.publicKey,
          "env-1",
          "reg-1",
          "stream-1",
          payload.toString("hex"),
        )
        expect(startRes.status).toBe("ok")
        let authorizeCalls = 0
        await expect(
          acceptCcaNoiseHandshake({
            identity,
            environmentID: "env-1",
            registrationID: "reg-1",
            streamID: "stream-1",
            request: Buffer.from(startRes.request_hex, "hex"),
            authorize: async () => {
              authorizeCalls++
            },
          }),
        ).rejects.toThrow("Noise handshake authorization payload is invalid")
        expect(authorizeCalls).toBe(0)
      }

      const maxPayload = Buffer.alloc(4096, 0x62)
      let seenAuthorization: string | undefined
      await completeHandshake(peer, identity, maxPayload.toString("hex"), async (_key, auth) => {
        seenAuthorization = auth
      })
      expect(seenAuthorization).toBe(maxPayload.toString("utf8"))
    } finally {
      peer.close()
    }
  }, 30_000)

  test("serializes concurrent decrypt calls in record order", async () => {
    requireReferenceBinary()

    const peer = new RustPeerClient()
    try {
      const identity = await createCcaNoiseIdentity()
      const { transport } = await completeHandshake(peer, identity)

      const ciphertexts: Buffer[] = []
      for (let i = 0; i < 10; i++) {
        const enc = await peer.encrypt(Buffer.from(`ordered ${i}`, "utf8").toString("hex"))
        expect(enc.status).toBe("ok")
        ciphertexts.push(Buffer.from(enc.ciphertext_hex, "hex"))
      }
      const plaintexts = await Promise.all(ciphertexts.map((ct) => transport.decrypt(ct)))
      for (let i = 0; i < plaintexts.length; i++) {
        expect(Buffer.from(plaintexts[i]!).toString("utf8")).toBe(`ordered ${i}`)
      }
    } finally {
      peer.close()
    }
  })

  test("exchanges empty and 65519-byte records in both directions", async () => {
    requireReferenceBinary()

    const peer = new RustPeerClient()
    try {
      const identity = await createCcaNoiseIdentity()
      const { transport } = await completeHandshake(peer, identity)

      for (const size of [0, 65519]) {
        const outbound = Buffer.from(Array.from({ length: size }, (_, i) => i % 251))
        const ct = await transport.encrypt(outbound)
        expect(ct.length).toBe(size + 16)
        const dec = await peer.decrypt(Buffer.from(ct).toString("hex"))
        expect(dec.status).toBe("ok")
        expect(Buffer.from(dec.plaintext_hex, "hex").equals(outbound)).toBe(true)

        const inbound = Buffer.from(Array.from({ length: size }, (_, i) => (i * 7) % 251))
        const enc = await peer.encrypt(inbound.toString("hex"))
        expect(enc.status).toBe("ok")
        const pt = await transport.decrypt(Buffer.from(enc.ciphertext_hex, "hex"))
        expect(Buffer.from(pt).equals(inbound)).toBe(true)
      }
    } finally {
      peer.close()
    }
  }, 30_000)

  test("second handshake with the same identity succeeds", async () => {
    requireReferenceBinary()

    const identity = await createCcaNoiseIdentity()
    const peer1 = new RustPeerClient()
    const peer2 = new RustPeerClient()
    try {
      const first = await completeHandshake(peer1, identity)
      const second = await completeHandshake(peer2, identity)

      const ct = await second.transport.encrypt(Buffer.from("second session", "utf8"))
      const dec = await peer2.decrypt(Buffer.from(ct).toString("hex"))
      expect(dec.status).toBe("ok")
      expect(Buffer.from(dec.plaintext_hex, "hex").toString("utf8")).toBe("second session")

      const enc1 = await peer1.encrypt(Buffer.from("first still live", "utf8").toString("hex"))
      const pt1 = await first.transport.decrypt(Buffer.from(enc1.ciphertext_hex, "hex"))
      expect(Buffer.from(pt1).toString("utf8")).toBe("first still live")
    } finally {
      peer1.close()
      peer2.close()
    }
  })
})
