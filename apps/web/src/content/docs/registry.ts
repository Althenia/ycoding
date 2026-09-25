import { configurationPages } from "./pages/configuration"
import { gettingStartedPages } from "./pages/getting-started"
import { helpPages } from "./pages/help"
import { usePages } from "./pages/use"
import { DOC_GROUPS, type DocGroup, type DocPage } from "./types"

export { DOC_GROUPS } from "./types"

/** Landing page for `/docs`. Not part of the page allowlist or search results. */
export const DOC_INDEX: DocPage = {
  slug: "",
  title: "Documentation",
  group: "Get started",
  description: "Install YCoding, run your first session, and configure the runtime for your machine.",
  sections: [
    {
      heading: "Start here",
      blocks: [
        {
          kind: "paragraph",
          text: "YCoding is a terminal coding agent. The terminal application is the primary surface: it owns sessions, tool execution, permissions, and model requests on your own machine.",
        },
        {
          kind: "steps",
          items: [
            { title: "Install", text: "Install a checksum-verified release build, or run from a checkout with Bun 1.4.2." },
            { title: "Connect a provider", text: "Add credentials for at least one model provider so requests can run." },
            { title: "Start a session", text: "Run `ycoding` for the terminal interface, or pass a prompt for one direct run." },
          ],
        },
        {
          kind: "cards",
          items: [
            { title: "Getting started", text: "What YCoding is and how the pieces fit together.", href: "/docs/getting-started" },
            { title: "Installation", text: "Install a release, verify it, and keep it updated.", href: "/docs/installation" },
            { title: "Quickstart", text: "From install to a first answer in a few minutes.", href: "/docs/quickstart" },
            { title: "Working in the terminal", text: "Sessions, prompts, approvals, and the composer.", href: "/docs/usage/tui" },
          ],
        },
      ],
    },
    {
      heading: "Configuration domains",
      blocks: [
        {
          kind: "paragraph",
          text: "Runtime configuration lives in `ycoding.json` or `ycoding.jsonc`. Terminal preferences live in `cli.json`. Each domain below documents the fields it controls, the defaults, and worked examples.",
        },
        {
          kind: "cards",
          items: [
            { title: "Agents", text: "Built-in and custom agents, modes, step limits, and colors.", href: "/docs/configuration/agents" },
            { title: "Models", text: "Model entries, variants, capability declarations, and limits.", href: "/docs/configuration/models" },
            { title: "Providers", text: "Provider entries, credential variable names, and profiles.", href: "/docs/configuration/providers" },
            { title: "Plugins", text: "Runtime plugin ordering, options, and hook ownership.", href: "/docs/configuration/plugins" },
            { title: "MCP", text: "Local and remote servers, timeouts, and OAuth.", href: "/docs/configuration/mcp" },
            { title: "Goal", text: "Objectives, continuation, and terminal goal states.", href: "/docs/configuration/goal" },
            { title: "YOLO mode", text: "Tiered autonomous execution and what each level answers.", href: "/docs/configuration/yolo" },
            { title: "Guardrails", text: "Session-family reviews, caps, and custom rule files.", href: "/docs/configuration/guardrails" },
            { title: "Notifications", text: "Attention categories, sounds, and the ntfy tool.", href: "/docs/configuration/notifications" },
            { title: "Permissions", text: "Ordered tool rules, effects, and inheritance.", href: "/docs/configuration/permissions" },
            { title: "Tools", text: "Tool surfaces, output bounds, and shell resource limits.", href: "/docs/configuration/tools" },
            { title: "Appearance", text: "Themes, keybindings, scroll, and mouse behavior.", href: "/docs/configuration/appearance" },
          ],
        },
      ],
    },
    {
      heading: "Help",
      blocks: [
        {
          kind: "paragraph",
          text: "Configuration discovery, rejected keys, and provider failures have specific diagnostics. The troubleshooting page lists the checks that resolve most reported problems.",
        },
        {
          kind: "cards",
          items: [
            { title: "Troubleshooting", text: "Diagnose configuration, provider, and database problems.", href: "/docs/troubleshooting" },
            { title: "Remote workspace", text: "What the remote workspace needs before it shows real sessions.", href: "/docs/usage/remote" },
          ],
        },
      ],
    },
  ],
}

export const DOC_PAGES: readonly DocPage[] = [
  ...gettingStartedPages,
  ...usePages,
  ...configurationPages,
  ...helpPages,
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
