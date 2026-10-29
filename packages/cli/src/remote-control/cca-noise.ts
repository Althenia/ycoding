import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  webcrypto,
  type KeyObject,
} from "node:crypto"

export const NOISE_SUITE = "Noise_hybridIK_X25519+MLKEM768_AESGCM_SHA256"
export const NOISE_PROTOCOL_NAME = "Noise_hybridIK_25519+MLKEM768_AESGCM_SHA256"
export const PROLOGUE_DOMAIN = "codex-exec-server-relay-noise/v1"
export const MAX_NOISE_MESSAGE_LEN = 65535
export const MAX_SEND_PLAINTEXT_LEN = 65519
export const TAG_LEN = 16

const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex")

export type CcaNoisePublicKey = {
  readonly suite: string
  readonly x25519_public_key: string
  readonly mlkem768_public_key: string
}

export type CcaNoiseIdentity = {
  readonly publicKey: CcaNoisePublicKey
  readonly _private: {
    readonly x25519Private: KeyObject
    readonly x25519PublicRaw: Uint8Array
    readonly mlkemPrivate: webcrypto.CryptoKey
    readonly mlkemPublicRaw: Uint8Array
  }
}

export type CcaNoiseTransport = {
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>
}

export type AcceptCcaNoiseHandshakeInput = {
  readonly identity: CcaNoiseIdentity
  readonly environmentID: string
  readonly registrationID: string
  readonly streamID: string
  readonly request: Uint8Array
  readonly authorize: (publicKey: CcaNoisePublicKey, authorization: string) => Promise<void>
}

function sha256(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest()
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return createHmac("sha256", key).update(data).digest()
}

function hkdf2(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmacSha256(chainingKey, ikm)
  const out1 = hmacSha256(tempKey, Buffer.from([1]))
  const out2 = hmacSha256(tempKey, Buffer.concat([out1, Buffer.from([2])]))
  return [out1, out2]
}

function hkdf3(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
  const tempKey = hmacSha256(chainingKey, ikm)
  const out1 = hmacSha256(tempKey, Buffer.from([1]))
  const out2 = hmacSha256(tempKey, Buffer.concat([out1, Buffer.from([2])]))
  const out3 = hmacSha256(tempKey, Buffer.concat([out2, Buffer.from([3])]))
  return [out1, out2, out3]
}

function buildNonce(n: bigint): Buffer {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64BE(n, 4)
  return nonce
}

function aesGcmEncrypt(key: Uint8Array, nonce: bigint, ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const iv = buildNonce(nonce)
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN })
  if (ad.length > 0) {
    cipher.setAAD(ad)
  }
  const encrypted = cipher.update(plaintext)
  const final = cipher.final()
  const tag = cipher.getAuthTag()
  return Buffer.concat([encrypted, final, tag])
}

function aesGcmDecrypt(key: Uint8Array, nonce: bigint, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (ciphertext.length < TAG_LEN) {
    throw new Error("Ciphertext too short")
  }
  const iv = buildNonce(nonce)
  const data = ciphertext.subarray(0, ciphertext.length - TAG_LEN)
  const tag = ciphertext.subarray(ciphertext.length - TAG_LEN)
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN })
  if (ad.length > 0) {
    decipher.setAAD(ad)
  }
  decipher.setAuthTag(tag)
  const decrypted = decipher.update(data)
  const final = decipher.final()
  return Buffer.concat([decrypted, final])
}

function importX25519PublicKey(raw32: Uint8Array): KeyObject {
  if (raw32.length !== 32) {
    throw new Error("Invalid X25519 public key length")
  }
  const spki = Buffer.concat([SPKI_X25519_PREFIX, raw32])
  return createPublicKey({ key: spki, format: "der", type: "spki" })
}

function exportX25519PublicKey(key: KeyObject): Uint8Array {
  const der = key.export({ format: "der", type: "spki" })
  return der.subarray(der.length - 32)
}

async function importMlKem768PublicKey(raw1184: Uint8Array): Promise<webcrypto.CryptoKey> {
  if (raw1184.length !== 1184) {
    throw new Error("Invalid ML-KEM-768 public key length")
  }
  return await webcrypto.subtle.importKey("raw-public", raw1184, { name: "ML-KEM-768" }, false, ["encapsulateBits"])
}

