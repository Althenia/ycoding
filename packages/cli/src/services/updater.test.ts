import { describe, expect, test } from "bun:test"
import { action, decodePolicy, updateCheckSkipReason } from "./updater"

describe("updater", () => {
  test("reads autoupdate from JSONC", () => {
    expect(decodePolicy('{ // preference\n "autoupdate": "notify",\n}')).toBe("notify")
    expect(decodePolicy('{ "autoupdate": false }')).toBe(false)
    expect(decodePolicy('{ "autoupdate": "invalid" }')).toBeUndefined()
  })

  test("skips local, disabled, and preview update checks", () => {
    expect(updateCheckSkipReason({ local: true, disabled: false, version: "1.2.3" })).toBe("local-install")
    expect(updateCheckSkipReason({ local: false, disabled: true, version: "1.2.3" })).toBe("disabled")
    expect(updateCheckSkipReason({ local: false, disabled: false, version: "0.0.0-main-20260722034528845" })).toBe(
      "preview-build",
    )
    expect(updateCheckSkipReason({ local: false, disabled: false, version: "0.0.0-feature-123" })).toBe(
      "preview-build",
    )
    expect(updateCheckSkipReason({ local: false, disabled: false, version: "1.2.3" })).toBeUndefined()
    expect(updateCheckSkipReason({ local: false, disabled: false, version: "1.2.3-beta.1" })).toBeUndefined()
  })

  test("automatically updates patches and minors", () => {
    expect(action("1.2.3", "1.2.4", true)).toBe("upgrade")
    expect(action("1.2.3", "1.3.0", true)).toBe("upgrade")
    expect(action("1.2.3", "1.2.4", "notify")).toBe("upgrade")
    expect(action("1.2.3", "1.3.0", "notify")).toBe("upgrade")
  })

  test("skips when autoupdate is disabled", () => {
    expect(action("1.2.3", "1.2.4", false)).toBe("none")
  })

  test("never automatically updates majors", () => {
    expect(action("1.2.3", "2.0.0", true)).toBe("none")
  })

  test("reports up-to-date only when versions match", () => {
    expect(action("1.2.3", "1.2.3", true)).toBe("none")
  })

  test("upgrades when latest is lower (rollback)", () => {
    expect(action("1.2.4", "1.2.3", true)).toBe("upgrade")
  })
})
