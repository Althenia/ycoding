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
  test("documents indefinite required answers without advertising a question expiry setting", () => {
    const page = JSON.stringify(findDocPage("configuration"))
    expect(page.includes("question_timeout_seconds")).toBe(false)
    expect(page.includes("no elapsed-time expiry")).toBe(true)
    expect(page.includes("not restored after a server restart")).toBe(true)
  })

  test("usage guidance distinguishes measured rates, causal costs, retained coverage and quota warm-up", () => {
    const section = findDocPage("usage/sessions")?.sections.find((section) => section.heading === "Usage, prompt costs, and forecasts")
    const text = section?.blocks.flatMap((block) => block.kind === "paragraph" || block.kind === "callout" ? [block.text] : []).join(" ") ?? ""
    for (const required of ["provider default at request time", "selected effort", "median and p90", "Weighted throughput", "≈", "already-started requests keep their owner", "inclusive rows overlap", "Missing prices", "one-hour horizon", "15-minute half-life", "No increase observed does not mean unlimited"])
      expect(text).toContain(required)
    expect(text).not.toMatch(/usage_anchor|usageAnchor|session_provider_request|credential IDs|CREATE TABLE/)
  })

  test("documents Muse account and key setup with current authentication limits", () => {
    const section = findDocPage("configuration/providers")?.sections.find((section) => section.heading === "Muse (Meta)")
    const text = section?.blocks.flatMap((block) => block.kind === "paragraph" ? [block.text] : []).join(" ") ?? ""
    for (const required of ["muse", "Meta Muse Code account", "Meta Model API key", "META_API_KEY", "minimal", "max", "metadata", "catalog", "hidden", "non-tool", "re-login", "unknown", "response stream observations", "Weekly", "Quota reads do not mint keys"])
      expect(text).toContain(required)
  })

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
  test("documents ordinary shell resource limits without a shell queue", () => {
    const resource = findDocPage("configuration/tools")?.sections.find((section) => section.heading === "Resource limits")
    const rows = resource?.blocks.flatMap((block) => block.kind === "table" ? block.rows : []) ?? []
    expect(rows.find((row) => row[0] === "`shell_memory_limit_mb`")?.[3]).toContain("overrides it per call")
    expect(rows.find((row) => row[0] === "`shell_sandbox`")?.[3]).toContain("isolation")
    expect(JSON.stringify(DOC_PAGES)).not.toContain("shell_queue")
  })

  test("describes release installation without claiming a signature", () => {
    const install = DOC_INDEX.sections.flatMap((section) =>
      section.blocks.flatMap((block) => (block.kind === "steps" ? block.items : [])),
    ).find((step) => step.title === "Install")
    expect(install?.text).toBe("Install a checksum-verified release build, or run from a checkout with a current Bun release.")
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
  test("documents Focus navigation, distinguishes creation from detail, and keeps Session links device-scoped", () => {
    const remote = findDocPage("usage/remote")
    const text = JSON.stringify(remote?.sections)
    expect(text).toContain("Sessions (/remote/sessions), Usage (/remote/usage), and Settings (/remote/settings)")
    expect(text).toContain("New session at /remote")
    expect(text).toContain("Resume session")
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
  test("documents helper model precedence and estimated confidence", () => {
    const tools = findDocPage("configuration/tools")
    const text = JSON.stringify(tools?.sections)
    expect(text).toContain("ycoding.tool.decision")
    expect(text).toContain("agents.decision.model")
    expect(text).toContain("efficiency.helper_models.decision")
    expect(text).not.toContain("min_confidence")
    expect(text).toContain("uncalibrated")
    expect(text).toContain("subscription")
    const example = tools?.sections.flatMap((section) => section.blocks)
      .find((block) => block.kind === "code" && block.label === "Decision helper model")
    expect(example?.kind).toBe("code")
    if (example?.kind !== "code") throw new Error("Decision helper model example is missing")
    expect(Bun.JSONC.parse(example.code)).toEqual({
      efficiency: { helper_models: { decision: "openai/gpt-6-luna-fast#medium" } },
    })
    expect(JSON.stringify(findDocPage("configuration/models")?.sections)).toContain(".decision")
    expect(JSON.stringify(findDocPage("configuration/agents")?.sections)).toContain("`decision`")
  })

  test("documents explicit judgments and runtime grading with thresholds and fallback", () => {
    const tools = findDocPage("configuration/tools")
    const text = JSON.stringify(tools?.sections)
    expect(text).toContain("Agent judgments use `decision`")
    expect(text).toContain("during /sleep")
    expect(text).not.toContain("/guardrail-decision")
    expect(text).toContain("confidence 0.8 or higher")
    expect(text).toContain("auto-answer on (default off)")
    expect(text).not.toContain("auto_answer")
    expect(text).toContain("guardrails.decide_reviews: true (default false)")
    expect(text).not.toContain("automatic fallback")
    expect(text).toContain("permission ceilings")
    expect(text).toContain("owner choices")
    expect(text).toContain("insufficient evidence")
    expect(text).toContain("refusal")
    expect(text).toContain("authorized")
    expect(text).toContain("keep-current")
    const example = tools?.sections.flatMap((section) => section.blocks)
      .find((block) => block.kind === "code" && block.label === "Explicit decision request")
    expect(example?.kind).toBe("code")
    if (example?.kind !== "code") throw new Error("Explicit decision request example is missing")
    expect(Bun.JSONC.parse(example.code)).toMatchObject({ provider: "agent", request: {
      state: expect.any(Object), questions: [
        { type: "choice", name: "route", choices: [{ value: "keep-current", description: expect.any(String) }, { value: "change", description: expect.any(String) }] },
        { type: "predicate", name: "ready", instructions: expect.any(String) },
      ],
    } })
    expect(JSON.stringify(findDocPage("configuration/goal")?.sections)).toContain("explicit goal")
    expect(JSON.stringify(findDocPage("configuration/guardrails")?.sections)).toContain("Denies never reach the helper")
    const rejected = findDocPage("configuration")?.sections.flatMap((section) => section.blocks)
      .find((block) => block.kind === "code" && block.label === "Rejected keys")
    expect(rejected?.kind === "code" ? rejected.code : "").toContain("decisions")
  })

  test("documents the current built-in guardrail tiers and outside-repository review", () => {
    const guardrails = JSON.stringify(findDocPage("configuration/guardrails")?.sections)
    for (const rule of [
      "standard.review.project-deletion",
      "standard.review.home-child",
      "standard.review.git-destructive",
      "standard.review.force-push",
      "standard.review.database-destructive",
      "standard.review.outside-repo",
    ]) expect(guardrails).toContain(rule)
    expect(guardrails).not.toContain("standard.review.broad-deletion")
    expect(guardrails).not.toContain("standard.review.publish")
    expect(guardrails).toContain("While awake")
    expect(guardrails).not.toContain("guardrail-decision")
    expect(guardrails).toContain("case-sensitive")
    expect(guardrails).toContain("YOLO 2")
    expect(guardrails).not.toContain("YOLO 3")
    expect(guardrails).toContain("human handoff")
    expect(guardrails).toContain("decision model")
    expect(guardrails).toContain("one graded call")
  })

  test("guardrail documentation pins per-choice thresholds and the hard-review delegation setting", () => {
    const blocks = findDocPage("configuration/guardrails")?.sections.flatMap((section) => section.blocks) ?? []
    const thresholds = blocks.find((block) => block.kind === "table" && block.head[0] === "Choice")
    expect(thresholds?.kind === "table" ? thresholds.rows : undefined).toEqual([
      ["Approve all", "Ordinary reviews offering Always", "`0.9`", "Grant the offered Always approval."],
      ["Approve", "Ordinary reviews", "`0.8`", "Approve once."],
      ["Approve", "Hard reviews", "`0.95`", "Approve once."],
      ["Reject", "Ordinary and hard reviews", "`0.8`", "Reject the action."],
    ])
    const settings = blocks.find((block) => block.kind === "table" && block.head[0] === "Field")
    const hard = settings?.kind === "table" ? settings.rows.find((row) => row[0] === "`guardrails.decide_hard_reviews`") : undefined
    expect(hard?.slice(0, 3)).toEqual(["`guardrails.decide_hard_reviews`", "boolean", "`true`"])
    expect(hard?.[3]).toContain("humans while awake")
    expect(hard?.[3]).toContain("review box while asleep")
    const master = settings?.kind === "table" ? settings.rows.find((row) => row[0] === "`guardrails.decide_reviews`") : undefined
    expect(master?.slice(0, 3)).toEqual(["`guardrails.decide_reviews`", "boolean", "`false`"])
    expect(master?.[3]).toContain("review box while asleep")
    const options = findDocPage("configuration")?.sections.flatMap((section) => section.blocks) ?? []
    const answer = options.flatMap((block) => (block.kind === "table" ? block.rows : [])).find((row) => row[0] === "`auto_answer`")
    expect(answer).toBeUndefined()
  })

  test("current usage docs name levels Ask first, Allow tools, and Tools + reviews and distinguish hard reviews from YOLO automation", () => {
    const remote = findDocPage("usage/remote")
    const control = remote?.sections.flatMap((section) => section.blocks).find((block) => block.kind === "table" && block.head[0] === "Autonomy control")
    expect(control?.kind === "table" ? control.rows.map((row) => row[0]) : undefined).toEqual(["Ask first", "Allow tools", "Tools + reviews", "Goal"])
    for (const slug of ["usage/tui", "usage/cli", "usage/remote", "configuration/yolo", "configuration/guardrails", "configuration/tools"]) {
      const text = JSON.stringify(findDocPage(slug)?.sections)
      expect(text).not.toMatch(/hard reviews (?:always |still )?require a (?:fresh )?human/i)
      expect(text).not.toContain("unless /sleep delegates")
      expect(text).not.toContain("when /sleep is on")
      expect(text).not.toContain("YOLO 3")
      expect(text).not.toContain("auto_answer")
    }
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
      "Get notified when a Session needs your decision, a guardrail blocks an action, a run fails, or a background-work result is lost. Lost results are identified separately from requests for your input. Each Session keeps one unread stored attention notice. While it stays unread, the Session alerts again on that notice only when it needs something different or at least 10 minutes after its last alert. A later run clears failure attention.",
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
