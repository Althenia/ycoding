import { base64UrlDecode, base64UrlEncode, cryptoBytes } from "../auth/crypto"

const encoder = new TextEncoder()

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

async function hmac(key: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", cryptoBytes(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, cryptoBytes(value)))
}

export async function deriveWebPushKeys(shared: Uint8Array, auth: Uint8Array, receiver: Uint8Array, sender: Uint8Array, salt: Uint8Array) {
  const prkKey = await hmac(auth, shared)
  const ikm = await hmac(prkKey, concat(encoder.encode("WebPush: info"), new Uint8Array([0]), receiver, sender, new Uint8Array([1])))
  const prk = await hmac(salt, ikm)
  const cek = (await hmac(prk, concat(encoder.encode("Content-Encoding: aes128gcm"), new Uint8Array([0, 1])))).slice(0, 16)
  const nonce = (await hmac(prk, concat(encoder.encode("Content-Encoding: nonce"), new Uint8Array([0, 1])))).slice(0, 12)
  return { ikm, cek, nonce }
}

export async function encryptWebPushRecord(plaintext: Uint8Array, shared: Uint8Array, auth: Uint8Array, receiver: Uint8Array, sender: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  if (plaintext.length > 3_993 || receiver.length !== 65 || sender.length !== 65 || salt.length !== 16 || auth.length !== 16)
    throw new Error("Invalid Web Push record")
  const { cek, nonce } = await deriveWebPushKeys(shared, auth, receiver, sender, salt)
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"])
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key,
    cryptoBytes(concat(plaintext, new Uint8Array([2])))))
  return concat(salt, new Uint8Array([0, 0, 16, 0, 65]), sender, ciphertext)
}

export async function encryptWebPushPayload(plaintext: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array> {
  const receiver = base64UrlDecode(p256dh)
  const secret = base64UrlDecode(auth)
  if (receiver?.length !== 65 || secret?.length !== 16) throw new Error("Invalid Web Push subscription")
  const publicKey = await crypto.subtle.importKey("raw", cryptoBytes(receiver), { name: "ECDH", namedCurve: "P-256" }, false, [])
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  if (!(pair instanceof Object) || !("privateKey" in pair)) throw new Error("ECDH pair unavailable")
  const agreement = { name: "ECDH" }
  Reflect.set(agreement, "public", publicKey)
  const shared = new Uint8Array(await crypto.subtle.deriveBits(agreement, pair.privateKey, 256))
  const exported = await crypto.subtle.exportKey("raw", pair.publicKey)
  if (!(exported instanceof ArrayBuffer)) throw new Error("ECDH public key export failed")
  const sender = new Uint8Array(exported)
  return encryptWebPushRecord(plaintext, shared, secret, receiver, sender, crypto.getRandomValues(new Uint8Array(16)))
}

export async function vapidJwt(endpoint: string, publicKey: string, privateKey: string, subject: string, nowSeconds: number): Promise<string> {
  const point = base64UrlDecode(publicKey)
  const scalar = base64UrlDecode(privateKey)
  if (point?.length !== 65 || point[0] !== 4 || scalar?.length !== 32) throw new Error("VAPID keys unavailable")
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: base64UrlEncode(point.slice(1, 33)),
    y: base64UrlEncode(point.slice(33, 65)), d: privateKey, ext: false }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })))
  const claims = base64UrlEncode(encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 43_200, sub: subject })))
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`)))
  return `${header}.${claims}.${base64UrlEncode(signature)}`
}
