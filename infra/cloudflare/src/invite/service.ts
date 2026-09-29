import { randomToken, sha256Hex } from "../auth/crypto"
import { browserSessionTtlMs } from "../auth/service"
import type { InviteStore } from "./store"

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export function formatAccessKey(value: string): string {
  return value.match(/.{4}/g)?.join("-") ?? value
}

export function normalizeAccessKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.toUpperCase().replace(/[\s-]/g, "").replaceAll("O", "0").replaceAll("I", "1").replaceAll("L", "1")
  return /^[0-9A-HJKMNP-TV-Z]{32}$/.test(normalized) ? normalized : undefined
}

function newAccessKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  let value = 0
  let bits = 0
  let result = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      result += alphabet[(value >>> bits) & 31]
      value &= (1 << bits) - 1
    }
  }
  return result
}

export function createInviteService(store: InviteStore, now: () => number = Date.now) {
  return {
    async create(label: string | null, origin: string) {
      const id = `inv_${randomToken(12)}`
      const token = randomToken(32)
      const createdAt = now()
      await store.create({ id, tokenHash: await sha256Hex(token), label, createdAt })
      return { id, url: `${origin}/remote/invite#${token}`, label, createdAt }
    },
    list: () => store.list(),
    find: (id: string) => store.find(id),
    delete: (id: string, userID: string | null) => store.delete(id, userID),
    async redeem(token: string) {
      const userID = `usr_${randomToken(9)}`
      const accessKey = newAccessKey()
      const cookieToken = randomToken(32)
      const createdAt = now()
      const redeemed = await store.redeem(await sha256Hex(token), { userID, keyHash: await sha256Hex(accessKey),
        sessionHash: await sha256Hex(cookieToken), now: createdAt, expiresAt: createdAt + browserSessionTtlMs })
      return redeemed ? { accessKey: formatAccessKey(accessKey), cookieToken } : undefined
    },
    async signIn(accessKey: unknown) {
      const normalized = normalizeAccessKey(accessKey)
      if (!normalized) return undefined
      const cookieToken = randomToken(32)
      const createdAt = now()
      const signedIn = await store.signIn(await sha256Hex(normalized), { sessionHash: await sha256Hex(cookieToken),
        now: createdAt, expiresAt: createdAt + browserSessionTtlMs })
      return signedIn ? cookieToken : undefined
    },
  }
}