async function exportMlKem768PublicKey(key: webcrypto.CryptoKey): Promise<Uint8Array> {
  const raw = await webcrypto.subtle.exportKey("raw-public", key)
  return new Uint8Array(raw)
}

function isCryptoKeyPair(
  value: webcrypto.CryptoKey | webcrypto.CryptoKeyPair,
): value is webcrypto.CryptoKeyPair {
  return "publicKey" in value && "privateKey" in value
}

async function generateMlKem768KeyPair(): Promise<webcrypto.CryptoKeyPair> {
  const generated = await webcrypto.subtle.generateKey({ name: "ML-KEM-768" }, false, [
    "encapsulateBits",
    "decapsulateBits",
  ])
  if (!isCryptoKeyPair(generated)) {
    throw new Error("ML-KEM-768 key generation failed")
  }
  return generated
}

export function buildNoisePrologue(environmentID: string, registrationID: string, streamID: string): Uint8Array {
  const envTrimmed = environmentID.trim()
  if (!envTrimmed) throw new Error("Environment ID is required")
  const regTrimmed = registrationID.trim()
  if (!regTrimmed) throw new Error("Registration ID is required")
  const streamTrimmed = streamID.trim()
  if (!streamTrimmed) throw new Error("Stream ID is required")

  const parts = [
    Buffer.from(PROLOGUE_DOMAIN, "utf8"),
    Buffer.from(envTrimmed, "utf8"),
    Buffer.from(regTrimmed, "utf8"),
    Buffer.from(streamTrimmed, "utf8"),
  ]

  const totalLen = parts.reduce((sum, part) => sum + 8 + part.length, 0)
  const buf = Buffer.alloc(totalLen)
  let offset = 0
  for (const part of parts) {
    buf.writeBigUInt64BE(BigInt(part.length), offset)
    offset += 8
    part.copy(buf, offset)
    offset += part.length
  }
  return buf
}

export async function createCcaNoiseIdentity(): Promise<CcaNoiseIdentity> {
  const x25519 = generateKeyPairSync("x25519")
  const x25519PubRaw = exportX25519PublicKey(x25519.publicKey)

  const mlkem = await generateMlKem768KeyPair()
  const mlkemPubRaw = await exportMlKem768PublicKey(mlkem.publicKey)

  return {
    publicKey: {
      suite: NOISE_SUITE,
      x25519_public_key: Buffer.from(x25519PubRaw).toString("base64"),
      mlkem768_public_key: Buffer.from(mlkemPubRaw).toString("base64"),
    },
    _private: {
      x25519Private: x25519.privateKey,
      x25519PublicRaw: x25519PubRaw,
      mlkemPrivate: mlkem.privateKey,
      mlkemPublicRaw: mlkemPubRaw,
    },
  }
}

class Mutex {
  private queue = Promise.resolve()

  lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

export async function acceptCcaNoiseHandshake(input: AcceptCcaNoiseHandshakeInput): Promise<{
  readonly response: Uint8Array
  readonly transport: CcaNoiseTransport
}> {
  if (input.request.length < 3568 || input.request.length > MAX_NOISE_MESSAGE_LEN) {
    throw new Error("Invalid Noise handshake message 1 length")
  }

  let h = sha256(Buffer.from(NOISE_PROTOCOL_NAME, "ascii"))
  let ck: Uint8Array = new Uint8Array(h)

  const prologue = buildNoisePrologue(input.environmentID, input.registrationID, input.streamID)
  h = sha256(Buffer.concat([h, prologue]))

  h = sha256(Buffer.concat([h, input.identity._private.x25519PublicRaw]))
  h = sha256(Buffer.concat([h, input.identity._private.mlkemPublicRaw]))

  let cipherKey: Uint8Array | null = null
  let cipherNonce = 0n

  let cursor = 0
  const ctKemS = input.request.subarray(cursor, cursor + 1088)
  cursor += 1088

  h = sha256(Buffer.concat([h, ctKemS]))
  let ssKemS: ArrayBuffer
  try {
    ssKemS = await webcrypto.subtle.decapsulateBits(
      { name: "ML-KEM-768" },
      input.identity._private.mlkemPrivate,
      ctKemS,
    )
  } catch {
    throw new Error("Noise handshake decapsulation failed")
  }

  const [ck1, tempH1, tempK1] = hkdf3(ck, new Uint8Array(ssKemS))
  ck = ck1
  h = sha256(Buffer.concat([h, tempH1]))
  cipherKey = tempK1
  cipherNonce = 0n

  const initiatorEDh = input.request.subarray(cursor, cursor + 32)
  cursor += 32
  h = sha256(Buffer.concat([h, initiatorEDh]))

  const initiatorEKem = input.request.subarray(cursor, cursor + 1184)
  cursor += 1184
  h = sha256(Buffer.concat([h, initiatorEKem]))

  let impEKem: webcrypto.CryptoKey
  try {
    impEKem = await importMlKem768PublicKey(initiatorEKem)
  } catch {
    throw new Error("Invalid initiator ephemeral KEM public key")
  }

  let dhEs: Uint8Array
  try {
    dhEs = diffieHellman({
      publicKey: importX25519PublicKey(initiatorEDh),
      privateKey: input.identity._private.x25519Private,
    })
  } catch {
    throw new Error("Noise handshake ES diffie-hellman failed")
  }

  const [ck2, tempK2] = hkdf2(ck, dhEs)
  ck = ck2
  cipherKey = tempK2
  cipherNonce = 0n

  const encSDh = input.request.subarray(cursor, cursor + 48)
  cursor += 48
  let initiatorSDh: Uint8Array
  try {
    initiatorSDh = aesGcmDecrypt(cipherKey, cipherNonce++, h, encSDh)
  } catch {
    throw new Error("Noise handshake initiator DH key decryption failed")
  }
  h = sha256(Buffer.concat([h, encSDh]))

  const encSKem = input.request.subarray(cursor, cursor + 1200)
  cursor += 1200
  let initiatorSKem: Uint8Array
  try {
    initiatorSKem = aesGcmDecrypt(cipherKey, cipherNonce++, h, encSKem)
  } catch {
    throw new Error("Noise handshake initiator KEM key decryption failed")
  }
  h = sha256(Buffer.concat([h, encSKem]))

  let impSKem: webcrypto.CryptoKey
  try {
    impSKem = await importMlKem768PublicKey(initiatorSKem)
  } catch {
    throw new Error("Invalid initiator static KEM public key")
  }

  let dhSs: Uint8Array
  try {
    dhSs = diffieHellman({
      publicKey: importX25519PublicKey(initiatorSDh),
      privateKey: input.identity._private.x25519Private,
    })
  } catch {
    throw new Error("Noise handshake SS diffie-hellman failed")
  }

  const [ck3, tempK3] = hkdf2(ck, dhSs)
  ck = ck3
  cipherKey = tempK3
  cipherNonce = 0n

  const payloadCt = input.request.subarray(cursor)
  let payloadPt: Uint8Array
  try {
    payloadPt = aesGcmDecrypt(cipherKey, cipherNonce++, h, payloadCt)
  } catch {
    throw new Error("Noise handshake payload decryption failed")
  }
  h = sha256(Buffer.concat([h, payloadCt]))

  if (payloadPt.length > 4096) {
    throw new Error("Noise handshake authorization payload is invalid")
  }
  let harnessAuthorization: string
  try {
    harnessAuthorization = new TextDecoder("utf-8", { fatal: true }).decode(payloadPt)
  } catch {
    throw new Error("Noise handshake authorization payload is invalid")
  }
  const harnessPublicKey: CcaNoisePublicKey = {
    suite: NOISE_SUITE,
    x25519_public_key: Buffer.from(initiatorSDh).toString("base64"),
    mlkem768_public_key: Buffer.from(initiatorSKem).toString("base64"),
  }

  await input.authorize(harnessPublicKey, harnessAuthorization)

  const encEKem = await webcrypto.subtle.encapsulateBits({ name: "ML-KEM-768" }, impEKem)
  const ctEkem = new Uint8Array(encEKem.ciphertext)
  const ssEkem = new Uint8Array(encEKem.sharedKey)

  h = sha256(Buffer.concat([h, ctEkem]))
  const [ck4, tempK4] = hkdf2(ck, ssEkem)
  ck = ck4
  cipherKey = tempK4
  cipherNonce = 0n

  const encSKemResult = await webcrypto.subtle.encapsulateBits({ name: "ML-KEM-768" }, impSKem)
  const ctSkem = new Uint8Array(encSKemResult.ciphertext)
  const ssSkem = new Uint8Array(encSKemResult.sharedKey)

  const encCtSkem = aesGcmEncrypt(cipherKey, cipherNonce++, h, ctSkem)
  h = sha256(Buffer.concat([h, encCtSkem]))
  const [ck5, tempH5, tempK5] = hkdf3(ck, ssSkem)
  ck = ck5
  h = sha256(Buffer.concat([h, tempH5]))
  cipherKey = tempK5
  cipherNonce = 0n

  const reDh = generateKeyPairSync("x25519")
  const reDhPub = exportX25519PublicKey(reDh.publicKey)

  const reKem = await generateMlKem768KeyPair()
  const reKemPub = await exportMlKem768PublicKey(reKem.publicKey)

  h = sha256(Buffer.concat([h, reDhPub]))
  h = sha256(Buffer.concat([h, reKemPub]))

  const dhEe = diffieHellman({
    publicKey: importX25519PublicKey(initiatorEDh),
    privateKey: reDh.privateKey,
  })
  const [ck6, tempK6] = hkdf2(ck, dhEe)
  ck = ck6
  cipherKey = tempK6
  cipherNonce = 0n

  const dhSe = diffieHellman({
    publicKey: importX25519PublicKey(initiatorSDh),
    privateKey: reDh.privateKey,
  })
  const [ck7, tempK7] = hkdf2(ck, dhSe)
  ck = ck7
  cipherKey = tempK7
  cipherNonce = 0n

  const respPayloadCt = aesGcmEncrypt(cipherKey, cipherNonce++, h, new Uint8Array(0))
  h = sha256(Buffer.concat([h, respPayloadCt]))

  const responseBytes = Buffer.concat([ctEkem, encCtSkem, reDhPub, reKemPub, respPayloadCt])

  const [recvKey, sendKey] = hkdf2(ck, new Uint8Array(0))

  let broken = false
  let sendNonce = 0n
  let recvNonce = 0n

  const encryptMutex = new Mutex()
  const decryptMutex = new Mutex()

  const transport: CcaNoiseTransport = {
    async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
      return encryptMutex.lock(async () => {
        if (broken) throw new Error("Noise transport is broken")
        if (plaintext.length > MAX_SEND_PLAINTEXT_LEN) {
          throw new Error("Noise plaintext exceeds maximum message length")
        }
        if (sendNonce > 0xffffffffffffffffn) {
          broken = true
          throw new Error("Noise send nonce overflow")
        }
        try {
          const currentNonce = sendNonce++
          return aesGcmEncrypt(sendKey, currentNonce, new Uint8Array(0), plaintext)
        } catch (e) {
          broken = true
          throw new Error("Noise encryption failed")
        }
      })
    },

    async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
      return decryptMutex.lock(async () => {
        if (broken) throw new Error("Noise transport is broken")
        if (ciphertext.length < TAG_LEN || ciphertext.length > MAX_NOISE_MESSAGE_LEN) {
          broken = true
          throw new Error("Invalid Noise ciphertext length")
        }
        if (recvNonce > 0xffffffffffffffffn) {
          broken = true
          throw new Error("Noise receive nonce overflow")
        }
        try {
          const currentNonce = recvNonce++
          return aesGcmDecrypt(recvKey, currentNonce, new Uint8Array(0), ciphertext)
        } catch (e) {
          broken = true
          throw new Error("Noise decryption failed")
        }
      })
    },
  }

  return {
    response: responseBytes,
    transport,
  }
}
