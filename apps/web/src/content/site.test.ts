import { describe, expect, test } from "bun:test"
import { SITE } from "./site"

describe("public landing copy", () => {
  test("keeps the approved terminal-first hero, real install command, and four current capabilities", () => {
    expect(SITE.hero).toMatchObject({
      headline: "Your coding agent. Your machine.",
      support: "Work in the terminal. Continue from your browser.",
      primaryAction: { label: "Get started", href: "/docs/getting-started" },
      secondaryAction: { label: "Open workspace", href: "/remote" },
    })
    expect(SITE.installing.command).toBe("curl -fsSL https://ycoding.althenia.app/install.sh | sh")
    expect(SITE.features.map((feature) => feature.title)).toEqual([
      "Durable Sessions",
      "Explicit autonomy",
      "Tools and approvals",
      "Remote access",
    ])
  })

  test("retains public install, security, and license destinations in the compact footer", () => {
    const links = SITE.footerColumns.flatMap((column) => column.links.map((link) => ({ label: String(link.label), href: String(link.href) })))
    expect(links).toEqual(
      expect.arrayContaining([
        { label: "Install", href: "/docs/installation" },
        { label: "License", href: SITE.licenseURL },
        { label: "Security", href: SITE.securityURL },
      ]),
    )
  })
})
