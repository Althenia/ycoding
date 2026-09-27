import { expect, test } from "bun:test"
import { base64UrlDecode, base64UrlEncode } from "../src/auth/crypto"
import { deriveWebPushKeys, encryptWebPushRecord, vapidJwt } from "../src/push/crypto"

const decode = (value: string) => {
  const bytes = base64UrlDecode(value.replaceAll(" ", "").replaceAll("\n", ""))
  if (!bytes) throw new Error("invalid vector")
  return bytes
}

test("RFC 8291 Appendix A derives IKM, CEK, nonce, and exact aes128gcm record", async () => {
  const ua = decode("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
  const sender = decode("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8")
  const shared = decode("kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs")
  const auth = decode("BTBZMqHH6r4Tts7J_aSIgg")
  const salt = decode("DGv6ra1nlYgDCS1FRnbzlw")
  const keys = await deriveWebPushKeys(shared, auth, ua, sender, salt)
  expect(base64UrlEncode(keys.ikm)).toBe("S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg")
  expect(base64UrlEncode(keys.cek)).toBe("oIhVW04MRdy2XN9CiKLxTg")
  expect(base64UrlEncode(keys.nonce)).toBe("4h_95klXJ5E_qnoN")
  const record = await encryptWebPushRecord(new TextEncoder().encode("When I grow up, I want to be a watermelon"), shared, auth, ua, sender, salt)
  expect(base64UrlEncode(record)).toBe("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")
})

test("VAPID token signs ES256 for the endpoint origin with expiry within 12 hours", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  if (!(pair instanceof Object) || !("privateKey" in pair)) throw new Error("key pair unavailable")
  const publicKey = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))
  const privateKey = (await crypto.subtle.exportKey("jwk", pair.privateKey)).d ?? ""
  const jwt = await vapidJwt("https://fcm.googleapis.com/fcm/send/abc", publicKey, privateKey, "mailto:push@example.invalid", 1_700_000_000)
  const [header, claims, signature] = jwt.split(".")
  expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({ typ: "JWT", alg: "ES256" })
  expect(JSON.parse(new TextDecoder().decode(decode(claims)))).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_700_000_000 + 43_200, sub: "mailto:push@example.invalid" })
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, decode(signature), new TextEncoder().encode(`${header}.${claims}`))).toBe(true)
})
