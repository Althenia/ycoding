/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { Global } from "@ycoding-ai/core/global"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { mkdir, rm } from "node:fs/promises"
import path from "path"
import { renderScreen } from "./harness"
import { json } from "../fixture/tui-client"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT } from "../viewport"

const directory = `${process.env.HOME ?? "/tmp/ycoding/home"}/landing`
const location = { directory, project: { id: "proj_landing", directory } }
const agent = {
  id: "build",
  name: "Build",
  mode: "primary" as const,
  hidden: false,
  permissions: [],
  request: { headers: {}, body: {} },
}
const model = {
  id: "landing-model",
  modelID: "provider/landing-model",
  providerID: "provider",
  name: "Landing Model",
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
  if (url.pathname === "/api/agent") return json({ location, data: [agent] })
  if (url.pathname === "/api/model") return json({ location, data: [model] })
  if (url.pathname === "/api/provider") return json({ location, data: [] })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname))
    return json({ location, data: [] })
  return undefined
}

async function expectLandingScreen(viewport: typeof DESIGN_VIEWPORT) {
  const restoreModelPreference = await selectModelVariant()
  try {
    const screen = await renderScreen({
      ...viewport,
      route: landingRoute,
      settle: viewport.width >= 120 ? "max" : "Landing Model",
    })
    try {
    if (viewport.width >= 120) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (screen.lines().some((line) => line.includes("ready") && line.includes("main"))) break
        await Bun.sleep(20)
      }
    }
    const frame = screen.frame()
    const lines = screen.lines()
    const header = lines.find((line) => line.includes("ready"))

    expect(header).toBeDefined()
    if (!header) return
    expect(header).toContain("y. ycoding")
    expect(header).toContain("Build")
    expect(header).toContain("Landing Model")
    if (viewport.width >= 120) {
      expect(header).toContain("max")
      expect(header.indexOf("Landing Model")).toBeLessThan(header.indexOf("max"))
    }
    expect(header).toContain("ready")
    if (viewport.width >= 120) {
      expect(header).toContain("~/landing")
      expect(header).toContain("main")
    }
    if (viewport.width < 120) {
      expect(header).not.toContain("~/landing")
      expect(header).not.toContain("main")
    }

    expect(frame).toContain("y. ycoding")
    expect(frame).toContain("What should we build?")
    expect(frame).toContain("Describe a goal, paste an error, or press ⌃p for commands.")
    expect(frame).toContain("Message YCoding…")
    expect(frame).not.toContain("Ask anything")

    for (const hint of ["Enter send", "↓ subagents", "⌃x b sidebar", "⌃p commands"]) {
      expect(frame).toContain(hint)
    }

    for (const footer of ["main", "goal off", "YOLO off", "subagents 0"]) {
      expect(frame).toContain(footer)
    }

    expect(lines.some((line) => line.includes("╹") || line.includes("▀"))).toBe(false)
    expect(lines.find((line) => line.startsWith("─"))?.length).toBe(viewport.width)

    // Penpot board a50fa4ae-966d-8083-8008-651de90a14ca: the composer rule, placeholder
    // and hint row sit directly above the footer band, not adrift in the middle.
    const rule = lines.findIndex((line) => line.startsWith("─"))
    const placeholder = lines.findIndex((line) => line.includes("Message YCoding…"))
    const hints = lines.findIndex((line) => line.includes("Enter send"))
    const footer = lines.findIndex((line) => line.includes("goal off"))

    if (viewport.width === DESIGN_VIEWPORT.width || viewport.width === DESIGN_VIEWPORT_WIDE.width) {
      const output = path.resolve(import.meta.dir, "../../../../.aphrodite/renders")
      await mkdir(output, { recursive: true })
      await Bun.write(path.join(output, `landing-variant-${viewport.width}x${viewport.height}.txt`), frame)
    }

    expect(rule).toBeLessThan(placeholder)
    expect(placeholder).toBeLessThan(hints)
    expect(hints).toBeLessThan(footer)

    if (viewport.width === DESIGN_VIEWPORT.width) {
      const heading = lines.findIndex((line) => line.includes("What should we build?"))
      const description = lines.findIndex((line) => line.includes("Describe a goal, paste an error"))
      const headerRow = lines.findIndex((line) => line.includes("ready"))

      expect(headerRow).toBe(1)
      expect(heading).toBe(29)
      expect(description).toBe(32)
      expect(rule).toBe(57)
      expect(placeholder).toBe(59)
      expect(hints).toBe(61)
      expect(footer).toBe(67)
      expect(header.indexOf("y. ycoding")).toBe(3)
      expect(header.indexOf("~/landing") - (header.indexOf("y. ycoding") + `y. ycoding v${InstallationVersion}`.length)).toBe(6)
      expect(viewport.width - header.trimEnd().length).toBe(3)
      expect(lines[footer]?.indexOf("main")).toBe(3)
      expect(lines[footer]?.indexOf("goal off")! - (lines[footer]?.indexOf("main")! + "main".length)).toBe(3)
      expect(lines[footer]?.indexOf("YOLO off")! - (lines[footer]?.indexOf("goal off")! + "goal off".length)).toBe(3)
      expect(lines[footer]?.indexOf("subagents 0")! - (lines[footer]?.indexOf("YOLO off")! + "YOLO off".length)).toBe(3)
      expect(lines[hints]?.indexOf("↓ subagents")! - (lines[hints]?.indexOf("Enter send")! + "Enter send".length)).toBe(3)
      expect(lines[hints]?.indexOf("⌃x b sidebar")! - (lines[hints]?.indexOf("↓ subagents")! + "↓ subagents".length)).toBe(3)
      expect(lines[hints]?.indexOf("⌃p commands")! - (lines[hints]?.indexOf("⌃x b sidebar")! + "⌃x b sidebar".length)).toBe(3)
    }

    // The reference places no agent or model row between the placeholder and the hints.
    for (const line of lines.slice(placeholder + 1, hints)) {
      expect(line).not.toContain("Landing Model")
    }

    // Every hero line is centred on the frame independently, not left-aligned in a block.
    // The native bitmap mark deliberately replaces the frozen text wordmark; it has no stable glyph frame.
    for (const hero of ["What should we build?", "Describe a goal, paste an error"]) {
      const line = lines.slice(rule < 0 ? 0 : 0, rule).find((candidate) => candidate.includes(hero))
      expect(line).toBeDefined()
      if (!line) continue
      const start = line.indexOf(line.trim())
      const end = start + line.trim().length
      expect(Math.abs(start - (viewport.width - end))).toBeLessThanOrEqual(1)
    }

    } finally {
      await screen.dispose()
    }
  } finally {
    await restoreModelPreference()
  }
}

async function selectModelVariant() {
  const file = path.join(Global.make().state, "model.json")
  const previous = Bun.file(file)
  const content = (await previous.exists()) ? await previous.text() : undefined
  await Bun.write(file, JSON.stringify({ recent: [], favorite: [], variant: { "provider/landing-model": "max" } }))
  return async () => {
    if (content === undefined) return rm(file, { force: true })
    await Bun.write(file, content)
  }
}

// Asserts docs/design/ycoding-tui-design.html section 7 against the real Home
// route, not extracted sub-components.
describe("landing screen", () => {
  test("renders the design composer, hero, footer, and hint row at 189x69", () => expectLandingScreen(DESIGN_VIEWPORT), 60_000)

  test("keeps the composer full-width at 220x69", () => expectLandingScreen(DESIGN_VIEWPORT_WIDE), 60_000)

  test("keeps the landing composer structurally clean at 80x24", () => expectLandingScreen(NARROW_VIEWPORT), 60_000)
})
