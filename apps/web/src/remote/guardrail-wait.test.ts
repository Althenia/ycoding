import { expect, test } from "bun:test"
import { guardrailClosedNotice, guardrailWaiting } from "./guardrail-wait"

test("guardrail waiting age is live, unreported without a creation time, and stale from fifteen minutes", () => {
  const now = 10_000_000
  expect(guardrailWaiting(undefined, now)).toBeUndefined()
  expect(guardrailWaiting(now - 30_000, now)).toEqual({ label: "Waiting <1 min", stale: false })
  expect(guardrailWaiting(now - 14 * 60_000 - 59_999, now)).toEqual({ label: "Waiting 14 min", stale: false })
  expect(guardrailWaiting(now - 15 * 60_000, now)).toEqual({ label: "Waiting 15 min", stale: true })
  expect(guardrailWaiting(now - 125 * 60_000, now)).toEqual({ label: "Waiting 2 h 5 min", stale: true })
  expect(guardrailWaiting(now - 26 * 3_600_000, now)).toEqual({ label: "Waiting 1 d 2 h", stale: true })
  expect(guardrailWaiting(now + 5_000, now)).toEqual({ label: "Waiting <1 min", stale: false })
})

test("closed guardrail notices say the action did not run and never claim approval", () => {
  expect(guardrailClosedNotice("expired")).toBe("Guardrail review expired. The action did not run.")
  expect(guardrailClosedNotice("cancelled")).toBe("Guardrail review cancelled. The action did not run.")
  expect(guardrailClosedNotice(undefined)).toBe("Guardrail review cancelled. The action did not run.")
})
