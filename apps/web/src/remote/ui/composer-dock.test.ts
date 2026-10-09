import { expect, test } from "bun:test"
import { composerDockCollapsed } from "./composer-dock"

test("composer dock toggles explicitly and expands for new Sessions, pending requests, and palette drafts", () => {
  expect(composerDockCollapsed(false, "toggle")).toBe(true)
  expect(composerDockCollapsed(true, "toggle")).toBe(false)
  for (const event of ["new-session", "pending-request", "palette-draft"] as const) {
    expect(composerDockCollapsed(true, event)).toBe(false)
    expect(composerDockCollapsed(false, event)).toBe(false)
  }
})
