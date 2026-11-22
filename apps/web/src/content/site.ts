/**
 * Canonical public site copy.
 *
 * Every user-visible claim on the public pages lives here so the publication
 * boundary test can scan one surface. Facts match the repository's current
 * product state: terminal-first, local execution, remote access available with
 * an account and an enrolled device.
 */

import { RUST_REMOTE_SHELL } from "../pwa/offline"
import { REMOTE_ROOT } from "../routes"

const releasesURL = "https://github.com/Althenia/ycoding/releases"

export const SITE = {
  productName: "YCoding",
  descriptor: "terminal coding agent",
  origin: "https://ycoding.althenia.app",
  tagline: "Your coding agent. Your machine.",
  description:
    "YCoding runs a coding agent on your own machine with durable sessions, explicit autonomy, and repository-native customization.",
  repositoryURL: "https://github.com/Althenia/ycoding",
  releasesURL,
  licenseURL: "https://github.com/Althenia/ycoding/blob/main/LICENSE",
  securityURL: "https://github.com/Althenia/ycoding/blob/main/SECURITY.md",
  docsURL: "/docs",
  changelogURL: "/changelog",
  remoteURL: REMOTE_ROOT,
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
    workspaceActions: [
      { label: "Bun workspace", href: REMOTE_ROOT },
      { label: "Rust workspace", href: RUST_REMOTE_SHELL },
    ],
  },
  features: [
    {
      icon: "sessions",
      title: "Durable Sessions",
      text: "Long-running agent workflows persist across connection drops, device switches, and system restarts.",
    },
    {
      icon: "shield",
      title: "Explicit autonomy",
      text: "Set precise guardrails and permission tiers so your agent takes only actions you explicitly authorize.",
    },
    {
      icon: "terminal",
      title: "Tools and approvals",
      text: "Review and approve tool calls, code modifications, and terminal executions with clear interactive inspection.",
    },
    {
      icon: "monitor",
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
        { label: "Remote workspace", href: REMOTE_ROOT },
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
        { label: "Releases", href: releasesURL },
        { label: "License", href: "https://github.com/Althenia/ycoding/blob/main/LICENSE" },
        { label: "Security", href: "https://github.com/Althenia/ycoding/blob/main/SECURITY.md" },
      ],
    },
  ],
} as const
