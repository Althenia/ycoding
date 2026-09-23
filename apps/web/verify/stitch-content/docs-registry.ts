import type { DocGroup, DocPage } from "../../src/content/docs/types"

// P10/P11, export-adaptation/p10.html and p11.html: public index labels and Quickstart specimen text.
export const DOC_GROUPS = ["Get started", "Use", "Configuration", "Help"] as const

const page = (slug: string, title: string, group: DocGroup, description = title): DocPage => ({ slug, title, group, description, sections: [] })

export function p10IndexSpecimen(search: string): 1440 | 768 | 390 | undefined {
  const params = new URLSearchParams(search)
  if (params.get("stitch") !== "p10") return undefined
  const specimen = Number(params.get("specimen"))
  if (specimen === 1440 || specimen === 768 || specimen === 390) return specimen
  return undefined
}

const p10Specimen = p10IndexSpecimen(typeof window === "undefined" ? "" : window.location.search)

const p10Descriptions = {
  1440: [
    "Set up your first project and initialize your agent workspace in minutes with essential starting guidelines.",
    "Download instructions, package managers, system prerequisites, and verification steps across operating platforms.",
    "Interactive terminal controls, navigation keybindings, split pane views, and real-time execution outputs.",
    "CLI arguments, flags, environment switches, and programmatic non-interactive batch pipelines.",
    "Connecting to remote environments, synchronizing project files, and coordinating distant compute instances.",
    "Preserving context states, restoring history buffers, branching session paths, and managing persistent runs.",
    "Behavioral profiles, roles, and automated reasoning policies.", "Default model assignment, routing preferences, and fallbacks.", "API connectivity, token quotas, endpoints, and credentials.", "Extending core capabilities with community packages.", "Model Context Protocol integration, server parameters, and tools.", "Defining project objectives, completion criteria, and targets.", "Autonomous auto-approval modes for non-interactive execution.", "Safety limits, command boundaries, and protected directories.", "Desktop alerts, webhook dispatches, and audio cues.", "Fine-grained file read/write controls and access grants.", "Built-in utility hooks, formatters, linters, and test runners.", "Theme variations, typography, font sizing, and UI density.", "Diagnosing common issues, resolving connection errors, analyzing operation logs, and getting assistance from community channels.",
  ],
  768: [
    "Initialize a workspace and set up essential project agents.", "Platform packages, prerequisites, and verify your local install.", "Interactive workspace interface, key bindings, and display controls.", "CLI commands, parameters, switches, and scripting integration.", "Synchronize files and orchestrate distributed developer tasks.", "Branch execution context, restore previous runs, and persist states.",
    "Behavior & roles", "Routing & engines", "API connection keys", "Extensibility hooks", "Protocol bindings", "Target objectives", "Auto-approval rules", "Safety & boundary", "Alerts & signals", "File access controls", "Linters & runtimes", "Themes & contrast", "Resolving issues, debugging runtime stalls, and common diagnostics.",
  ],
  390: [
    "Initialize first workspace and setup agent.",
    "Setup binaries and install instructions.",
    "Interface shortcuts and execution views.",
    "CLI commands and parameters.",
    "Connect and synchronize files remotely.",
    "Restore states and maintain session logs.",
    "", "", "", "", "", "", "", "", "", "", "", "", "Diagnosing issues and support resources.",
  ],
} as const

export function p10IndexTitle(specimen: 1440 | 768 | 390 | undefined): string {
  return specimen === undefined || specimen === 1440 ? "Documentation" : "Documentation Index"
}

export function p10IndexLede(specimen: 1440 | 768 | 390 | undefined): string {
  if (specimen === 768) return "Browse configuration, usage, and quickstart documentation tailored for tablet viewing."
  if (specimen === 390) return "Guides, configuration schema, and references."
  return "Welcome to the YCoding documentation index. Explore setup guides, usage patterns, configuration options, and support topics across all supported environments."
}

export function p10IndexDescription(specimen: 1440 | 768 | 390 | undefined, index: number, fallback: string): string {
  if (specimen === undefined) return fallback
  return p10Descriptions[specimen][index] ?? fallback
}

