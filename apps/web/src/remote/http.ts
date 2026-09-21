import type { CreateEnrollmentResponse, MeResponse, RemoteDeviceInfo } from "@ycoding-ai/remote"

export type RemoteHttpFailureReason = "http" | "unexpected-body" | "network"

export type RemoteHttpResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false
      readonly status: number
      readonly message: string
      readonly kind: RemoteHttpFailureReason
    }

export type RemoteHttp = {
  readonly me: () => Promise<RemoteHttpResult<MeResponse>>
  readonly devices: () => Promise<RemoteHttpResult<readonly RemoteDeviceInfo[]>>
  readonly createEnrollment: () => Promise<RemoteHttpResult<CreateEnrollmentResponse>>
  readonly revokeDevice: (deviceID: string) => Promise<RemoteHttpResult<void>>
  readonly logout: () => Promise<RemoteHttpResult<void>>
}

export type RemoteHttpOptions = {
  /** Absolute or same-origin base. Empty string keeps same-origin requests relative. */
  readonly baseURL?: string
  readonly fetch?: typeof fetch
}

/** Same-origin sign-in entry point. `redirectAfter` must begin with `/remote`. */
export function signInURL(redirectAfter: string, baseURL = ""): string {
  const target = redirectAfter.startsWith("/remote") ? redirectAfter : "/remote"
  return `${baseURL}/api/auth/google/start?redirect_after=${encodeURIComponent(target)}`
}

export function createRemoteHttp(options: RemoteHttpOptions = {}): RemoteHttp {
  const base = options.baseURL ?? ""
  const request = options.fetch ?? globalThis.fetch
  const send = (input: string, init?: RequestInit) => request(`${base}${input}`, { credentials: "same-origin", ...init })

  const json = async <T>(
    input: string,
    init?: RequestInit,
    read?: (payload: unknown) => T | undefined,
  ): Promise<RemoteHttpResult<T>> => {
    try {
      const response = await send(input, init)
      if (!response.ok) return failure<T>(response.status, await errorMessage(response), "http")
      const payload = await readJson(response)
      if (read === undefined) return { ok: true, value: undefined as T }
      const value = read(payload)
      return value === undefined
        ? failure<T>(response.status, "The response was not an API document", "unexpected-body")
        : { ok: true, value }
    } catch (cause) {
      return failure<T>(0, cause instanceof Error ? cause.message : "The request could not be sent", "network")
    }
  }

  return {
    me: () => json<MeResponse>("/api/me", undefined, readMe),
    devices: () => json<readonly RemoteDeviceInfo[]>("/api/devices", undefined, readDevices),
    createEnrollment: () =>
      json<CreateEnrollmentResponse>("/api/devices/enrollments", { method: "POST" }, readEnrollment),
    revokeDevice: (deviceID) =>
      json<void>(`/api/devices/${encodeURIComponent(deviceID)}/revoke`, { method: "POST" }),
    logout: () => json<void>("/api/auth/logout", { method: "POST" }),
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

async function errorMessage(response: Response): Promise<string> {
  const payload = await readJson(response)
  if (payload !== undefined && typeof payload === "object" && payload !== null) {
    const error = (payload as { error?: unknown }).error
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message
      if (typeof message === "string" && message.length > 0) return message
    }
  }
  return `Request failed with status ${response.status}`
}

function failure<T>(
  status: number,
  message: string,
  kind: RemoteHttpFailureReason,
): RemoteHttpResult<T> {
  return { ok: false, status, message, kind }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readDeviceInfo(value: unknown): RemoteDeviceInfo | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== "string" || value.id.length === 0) return undefined
  if (typeof value.name !== "string") return undefined
  if (value.status !== "active" && value.status !== "revoked") return undefined
  return {
    id: value.id,
    name: value.name,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    ...(typeof value.lastSeenAt === "number" ? { lastSeenAt: value.lastSeenAt } : {}),
    ...(typeof value.revokedAt === "number" ? { revokedAt: value.revokedAt } : {}),
    status: value.status,
  }
}

function readMe(payload: unknown): MeResponse | undefined {
  if (!isRecord(payload)) return undefined
  const user = payload.user
  const session = payload.session
  if (!isRecord(user) || typeof user.id !== "string") return undefined
  if (!isRecord(session) || typeof session.expiresAt !== "number") return undefined
  const devices = Array.isArray(payload.devices) ? payload.devices : []
  return {
    user: { id: user.id },
    session: { expiresAt: session.expiresAt },
    devices: devices.flatMap((device) => {
      const info = readDeviceInfo(device)
      return info ? [info] : []
    }),
  }
}

function readDevices(payload: unknown): readonly RemoteDeviceInfo[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.devices)) return undefined
  return payload.devices.flatMap((device) => {
    const info = readDeviceInfo(device)
    return info ? [info] : []
  })
}

function readEnrollment(payload: unknown): CreateEnrollmentResponse | undefined {
  if (!isRecord(payload)) return undefined
  const { enrollmentID, code, expiresAt } = payload
  if (typeof enrollmentID !== "string" || enrollmentID.length === 0) return undefined
  if (typeof code !== "string" || code.length === 0) return undefined
  if (typeof expiresAt !== "number") return undefined
  return { enrollmentID, code, expiresAt }
}
