import { expect, test } from "bun:test"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { docsID, scratchID } from "../fixture/coordination-backend"
import { mountCoordination, waitForFrame } from "../fixture/coordination-screen"

test("normal and Project headers share one centered line in the same three-row band", async () => {
  const mounted = await mountCoordination({ width: 200, height: 32 })
  try {
    const project = mounted.screen.lines()
    expect(project[0]!.trim()).toBe("")
    expect(project[1]).not.toContain("Lead")
    expect(project[1]).toContain(`v${InstallationVersion}`)
    expect(project[2]!.trim()).toBe("")
    mounted.router().navigate({ type: "session", sessionID: scratchID })
    await waitForFrame(mounted.screen, "Draft the release")
    const normal = mounted.screen.lines()
    expect(normal[0]!.trim()).toBe("")
    expect(normal[1]).toContain("ready")
    expect(normal[2]!.trim()).toBe("")
  } finally {
    await mounted.screen.dispose()
  }
}, 30_000)

for (const width of [60, 79, 80, 110, 120, 160, 200]) {
  test(`Project footer keeps identity, modes and actions on one row at ${width} columns`, async () => {
    const mounted = await mountCoordination({ width, height: 24 })
    try {
      mounted.router().navigate({ type: "session", sessionID: docsID })
      await waitForFrame(mounted.screen, "Draft the release")
      const footer = mounted.screen.lines().filter((line) => /shells \d|sh\d/.test(line))
      expect(footer).toHaveLength(1)
      const row = footer[0]!
      expect(row).toMatch(/Permissions Manual|P Manual|P:M/)
      expect(row).toMatch(/Guardrails Manual|G Manual|G:M/)
      expect(row).toMatch(/Answers Manual|A Manual|A:M/)
      expect(row).toMatch(/Project|\bp\b/i)
      expect(row).toMatch(/usage|\bu\b/i)
      expect(row.trimEnd().length).toBeLessThanOrEqual(width)
      expect(mounted.screen.lines().filter((line) => /Permissions Manual|P Manual|P:M/.test(line))).toEqual(footer)
      expect(mounted.screen.lines().filter((line) => line.trim() !== "").at(-1)).toBe(row)
      const band = mounted.screen.lines().slice(-4, -1)
      expect(band).toHaveLength(3)
      expect(band[0].trim()).toBe("")
      expect(band[1]).toBe(row)
      expect(band[2].trim()).toBe("")
      await mounted.screen.input.typeText("Retained draft")
      await waitForFrame(mounted.screen, "Retained draft")
      expect(mounted.screen.frame()).toContain("Retained draft")
    } finally {
      await mounted.screen.dispose()
    }
  }, 30_000)
}
