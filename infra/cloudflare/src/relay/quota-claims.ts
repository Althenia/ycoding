export type QuotaClaimStorage = {
  readonly get: <Value>(key: string) => Value | undefined
  readonly put: <Value>(key: string, value: Value) => void
  readonly delete: (key: string) => boolean
  readonly list: <Value>(options?: { readonly prefix?: string }) => Iterable<[string, Value]>
}

export type QuotaReservation = { readonly status: "full" } | { readonly status: "reserved"; readonly granted: readonly string[] }

export type QuotaClaimRequest =
  | { readonly op: "reserve"; readonly key: string; readonly until: number; readonly members: readonly string[] }
  | { readonly op: "release"; readonly key: string; readonly members: readonly string[] }

export const quotaClaimLimits = { keys: 512, members: 64, keyChars: 512, memberChars: 160 } as const

type Claim = { readonly until: number; readonly members: readonly string[] }

const prefix = "quota:"

export function createQuotaClaims(storage: QuotaClaimStorage, now: () => number) {
  const live = (claim: Claim | undefined): claim is Claim => claim !== undefined && claim.until > now()

  const admitKey = () => {
    const entries = Array.from(storage.list<Claim>({ prefix }))
    for (const [name] of entries.filter(([, claim]) => !live(claim))) storage.delete(name)
    return entries.filter(([, claim]) => live(claim)).length < quotaClaimLimits.keys
  }

  return {
    reserve(key: string, until: number, members: readonly string[]): QuotaReservation {
      const stored = storage.get<Claim>(prefix + key)
      const current = live(stored) ? stored : undefined
      if (current === undefined && !admitKey()) return { status: "full" }
      const held = current?.members ?? []
      const granted = [...new Set(members)].filter((member) => !held.includes(member)).slice(0, Math.max(0, quotaClaimLimits.members - held.length))
      storage.put<Claim>(prefix + key, { until: Math.max(until, current?.until ?? 0), members: [...held, ...granted] })
      return { status: "reserved", granted }
    },

    release(key: string, members: readonly string[]) {
      const stored = storage.get<Claim>(prefix + key)
      if (!live(stored)) return
      storage.put<Claim>(prefix + key, { until: stored.until, members: stored.members.filter((member) => !members.includes(member)) })
    },
  }
}

export function parseQuotaClaimRequest(value: unknown): QuotaClaimRequest | undefined {
  if (!isRecord(value) || typeof value.key !== "string" || value.key.length === 0 || value.key.length > quotaClaimLimits.keyChars) return undefined
  const members = value.members
  if (!Array.isArray(members) || members.length > quotaClaimLimits.members ||
    !members.every((member): member is string => typeof member === "string" && member.length > 0 && member.length <= quotaClaimLimits.memberChars)) return undefined
  if (value.op === "release")
    return Object.keys(value).length === 3 ? { op: "release", key: value.key, members } : undefined
  if (value.op !== "reserve" || Object.keys(value).length !== 4 || typeof value.until !== "number" || !Number.isSafeInteger(value.until)) return undefined
  return { op: "reserve", key: value.key, until: value.until, members }
}

export function parseQuotaReservation(value: unknown): QuotaReservation | undefined {
  if (!isRecord(value)) return undefined
  if (value.status === "full") return { status: "full" }
  if (value.status !== "reserved" || !Array.isArray(value.granted) || !value.granted.every((member): member is string => typeof member === "string")) return undefined
  return { status: "reserved", granted: value.granted }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
