/**
 * Canonical public site copy.
 *
 * Every user-visible claim on the public pages lives here so the publication
 * boundary test can scan one surface. Facts match the repository's current
 * product state: terminal-first, local execution, remote access available with
 * an account and an enrolled device.
 */

export const SITE = {
  productName: "YCoding",
  descriptor: "terminal coding agent",
  origin: "https://ycoding.althenia.app",
  tagline: "Your coding agent, wherever you are.",
  description:
    "YCoding runs a coding agent on your own machine with durable sessions, explicit autonomy, and repository-native customization.",
  repositoryURL: "https://github.com/Althenia/ycoding",
  releasesURL: "https://github.com/Althenia/ycoding/releases/latest",
  licenseURL: "https://github.com/Althenia/ycoding/blob/main/LICENSE",
  securityURL: "https://github.com/Althenia/ycoding/blob/main/SECURITY.md",
  docsURL: "/docs",
  changelogURL: "/changelog",
  remoteURL: "/remote",
  metadata: {
    changelogDescription:
      "Every YCoding release with its user-visible changes, filterable by year and change type.",
  },
  installing: {
    command: "curl -fsSL https://ycoding.althenia.app/install.sh | sh",
    scriptPath: "/install.sh",
    schemaPath: "/ycoding.schema.json",
    examplePath: "/examples/ycoding.jsonc",
    platforms: ["macOS", "Linux", "Windows"],
  },
  hero: {
    eyebrow: ["AI agents", "Your machine", "Anywhere"],
    headline: "Your coding agent, wherever you are.",
    support: [
      "Work with AI agents on your own machine.",
      "Same environment. Same tools. Same session history.",
    ],
    primaryAction: { label: "Open Remote", href: "/remote" },
    secondaryAction: { label: "Install YCoding", href: "/docs/installation" },
    footnote: "macOS, Linux, and Windows releases publish from the same repository as the source.",
  },
  features: [
    { icon: "terminal", title: "Agents", text: "Specialized agents for real work, selectable per session." },
    { icon: "puzzle", title: "Plugins", text: "Extend the runtime with tools, hooks, and integrations." },
    { icon: "target", title: "Goal", text: "Turn one objective into tracked, resumable work." },
    { icon: "shield", title: "Guardrails", text: "Review high-impact actions across the session family." },
    { icon: "bell", title: "Notifications", text: "Ask for attention when work needs a human decision." },
    { icon: "devices", title: "Remote Access", text: "Continue the same session from another device." },
  ],
  trust: [
    {
      title: "Local execution",
      text: "The agent, shell, files, and model calls run on your machine. Nothing is hosted for you.",
    },
    {
      title: "Durable sessions",
      text: "History, pending input, and orchestration survive restarts and reconnects.",
    },
    {
      title: "Open source",
      text: "The runtime, terminal client, and configuration schema ship under the MIT license.",
    },
  ],
  remoteStatus: {
    title: "Remote access from any browser.",
    body: "Sign in at /remote and control a session running on your own machine: sessions, approvals, guardrail reviews, autonomy, and alerts. It needs a signed-in account and an enrolled device, so without them it stays honestly empty instead of showing sample conversations.",
    cta: { label: "Read the remote guide", href: "/docs/usage/remote" },
  },
  footerColumns: [
    {
      title: "Product",
      links: [
        { label: "Documentation", href: "/docs" },
        { label: "Changelog", href: "/changelog" },
        { label: "Remote workspace", href: "/remote" },
        { label: "Install", href: "/docs/installation" },
      ],
    },
    {
      title: "Guides",
      links: [
        { label: "Getting started", href: "/docs/getting-started" },
        { label: "Configuration", href: "/docs/configuration" },
        { label: "Permissions", href: "/docs/configuration/permissions" },
        { label: "Troubleshooting", href: "/docs/troubleshooting" },
      ],
    },
    {
      title: "Project",
      links: [
        { label: "GitHub", href: "https://github.com/Althenia/ycoding" },
        { label: "Releases", href: "https://github.com/Althenia/ycoding/releases/latest" },
        { label: "License", href: "https://github.com/Althenia/ycoding/blob/main/LICENSE" },
        { label: "Security", href: "https://github.com/Althenia/ycoding/blob/main/SECURITY.md" },
      ],
    },
  ],
} as const
