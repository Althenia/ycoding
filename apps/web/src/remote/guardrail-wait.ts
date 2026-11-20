import { staleAfterMs } from "../../../../packages/schema/src/guardrail"

export function guardrailWaiting(created: number | undefined, now: number): { readonly label: string; readonly stale: boolean } | undefined {
  if (created === undefined || !Number.isFinite(created)) return undefined
  const age = Math.max(0, now - created)
  const minutes = Math.floor(age / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const span = minutes < 1 ? "<1 min" : hours < 1 ? `${minutes} min` : days < 1 ? `${hours} h ${minutes % 60} min` : `${days} d ${hours % 24} h`
  return { label: `Waiting ${span}`, stale: age >= staleAfterMs }
}

export function guardrailClosedNotice(reason: unknown): string {
  return reason === "expired"
    ? "Guardrail review expired. The action did not run."
    : "Guardrail review cancelled. The action did not run."
}
