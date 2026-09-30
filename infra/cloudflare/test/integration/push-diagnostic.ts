import { base64UrlDecode, cryptoBytes, sha256Hex } from "../../src/auth/crypto"

const providerCodes = ["UNREGISTERED", "INVALID_ARGUMENT", "SENDER_ID_MISMATCH", "THIRD_PARTY_AUTH_ERROR", "UNAUTHENTICATED",
  "PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "NOT_FOUND", "INTERNAL", "UNAVAILABLE", "NotRegistered", "InvalidRegistration",
  "MismatchSenderId", "UnauthorizedRegistration", "unreported"] as const

export type PushDiagnostic = {
  readonly endpointHash: string
  readonly publicKeyMatchesServed: boolean
  readonly jwtVerified: boolean
  readonly audienceMatches: boolean
  readonly status?: number
  readonly providerCode: (typeof providerCodes)[number]
}

export async function inspectPushRequest(endpoint: string, authorization: string | null, servedPublicKeyHash: string) {
  const endpointHash = await sha256Hex(endpoint)
  const empty = { endpointHash, publicKeyMatchesServed: false, jwtVerified: false, audienceMatches: false }
  if (!authorization || authorization.length > 4096) return empty
  const match = /^vapid t=([A-Za-z0-9_.-]+), k=([A-Za-z0-9_-]+)$/.exec(authorization)
  if (!match) return empty
  const publicKeyMatchesServed = await sha256Hex(match[2]) === servedPublicKeyHash
  try {
    const parts = match[1].split(".")
    const header = base64UrlDecode(parts[0])
    const claims = base64UrlDecode(parts[1])
    const signature = base64UrlDecode(parts[2])
    const point = base64UrlDecode(match[2])
    if (parts.length !== 3 || !header || !claims || !signature || signature.length !== 64 || !point || point.length !== 65 || point[0] !== 4)
      return { ...empty, publicKeyMatchesServed }
    const metadata: unknown = JSON.parse(new TextDecoder().decode(header))
    const payload: unknown = JSON.parse(new TextDecoder().decode(claims))
    const audienceMatches = record(payload) && payload.aud === new URL(endpoint).origin
    const key = await crypto.subtle.importKey("raw", cryptoBytes(point), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
    const jwtVerified = publicKeyMatchesServed && record(metadata) && metadata.alg === "ES256" &&
      await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, cryptoBytes(signature), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
    return { endpointHash, publicKeyMatchesServed, jwtVerified, audienceMatches }
  } catch {
    return { ...empty, publicKeyMatchesServed }
  }
}

export async function inspectPushResponse(response: Response): Promise<PushDiagnostic["providerCode"]> {
  const body = await boundedJson(response)
  if (!record(body)) return "unreported"
  const error = record(body.error) ? body.error : undefined
  const details = Array.isArray(error?.details) ? error.details.filter(record) : []
  const candidates = [body.error, error?.status, error?.code, ...details.map((item) => item.errorCode)]
  return providerCodes.find((code) => candidates.includes(code)) ?? "unreported"
}

export function parsePushDiagnostic(value: unknown): PushDiagnostic | undefined {
  if (!record(value) || Object.keys(value).some((key) => !["endpointHash", "publicKeyMatchesServed", "jwtVerified", "audienceMatches", "status", "providerCode"].includes(key)) ||
    typeof value.endpointHash !== "string" || !/^[a-f0-9]{64}$/.test(value.endpointHash) ||
    typeof value.publicKeyMatchesServed !== "boolean" || typeof value.jwtVerified !== "boolean" || typeof value.audienceMatches !== "boolean" ||
    (value.status !== undefined && (typeof value.status !== "number" || !Number.isInteger(value.status) || value.status < 100 || value.status > 599))) return undefined
  const providerCode = providerCodes.find((code) => code === value.providerCode)
  if (!providerCode) return undefined
  return { endpointHash: value.endpointHash, publicKeyMatchesServed: value.publicKeyMatchesServed, jwtVerified: value.jwtVerified,
    audienceMatches: value.audienceMatches, ...(value.status === undefined ? {} : { status: value.status }), providerCode }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > 4096 || !response.body) return undefined
  const reader = response.clone().body!.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const decoder = new TextDecoder()
        let text = ""
        let bytes = 0
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) return JSON.parse(text + decoder.decode()) as unknown
          bytes += chunk.value.byteLength
          if (bytes > 4096) return undefined
          text += decoder.decode(chunk.value, { stream: true })
        }
      })(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 2000) }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    void reader.cancel().catch(() => undefined)
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
