import { describe, expect, test } from "bun:test"
import { DOC_INDEX, DOC_PAGES, docsByGroup, p10IndexDescription, p10IndexLede, p10IndexSpecimen, p10IndexTitle } from "./docs-registry"

describe("P10 documentation index fixture", () => {
  test("preserves the existing non-P10 navigation order", () => {
    expect(docsByGroup().map(group => [group.group, group.pages.length, group.pages.map(page => page.title)])).toEqual([
      ["Get started", 3, ["Getting started", "Installation", "Quickstart"]],
      ["Use", 4, ["Terminal", "Command line", "Remote workspace", "Sessions"]],
      ["Configuration", 12, ["Agents", "Models", "Providers", "Plugins", "MCP", "Goal", "YOLO", "Guardrails", "Notifications", "Permissions", "Tools", "Appearance"]],
      ["Help", 1, ["Troubleshooting"]],
    ])
  })

  test("selects only the three approved P10 specimens", () => {
    const specimens = [1440, 768, 390] as const
    expect(specimens.map((specimen) => p10IndexSpecimen(`?stitch=p10&specimen=${specimen}`))).toEqual([...specimens])
    expect(p10IndexSpecimen("?stitch=p10&specimen=320")).toBeUndefined()
    expect(p10IndexSpecimen("?stitch=p11&specimen=1440")).toBeUndefined()
  })

  test("uses distinct approved title and copy at each P10 viewport", () => {
    const specimens = [1440, 768, 390] as const
    expect(specimens.map((specimen) => p10IndexTitle(specimen))).toEqual(["Documentation", "Documentation Index", "Documentation Index"])
    expect(specimens.map((specimen) => p10IndexLede(specimen))).toEqual([
      "Welcome to the YCoding documentation index. Explore setup guides, usage patterns, configuration options, and support topics across all supported environments.",
      "Browse configuration, usage, and quickstart documentation tailored for tablet viewing.",
      "Guides, configuration schema, and references.",
    ])
    expect(specimens.map((specimen) => p10IndexDescription(specimen, 0, "fallback"))).toEqual([
      "Set up your first project and initialize your agent workspace in minutes with essential starting guidelines.",
      "Initialize a workspace and set up essential project agents.",
      "Initialize first workspace and setup agent.",
    ])
  })

  test("keeps the P11 registry entry outside P10", () => {
    expect(DOC_PAGES.some((page) => page.slug === "getting-started")).toBeTrue()
    expect(DOC_INDEX.title).toBe("Documentation")
  })
})
