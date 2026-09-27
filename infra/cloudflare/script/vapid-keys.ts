import { base64UrlEncode } from "../src/auth/crypto"

export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  if (!(pair instanceof Object) || !("privateKey" in pair)) throw new Error("P-256 key pair unavailable")
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey)
  if (!(raw instanceof ArrayBuffer)) throw new Error("P-256 public export failed")
  const privateKey = (await crypto.subtle.exportKey("jwk", pair.privateKey)).d
  if (!privateKey) throw new Error("P-256 private export failed")
  return { VAPID_PUBLIC_KEY: base64UrlEncode(new Uint8Array(raw)), VAPID_PRIVATE_KEY: privateKey }
}

if (import.meta.main) console.log(JSON.stringify(await generateVapidKeys()))
