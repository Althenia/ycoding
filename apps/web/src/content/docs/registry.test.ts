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
  test("documents all five destinations, distinguishes landing from transcript, and keeps Session links device-scoped", () => {
    const remote = findDocPage("usage/remote")
    const text = JSON.stringify(remote?.sections)
    expect(text).toContain("Sessions (/remote/sessions), Conversation (/remote), Session (/remote/session), Usage (/remote/usage), and Settings (/remote/settings)")
    expect(text).toContain("Conversation is always the logo and new-session landing")
    expect(text).toContain("/remote/session?session_id=<id>&device_id=<id>")
    expect(text).toContain("with optional &notice_id=<id>")
    expect(text).toContain("unknown, revoked, or offline device is reported unavailable, with no fallback to another machine")
    expect(text).not.toContain("four named icon destinations")
    expect(text).not.toContain("the Session opens in Conversation")
  })

  test("distinguishes the browser tool display cap from device truncation", () => {
    const remote = findDocPage("usage/remote")
    const conversation = remote?.sections.flatMap((section) =>
      section.blocks.flatMap((block) => (block.kind === "table" ? block.rows : [])),
    ).find((row) => row[0] === "Session")
    expect(conversation?.[1]).toContain("first 4,000 characters")
    expect(conversation?.[1]).toContain("device truncation")
  })
})

describe("structured decision documentation", () => {
  test("documents helper model precedence and separates estimated confidence from native probabilities", () => {
    const tools = findDocPage("configuration/tools")
    const text = JSON.stringify(tools?.sections)
    expect(text).toContain("ycoding.tool.decision")
    expect(text).toContain("agents.decision.model")
    expect(text).toContain("efficiency.helper_models.decision")
    expect(text).toContain("min_confidence")
    expect(text).toContain("min_probability")
    expect(text).toContain("uncalibrated")
    expect(text).toContain("subscription")
    expect(text).toContain("OPENAI_API_KEY")
    expect(text).toContain("TYPESAFE_API_KEY")
    expect(text).toContain("API Platform billing")
    const example = tools?.sections.flatMap((section) => section.blocks)
      .find((block) => block.kind === "code" && block.label === "Decision helper model")
    expect(example?.kind).toBe("code")
    if (example?.kind !== "code") throw new Error("Decision helper model example is missing")
    expect(Bun.JSONC.parse(example.code)).toEqual({
      efficiency: { helper_models: { decision: "openai/gpt-6-luna-fast#medium" } },
    })
    const native = tools?.sections.flatMap((section) => section.blocks)
      .find((block) => block.kind === "code" && block.label === "Native decision connections")
    if (native?.kind !== "code") throw new Error("Native decision connection example is missing")
    expect(Bun.JSONC.parse(native.code)).toEqual({
      decisions: {
        timeout_ms: 10000,
        providers: {
          openai: { api_key: "{env:OPENAI_API_KEY}" },
          typesafe: { api_key: "{env:TYPESAFE_API_KEY}", model: "jev-1.13.0" },
        },
      },
    })
    expect(JSON.stringify(findDocPage("configuration/models")?.sections)).toContain(".decision")
    expect(JSON.stringify(findDocPage("configuration/agents")?.sections)).toContain("`decision`")
  })

  test("documents opt-in policies without granting permission or claiming goal completion", () => {
    const tools = findDocPage("configuration/tools")
    const text = JSON.stringify(tools?.sections)
    expect(text).toContain("disabled when omitted")
    expect(text).toContain("hard reviews")
    expect(text).toContain("explicit selections")
    expect(text).toContain("stopped")
    expect(text).toContain("completed")
    expect(text).toContain("authorized")
    expect(text).toContain("keep-current")
    const example = tools?.sections.flatMap((section) => section.blocks)
      .find((block) => block.kind === "code" && block.label === "Opt-in decision policies")
    expect(example?.kind).toBe("code")
    if (example?.kind !== "code") throw new Error("Opt-in decision policies example is missing")
    expect(Bun.JSONC.parse(example.code)).toEqual({
      decisions: {
        guardrails: { provider: "agent", min_confidence: 0.95 },
        routing: {
          provider: "agent", min_confidence: 0.9,
          candidates: [{ id: "delivery", description: "Complete a bounded repository implementation", agent: "GSD" }],
        },
        goal: { provider: "agent", min_confidence: 0.95 },
        questions: { provider: "agent", min_confidence: 0.8 },
      },
    })
    expect(JSON.stringify(findDocPage("configuration/goal")?.sections)).toContain("decisions.goal")
    expect(JSON.stringify(findDocPage("configuration/guardrails")?.sections)).toContain("decisions.guardrails")
    expect(JSON.stringify(findDocPage("configuration")?.sections)).toContain("`decisions`")
  })
})

describe("remote recovery documentation", () => {
  test("documents saved enablement, bounded recovery, safe disable, and manual repair", () => {
    const recovery = findDocPage("usage/remote")?.sections.find((section) => section.heading === "Connection recovery")
    const text = JSON.stringify(recovery?.blocks ?? [])
    expect(text).toContain("connecting")
    expect(text).toContain("1, 2, 4, 8, 16")
    expect(text).toContain("30 seconds")
    expect(text).toContain("authentication")
    expect(text).toContain("pending enable")
    expect(text).toContain("late")
    expect(text).toContain("off and then on")
    expect(text).toContain("ycoding remote status")
    expect(text).toContain("ycoding update")
    const help = JSON.stringify(findDocPage("troubleshooting")?.sections)
    expect(help).toContain("automatically")
    expect(help).toContain("connecting")
    expect(help).toContain("rejected credentials")
    expect(help).toContain("off and then on")
  })
})

describe("page structure", () => {
  test("the remote guide describes family-finished and attention categories", () => {
    const section = findDocPage("usage/remote")?.sections.find((entry) => entry.heading === "Notifications and availability")
    const text = JSON.stringify(section?.blocks)
    expect(section?.blocks.flatMap((block) => block.kind === "table" ? block.rows.map((row) => row[0]) : [])).toEqual(["Work finished", "Needs your attention", "Machine offline"])
    expect(section?.blocks.flatMap((block) => block.kind === "table" ? block.rows.map((row) => row[1]) : [])).toEqual([
      "Get notified after the agent declares its requested work finished and verified, its final reply settles, and no input, subagent, shell or goal work remains pending. An ordinary reply or idle status alone does not trigger an alert. Reconnecting does not repeat an accepted completion.",
      "Get notified when a Session needs your decision, a guardrail blocks an action, or a run fails. Each Session keeps one unread stored attention notice. While it stays unread, the Session alerts again on that notice only when it needs something different or at least 10 minutes after its last alert. A later run clears failure attention.",
      "Get notified when a paired machine stays disconnected from the relay for 40 seconds, so a routine reconnect raises no alert. An open workspace alerts for its selected machine, and Push to this device alerts a closed browser or app; each browser shows one System alert per outage. A browser-only relay disconnect does not establish that the machine is offline.",
    ])
    expect(text).toContain("System switch also decides whether Push to this device")
    expect(text).not.toContain("stops running")
  })
  test("configuration pages describe local attention without a removed remote notification tool", () => {
    expect(JSON.stringify(DOC_PAGES.filter((page) => page.group === "Configuration"))).not.toMatch(/ntfy/i)
    expect(findDocPage("configuration/notifications")?.sections.some((section) => section.heading === "Terminal attention")).toBe(true)
  })
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
