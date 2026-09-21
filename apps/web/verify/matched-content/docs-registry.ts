import type { DocGroup, DocPage } from "../../src/content/docs/types"

export const DOC_GROUPS = ["Get started", "Use", "Configuration", "Help"] as const

const pages = (group: DocGroup, entries: readonly [string, string][]): readonly DocPage[] =>
  entries.map(([slug, title]) => ({ slug, title, group, description: title, sections: [] }))

const gettingStarted: DocPage = {
  slug: "getting-started",
  title: "Getting started",
  group: "Get started",
  description: "What YCoding is, where it runs, and which surfaces belong to the product today.",
  sections: [
    {
      heading: "What YCoding is",
      blocks: [
        {
          kind: "paragraph",
          text: "YCoding is a coding agent that runs in your terminal. Sessions, prompts, tool calls, file edits, shell commands, and model requests all happen on your machine, in the directory you started it from.",
        },
        {
          kind: "paragraph",
          text: "The terminal application is the primary surface. Sessions are durable: history, pending input, and orchestration survive restarts, so you can stop working and continue later.",
        },
      ],
    },
    {
      heading: "Core concepts",
      blocks: [
        {
          kind: "table",
          head: ["Concept", "What it means"],
          rows: [
            ["Session", "Durable intent, history, pending input, and execution state for one line of work."],
            ["Agent", "Configured behavior and model choice. Agents can be primary or run as background subagents."],
            ["Autonomy", "Whether YCoding asks before acting: standard, tiered YOLO levels, or an active goal."],
            ["Permission", "Ordered rules that allow, deny, or ask about one tool action on one resource."],
            ["Guardrail", "A session-family review of high-impact actions, independent of tool permissions."],
            ["Skill", "Reusable instructions you load into a session, from the repository or a shared source."],
            ["Project artifact", "Managed, versioned customization such as a skill, command, agent, or plugin."],
          ],
        },
      ],
    },
    {
      heading: "Where things live",
      blocks: [
        {
          kind: "table",
          head: ["Surface", "Files"],
          rows: [
            ["Runtime configuration", "ycoding.json, ycoding.jsonc, .ycoding/ycoding.json, .ycoding/ycoding.jsonc"],
            ["Terminal preferences", "cli.json in the YCoding config directory"],
            ["Managed service", "service.json (or the channel-specific file) in the YCoding config directory"],
            ["Repository customization", ".ycoding/agents, .ycoding/commands, .ycoding/plugins, .ycoding/guardrails, .ycoding/themes"],
            ["Instructions", "AGENTS.md at the project root and above the current directory"],
          ],
        },
        {
          kind: "callout",
          tone: "info",
          title: "One current format",
          text: "tui.json, kv.json, and config.json are not read. Runtime settings belong in the runtime files and terminal preferences in cli.json.",
        },
      ],
    },
    {
      heading: "Next steps",
      blocks: [
        {
          kind: "list",
          items: [
            "Install a release build and verify the checksum.",
            "Connect at least one provider so model requests can run.",
            "Start your first session and send a prompt.",
          ],
        },
        {
          kind: "cards",
          items: [
            { title: "Installation", text: "Install a release, verify it, and keep it updated.", href: "/docs/installation" },
            { title: "Quickstart", text: "From install to a first answer in a few minutes.", href: "/docs/quickstart" },
            { title: "Working in the terminal", text: "Sessions, prompts, approvals, and the composer.", href: "/docs/usage/tui" },
          ],
        },
      ],
    },
  ],
}

export const DOC_INDEX: DocPage = {
  slug: "",
  title: "Documentation",
  group: "Get started",
  description: "Install YCoding, run your first session, and configure the runtime for your machine.",
  sections: [],
}

export const DOC_PAGES: readonly DocPage[] = [
  gettingStarted,
  ...pages("Get started", [["installation", "Installation"], ["quickstart", "Quickstart"]]),
  ...pages("Use", [["usage", "Using YCoding"], ["usage/tui", "Working in the terminal"], ["usage/command-line", "Command line"], ["usage/remote", "Remote workspace"], ["usage/sessions", "Sessions"]]),
  ...pages("Configuration", [["configuration", "Configuration"], ["configuration/agents", "Agents"], ["configuration/models", "Models"], ["configuration/providers", "Providers"], ["configuration/plugins", "Plugins"], ["configuration/mcp", "MCP"], ["configuration/goal", "Goal"], ["configuration/yolo", "YOLO mode"], ["configuration/guardrails", "Guardrails"], ["configuration/notifications", "Notifications"], ["configuration/permissions", "Permissions"], ["configuration/tools", "Tools"], ["configuration/appearance", "Appearance"]]),
  ...pages("Help", [["troubleshooting", "Troubleshooting"]]),
]

export const PUBLIC_DOC_PATHS: readonly string[] = DOC_PAGES.map((page) => `/docs/${page.slug}`)

export function findDocPage(slug: string): DocPage | undefined {
  return DOC_PAGES.find((page) => page.slug === slug)
}

export function docsByGroup(): readonly { readonly group: DocGroup; readonly pages: readonly DocPage[] }[] {
  return DOC_GROUPS.map((group) => ({ group, pages: DOC_PAGES.filter((page) => page.group === group) }))
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function sectionId(page: DocPage, index: number): string {
  return slugifyHeading(page.sections[index]?.heading ?? "")
}
