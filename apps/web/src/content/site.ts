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
  tagline: "Your coding agent. Your machine.",
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
    headline: "Your coding agent. Your machine.",
    support: "Work in the terminal. Continue from your browser.",
    primaryAction: { label: "Get started", href: "/docs/getting-started" },
    secondaryAction: { label: "Open workspace", href: "/remote" },
  },
  features: [
    {
      title: "Durable Sessions",
      text: "Long-running agent workflows persist across connection drops, device switches, and system restarts.",
    },
    {
      title: "Explicit autonomy",
      text: "Set precise guardrails and permission tiers so your agent takes only actions you explicitly authorize.",
    },
    {
      title: "Tools and approvals",
      text: "Review and approve tool calls, code modifications, and terminal executions with clear interactive inspection.",
    },
    {
      title: "Remote access",
      text: "Monitor and control Sessions from your browser while YCoding runs on your machine.",
    },
  ],
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
