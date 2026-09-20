export type RelayRole = "agent" | "client"
export type SmokeSignal = { readonly type: "ping" | "pong" }
export type RelayTarget = RelayRole | "self"

export function smokeHostname(hostname: string) {
  return hostname === "ycoding-cloud.lostq901.workers.dev" || hostname === "localhost" || hostname === "127.0.0.1"
}

export function smokeSignal(value: string | ArrayBuffer): SmokeSignal | undefined {
  if (typeof value !== "string") return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    const keys = Object.keys(parsed)
    if (keys.length !== 1 || keys[0] !== "type") return undefined
    const type = Reflect.get(parsed, "type")
    if (type !== "ping" && type !== "pong") return undefined
    return { type }
  } catch {
    return undefined
  }
}

export function relayTargets(role: RelayRole, signal: SmokeSignal): readonly RelayTarget[] {
  if (role === "agent" && signal.type === "ping") return ["self"]
  if (role === "client" && signal.type === "ping") return ["agent"]
  if (role === "agent" && signal.type === "pong") return ["client"]
  return []
}
