import { describe, expect, test } from "bun:test"
import { DOC_GROUPS, DOC_INDEX, DOC_PAGES, PUBLIC_DOC_PATHS, docsByGroup, findDocPage, sectionId, slugifyHeading } from "./registry"

// Canonical public routes from the approved information architecture.
const APPROVED_DOC_ROUTES = [
  "/docs/getting-started",
  "/docs/installation",
  "/docs/quickstart",
  "/docs/usage",
  "/docs/usage/tui",
  "/docs/usage/cli",
  "/docs/usage/remote",
  "/docs/usage/sessions",
  "/docs/configuration",
  "/docs/configuration/agents",
  "/docs/configuration/models",
  "/docs/configuration/providers",
  "/docs/configuration/plugins",
  "/docs/configuration/mcp",
  "/docs/configuration/goal",
  "/docs/configuration/yolo",
  "/docs/configuration/guardrails",
  "/docs/configuration/notifications",
  "/docs/configuration/permissions",
  "/docs/configuration/tools",
  "/docs/configuration/appearance",
  "/docs/troubleshooting",
] as const

// Engineering documents that must never be published as public pages.
const INTERNAL_DOC_SLUGS = [
  "architecture",
  "runtime",
  "repository-resources",
  "provider-efficiency",
  "computer-use",
  "browser-extension",
  "memory",
  "guardrails-and-provider-usage",
  "ycoding-migration",
  "tui-redesign-backlog",
  "okf",
  "releases",
  "README",
] as const

describe("public docs allowlist", () => {
  test("publishes exactly the approved routes", () => {
    expect([...PUBLIC_DOC_PATHS].sort()).toEqual([...APPROVED_DOC_ROUTES].sort())
    expect(DOC_PAGES.map((page) => `/docs/${page.slug}`).sort()).toEqual([...APPROVED_DOC_ROUTES].sort())
  })

  test("exposes no engineering document as a public page", () => {
    for (const slug of INTERNAL_DOC_SLUGS) {
      expect(findDocPage(slug)).toBeUndefined()
      expect(findDocPage(slug.toLowerCase())).toBeUndefined()
    }
  })

  test("resolves approved slugs and rejects unknown ones", () => {
    expect(findDocPage("usage/tui")?.title.length).toBeGreaterThan(0)
    expect(findDocPage("configuration/guardrails")?.title.length).toBeGreaterThan(0)
    expect(findDocPage("usage/terminal")).toBeUndefined()
    expect(findDocPage("configuration/secrets")).toBeUndefined()
    expect(findDocPage("")).toBeUndefined()
  })
})

describe("documentation index", () => {
  test("describes release installation without claiming a signature", () => {
    const install = DOC_INDEX.sections.flatMap((section) =>
      section.blocks.flatMap((block) => (block.kind === "steps" ? block.items : [])),
    ).find((step) => step.title === "Install")
    expect(install?.text).toBe("Install a checksum-verified release build, or run from a checkout with Bun 1.4.2.")
  })

  test("describes every group and links the configuration domains", () => {
    expect(DOC_INDEX.slug).toBe("")
    expect(DOC_INDEX.sections.length).toBeGreaterThan(0)
    const linked = DOC_INDEX.sections.flatMap((section) =>
      section.blocks.flatMap((block) => (block.kind === "cards" ? block.items.map((item) => item.href) : [])),
    )
    const configurationDomains = DOC_PAGES.filter((page) => page.group === "Configuration")
      .map((page) => `/docs/${page.slug}`)
      .filter((href) => href !== "/docs/configuration")
    for (const href of configurationDomains) expect(linked).toContain(href)
  })
})

describe("remote workspace documentation", () => {
  test("distinguishes the browser tool display cap from device truncation", () => {
    const remote = findDocPage("usage/remote")
    const conversation = remote?.sections.flatMap((section) =>
      section.blocks.flatMap((block) => (block.kind === "table" ? block.rows : [])),
    ).find((row) => row[0] === "Conversation")
    expect(conversation?.[1]).toContain("first 4,000 characters")
    expect(conversation?.[1]).toContain("device truncation")
  })
})

describe("page structure", () => {
  test("gives every page a group, description, and content", () => {
    const slugs = new Set<string>()
    for (const page of DOC_PAGES) {
      expect(DOC_GROUPS).toContain(page.group)
      expect(page.title.length).toBeGreaterThan(0)
      expect(page.description.length).toBeGreaterThan(20)
      expect(page.sections.length).toBeGreaterThan(0)
      expect(slugs.has(page.slug)).toBe(false)
      slugs.add(page.slug)
    }
  })

  test("groups every page under exactly one navigation group", () => {
    const grouped = docsByGroup()
    expect(grouped.map((entry) => entry.group)).toEqual([...DOC_GROUPS])
    const counted = grouped.reduce((total, entry) => total + entry.pages.length, 0)
    expect(counted).toBe(DOC_PAGES.length)
  })

  test("gives every section a unique, non-empty heading id", () => {
    for (const page of DOC_PAGES) {
      const ids = page.sections.map((_, index) => sectionId(page, index))
      expect(ids.every((id) => id.length > 0)).toBe(true)
      expect(new Set(ids).size).toBe(ids.length)
      for (const [index, section] of page.sections.entries()) {
        expect(section.heading.trim().length).toBeGreaterThan(0)
        expect(section.blocks.length).toBeGreaterThan(0)
        expect(sectionId(page, index)).toBe(slugifyHeading(section.heading))
      }
    }
  })

  test("resolves every related link", () => {
    for (const page of DOC_PAGES) {
      const related = page.sections.flatMap((section) =>
        section.blocks.flatMap((block) => (block.kind === "related" ? block.slugs : [])),
      )
      for (const slug of related) expect(findDocPage(slug)).toBeDefined()
    }
  })

  test("references code fences with a language or file label", () => {
    for (const page of DOC_PAGES) {
      const code = page.sections.flatMap((section) =>
        section.blocks.filter((block) => block.kind === "code"),
      ) as readonly { language?: string; code: string }[]
      for (const block of code) {
        expect(block.code.trim().length).toBeGreaterThan(0)
        expect(block.language?.length ?? 0).toBeGreaterThan(0)
      }
    }
  })
})

describe("slugifyHeading", () => {
  test("produces stable anchors from headings", () => {
    expect(slugifyHeading("What it controls")).toBe("what-it-controls")
    expect(slugifyHeading("Permissions, guardrails & approval")).toBe("permissions-guardrails-approval")
    expect(slugifyHeading("  YOLO mode  ")).toBe("yolo-mode")
  })
})
