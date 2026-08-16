/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { Global } from "@ycoding-ai/core/global"
import { rm } from "node:fs/promises"
import path from "path"
import { json } from "../fixture/tui-client"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"
import { renderScreen } from "./harness"

const directory = `${process.env.HOME ?? "/tmp/ycoding/home"}/landing-design-match`
const location = { directory, project: { id: "proj_landing_design_match", directory } }
const model = {
  id: "ling-3.0-flash",
  modelID: "provider/ling-3.0-flash",
  providerID: "provider",
  name: "Ling-3.0-flash",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "max" }],
  time: { released: 0 },
  cost: [],
  status: "active" as const,
  enabled: true,
  limit: { context: 1_048_576, output: 32_768 },
}

function landingRoute(url: URL) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main" } })
  if (url.pathname === "/api/agent")
    return json({ location, data: [{ id: "build", name: "Build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } }] })
  if (url.pathname === "/api/model") return json({ location, data: [model] })
  if (url.pathname === "/api/provider") return json({ location, data: [] })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname))
    return json({ location, data: [] })
  return undefined
}

async function selectModelVariant() {
  const file = path.join(Global.make().state, "model.json")
  const previous = Bun.file(file)
  const content = (await previous.exists()) ? await previous.text() : undefined
  await Bun.write(file, JSON.stringify({ recent: [], favorite: [], variant: { "provider/ling-3.0-flash": "max" } }))
  return async () => {
    if (content === undefined) return rm(file, { force: true })
    await Bun.write(file, content)
  }
}

async function expectLandingDesign(viewport: typeof DESIGN_VIEWPORT) {
  const restoreModelPreference = await selectModelVariant()
  try {
    const screen = await renderScreen({ ...viewport, route: landingRoute, settle: "Ling-3.0-flash" })
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (screen.frame().includes("Ling-3.0-flash") && screen.frame().includes("Enter send")) break
        await Bun.sleep(20)
      }
      const lines = screen.lines()
      const header = lines[1]
      const placeholder = lines[59]
      const hints = lines[61]

      expect(lines.findIndex((line) => line.includes("Message YCoding…"))).toBe(59)
      expect(lines.findIndex((line) => line.includes("Enter send"))).toBe(61)
      expect(placeholder?.indexOf("Message YCoding…")).toBe(3)
      expect(hints?.indexOf("Enter send")).toBe(3)
      expect(hints?.indexOf("↓ subagents")).toBe(16)
      // String indexes count ↓ as one code point; it occupies two terminal columns.
      expect(hints?.indexOf("⌃x b sidebar")).toBe(30)
      expect(hints?.indexOf("⌃p commands")).toBe(45)
      expect(header).toContain("Ling-3.0-flash · max")
      expect(screen.colorOf("max")).toEqual([103, 215, 170, 255])
    } finally {
      await screen.dispose()
    }
  } finally {
    await restoreModelPreference()
  }
}

describe("landing Penpot design match", () => {
  test("matches the 189x69 landing measurements", () => expectLandingDesign(DESIGN_VIEWPORT), 60_000)
  test("matches the 220x69 landing measurements", () => expectLandingDesign(DESIGN_VIEWPORT_WIDE), 60_000)
})
