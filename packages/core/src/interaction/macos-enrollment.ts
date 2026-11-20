import type { Interaction } from "@ycoding-ai/schema/interaction"

export interface ChromeEnrollmentIntent {
  readonly type: "connect-chrome"
  readonly id: Interaction.ID
}

export interface ChromeEnrollmentOffer {
  readonly code: string
  readonly expiresAt: number
  readonly revoke: () => void
}

export type EnrollmentNotice = { state: "chromeEnrollmentIntent"; id: Interaction.ID; expiresAt: number }
  | { state: "chromeEnrollmentEnded"; id: Interaction.ID }

export function bindChromeEnrollment(options: {
  readonly signal: AbortSignal
  readonly offer: (intent: ChromeEnrollmentIntent, signal: AbortSignal) => ChromeEnrollmentOffer | undefined
  readonly send: (id: Interaction.ID, offer?: Pick<ChromeEnrollmentOffer, "code" | "expiresAt">) => Promise<boolean>
  readonly close?: () => void
}) {
  const seen = new Map<Interaction.ID, number>()
  let active: { id: Interaction.ID; controller: AbortController; revoke?: () => void; timer?: ReturnType<typeof setTimeout> } | undefined
  let closed = options.signal.aborted

  function retire(id: Interaction.ID) {
    const current = active
    if (current?.id !== id) return
    active = undefined
    clearTimeout(current.timer)
    current.revoke?.()
    current.controller.abort()
  }

  function disconnect() {
    closed = true
    options.signal.removeEventListener("abort", disconnect)
    if (active) retire(active.id)
  }

  async function dismiss(id: Interaction.ID) {
    retire(id)
    if (!closed) await options.send(id).catch(() => options.close?.())
  }

  if (!closed) options.signal.addEventListener("abort", disconnect, { once: true })

  return { disconnect, async receive(notice: EnrollmentNotice) {
    if (closed) return
    if (notice.state === "chromeEnrollmentEnded") return retire(notice.id)
    const now = Date.now()
    for (const [id, expiry] of seen) if (expiry <= now) seen.delete(id)
    if (notice.expiresAt <= now || notice.expiresAt - now > 10_000 || active || seen.has(notice.id)) return dismiss(notice.id)
    if (seen.size >= 32) {
      disconnect()
      options.close?.()
      return
    }
    seen.set(notice.id, notice.expiresAt)
    const attempt = { id: notice.id, controller: new AbortController() }
    active = attempt
    let enrollment: ChromeEnrollmentOffer | undefined
    try {
      enrollment = options.offer({ type: "connect-chrome", id: notice.id }, AbortSignal.any([options.signal, attempt.controller.signal]))
    } catch { return dismiss(notice.id) }
    if (!enrollment || typeof enrollment.revoke !== "function") return dismiss(notice.id)
    if (active !== attempt) { enrollment.revoke(); return }
    active.revoke = enrollment.revoke
    const remaining = enrollment.expiresAt - Date.now()
    if (closed || Date.now() >= notice.expiresAt || !Number.isSafeInteger(enrollment.expiresAt) || remaining <= 0 || remaining > 60_000 ||
        !/^[A-Za-z0-9_-]{43}$/.test(enrollment.code)) return dismiss(notice.id)
    active.timer = setTimeout(() => { void dismiss(notice.id) }, remaining)
    active.timer.unref()
    const presented = await options.send(notice.id, { code: enrollment.code, expiresAt: enrollment.expiresAt }).catch(() => false)
    if (active === attempt && !presented) await dismiss(notice.id)
  } }
}