const quickstart: DocPage = {
  slug: "quickstart",
  title: "Quickstart",
  group: "Get started",
  description: "Get up and running with YCoding in your development environment in four straightforward steps.",
  sections: [
    {
      heading: "Local environment prerequisites",
      blocks: [{ kind: "callout", tone: "info", title: "Note: Local environment prerequisites", text: "Ensure your project repository is initialized with git and your preferred terminal shell is ready before launching the assistant." }],
    },
    {
      heading: "Run ycoding from your project folder",
      blocks: [
        { kind: "paragraph", text: "Open your terminal, navigate to your project directory, and run the following command to start the session:" },
        { kind: "code", language: "bash", code: "$ cd ~/my-project && ycoding" },
      ],
    },
    {
      heading: "Use /connect to connect a provider",
      blocks: [
        { kind: "paragraph", text: "Inside the interactive interface, use the connect command to authenticate with your preferred provider:" },
        { kind: "code", language: "prompt", code: "> /connect anthropic" },
      ],
    },
    {
      heading: "Choose a model",
      blocks: [
        { kind: "paragraph", text: "Select a supported model option based on your desired workflow and latency characteristics:" },
        {
          kind: "table",
          head: ["Provider", "Recommended Model", "Typical Use Case", "Profile"],
          rows: [
            ["Anthropic", "claude-3-7-sonnet", "Complex Code Refactoring", "Balanced"],
            ["OpenAI", "gpt-4o", "Rapid Implementation", "Fast"],
            ["Ollama", "qwen2.5-coder", "Local & Offline Sessions", "On-Device"],
          ],
        },
      ],
    },
    {
      heading: "Send a prompt",
      blocks: [
        { kind: "paragraph", text: "Type your goal directly into the interface prompt to initiate code assistance:" },
        { kind: "code", language: "prompt", code: "> Add unit tests for the authentication handler function in handler.go" },
      ],
    },
  ],
}

export const DOC_INDEX: DocPage = {
  slug: "",
  title: p10IndexTitle(p10Specimen),
  group: "Get started",
  description: p10IndexLede(p10Specimen),
  sections: [],
}

const configuration = [
  ["agents", "Agents", "Behavioral profiles, roles, and automated reasoning policies."],
  ["models", "Models", "Default model assignment, routing preferences, and fallbacks."],
  ["providers", "Providers", "API connectivity, token quotas, endpoints, and credentials."],
  ["plugins", "Plugins", "Extending core capabilities with community packages."],
  ["mcp", "MCP", "Model Context Protocol integration, server parameters, and tools."],
  ["goal", "Goal", "Defining project objectives, completion criteria, and targets."],
  ["yolo", "YOLO", "Autonomous auto-approval modes for non-interactive execution."],
  ["guardrails", "Guardrails", "Safety limits, command boundaries, and protected directories."],
  ["notifications", "Notifications", "Desktop alerts, webhook dispatches, and audio cues."],
  ["permissions", "Permissions", "Fine-grained file read/write controls and access grants."],
  ["tools", "Tools", "Built-in utility hooks, formatters, linters, and test runners."],
  ["appearance", "Appearance", "Theme variations, typography, font sizing, and UI density."],
] as const

const installation = page("installation", "Installation", "Get started", p10IndexDescription(p10Specimen, 1, "Download instructions, package managers, system prerequisites, and verification steps across operating platforms."))

export const DOC_PAGES: readonly DocPage[] = [
  ...(p10Specimen === undefined
    ? [page("getting-started", "Getting started", "Get started"), installation, quickstart]
    : [{ ...quickstart, description: p10IndexDescription(p10Specimen, 0, quickstart.description) }, installation]),
  page("usage/tui", "Terminal", "Use", p10IndexDescription(p10Specimen, 2, "Interactive terminal controls, navigation keybindings, split pane views, and real-time execution outputs.")),
  page("usage/command-line", "Command line", "Use", p10IndexDescription(p10Specimen, 3, "CLI arguments, flags, environment switches, and programmatic non-interactive batch pipelines.")),
  page("usage/remote", "Remote workspace", "Use", p10IndexDescription(p10Specimen, 4, "Connecting to remote environments, synchronizing project files, and coordinating distant compute instances.")),
  page("usage/sessions", "Sessions", "Use", p10IndexDescription(p10Specimen, 5, "Preserving context states, restoring history buffers, branching session paths, and managing persistent runs.")),
  ...configuration.map(([slug, title, description], index) => page(`configuration/${slug}`, title, "Configuration", p10IndexDescription(p10Specimen, index + 6, description))),
  page("troubleshooting", "Troubleshooting", "Help", p10IndexDescription(p10Specimen, 18, "Diagnosing common issues, resolving connection errors, analyzing operation logs, and getting assistance from community channels.")),
]

export const PUBLIC_DOC_PATHS: readonly string[] = DOC_PAGES.map((entry) => `/docs/${entry.slug}`)

export function findDocPage(slug: string): DocPage | undefined {
  return DOC_PAGES.find((entry) => entry.slug === slug)
}

export function docsByGroup(): readonly { readonly group: DocGroup; readonly pages: readonly DocPage[] }[] {
  return DOC_GROUPS.map((group) => ({ group, pages: DOC_PAGES.filter((entry) => entry.group === group) }))
}

export function slugifyHeading(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

export function sectionId(entry: DocPage, index: number): string {
  return slugifyHeading(entry.sections[index]?.heading ?? "")
}
