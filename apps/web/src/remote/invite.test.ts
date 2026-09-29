import { expect, test } from "bun:test"
import { formatAccessKey, inviteLandingView, normalizeAccessKey, takeInviteToken } from "./invite"

test("normalizes a 32-character Crockford key without accepting other lengths or alphabet symbols", () => {
  const key = "0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ"
  expect(normalizeAccessKey(`  ${key.toLowerCase()}  `)).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
  expect(normalizeAccessKey("OOOO-IIII-LLLL-0000-1111-2222-3333-4444")).toBe("00001111111100001111222233334444")
  for (const invalid of ["short", "Z".repeat(33), "!".repeat(32), undefined]) expect(normalizeAccessKey(invalid)).toBeUndefined()
  expect(formatAccessKey("0123456789ABCDEFGHJKMNPQRSTVWXYZ")).toBe(key)
})

test("invite landing view does not redeem on load and distinguishes invalid and revealed states", () => {
  expect(inviteLandingView("ready")).toMatchObject({ title: "You're invited to YCoding Remote", canAccept: true, showKey: false })
  expect(inviteLandingView("invalid")).toMatchObject({ canAccept: false, message: "This invite link was already used or is no longer valid." })
  expect(inviteLandingView("revealed")).toMatchObject({ canAccept: false, showKey: true })
  expect(inviteLandingView("error")).toMatchObject({ canAccept: true, message: "The invite could not be accepted. Try again." })
})

test("takes an invite fragment into memory and strips the URL before any action", () => {
  const replaced: string[] = []
  expect(takeInviteToken("#" + "A".repeat(43), (target) => replaced.push(target))).toBe("A".repeat(43))
  expect(replaced).toEqual(["/remote/invite"])
  expect(takeInviteToken("", (target) => replaced.push(target))).toBeUndefined()
})
