export type InvitePhase = "ready" | "accepting" | "invalid" | "revealed" | "error"

export function normalizeAccessKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.toUpperCase().replace(/[\s-]/g, "").replaceAll("O", "0").replaceAll("I", "1").replaceAll("L", "1")
  return /^[0-9A-HJKMNP-TV-Z]{32}$/.test(normalized) ? normalized : undefined
}

export function formatAccessKey(value: string): string {
  return value.replaceAll("-", "").match(/.{4}/g)?.join("-") ?? value
}

export function takeInviteToken(fragment: string, replace: (path: string) => void): string | undefined {
  if (fragment) replace("/remote/invite")
  const token = fragment.startsWith("#") ? fragment.slice(1) : ""
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined
}

export function inviteLandingView(phase: InvitePhase) {
  return {
    title: "You're invited to YCoding Remote",
    canAccept: phase === "ready" || phase === "error",
    showKey: phase === "revealed",
    message: phase === "invalid" ? "This invite link was already used or is no longer valid."
      : phase === "error" ? "The invite could not be accepted. Try again." : undefined,
  }
}
