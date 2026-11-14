import { expect, test } from "bun:test"
import { composerDockCollapsed, composerReserve } from "./composer-dock"

test("composer dock toggles explicitly and expands for new Sessions, pending requests, and palette drafts", () => {
  expect(composerDockCollapsed(false, "toggle")).toBe(true)
  expect(composerDockCollapsed(true, "toggle")).toBe(false)
  for (const event of ["new-session", "pending-request", "palette-draft"] as const) {
    expect(composerDockCollapsed(true, event)).toBe(false)
    expect(composerDockCollapsed(false, event)).toBe(false)
  }
})

test("composer reserve follows the floating stack through growth, shrink and collapse", () => {
  expect(composerReserve(700, 820)).toBe(120)
  expect(composerReserve(620, 820)).toBe(200)
  expect(composerReserve(700, 820)).toBe(120)
  expect(composerReserve(764, 820)).toBe(56)
  expect(composerReserve(820, 820)).toBe(0)
  expect(composerReserve(830, 820)).toBe(0)
  expect(composerReserve(699.4, 820)).toBe(121)
})
