import { describe, expect, test } from "bun:test"
import { SITE } from "./site"

describe("public landing copy", () => {
  test("keeps the approved terminal-first hero, real install command, and four current capabilities", () => {
    expect(SITE.hero).toMatchObject({
      headline: "Your coding agent. Your machine.",
      support: "Work in the terminal. Continue from your browser.",
      primaryAction: { label: "Get started", href: "/docs/getting-started" },
      workspaceActions: [
        { label: "Open workspace", href: "/remote" },
      ],
    })
    expect(SITE.installing.command).toBe("curl -fsSL https://ycoding.althenia.app/install.sh | sh")
    expect(SITE.features.map((feature) => feature.title)).toEqual([
      "Durable Sessions",
      "Explicit autonomy",
      "Tools and approvals",
      "Remote access",
    ])
  })

  test("links to both release editions and retains install, security, and license destinations", () => {
    expect(SITE.releasesURL).toBe("https://github.com/Althenia/ycoding/releases")
    const links = SITE.footerColumns.flatMap((column) => column.links.map((link) => ({ label: String(link.label), href: String(link.href) })))
    expect(links).toEqual(
      expect.arrayContaining([
        { label: "Install", href: "/docs/installation" },
        { label: "Releases", href: SITE.releasesURL },
        { label: "License", href: SITE.licenseURL },
        { label: "Security", href: SITE.securityURL },
      ]),
    )
  })
})
