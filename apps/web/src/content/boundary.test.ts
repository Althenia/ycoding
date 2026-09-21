import { describe, expect, test } from "bun:test"
import { RELEASES } from "./changelog"
import { DOC_INDEX, DOC_PAGES } from "./docs/registry"
import { SITE } from "./site"

// Publication boundary for every user-visible public surface on this site.
// Each entry is an internal detail the public docs and marketing copy must not expose.
const FORBIDDEN_PUBLIC_PATTERNS: readonly { readonly pattern: RegExp; readonly detail: string }[] = [
  { pattern: /\bDurable Objects?\b/, detail: "relay implementation topology" },
  { pattern: /\bD1\b/, detail: "hosted database name" },
  { pattern: /cloudflare/i, detail: "hosting provider topology" },
  { pattern: /wrangler|miniflare/i, detail: "deployment tooling" },
  { pattern: /workers\.dev/i, detail: "development hostnames" },
  { pattern: /\bDeviceRelay\b/, detail: "relay class name" },
  { pattern: /session_pending|session\.context\.observed/, detail: "internal event vocabulary" },
  { pattern: /packages\/|apps\//, detail: "internal repository layout" },
  { pattern: /specs\/v2|docs\/okf|docs\/releases|\.okf\b/, detail: "internal documentation sources" },
  // `@ycoding-ai/plugin` is the documented public extension API; other package names are internal.
  { pattern: /@ycoding-ai\/(?!plugin\b)[a-z-]+/, detail: "internal package names" },
  { pattern: /\bmilestone\b|\bworkplan\b|\broadmap\b/i, detail: "internal delivery planning" },
  { pattern: /\bWIP\b|\bTODO\b/, detail: "unfinished-work markers" },
  { pattern: /prompt[- ]cache namespace|cache-invalidation vocabulary/i, detail: "internal cache implementation" },
  { pattern: /test-user|test-device/, detail: "development smoke identities" },
]

const PUBLIC_SURFACES = [
  { name: "documentation index", content: JSON.stringify(DOC_INDEX) },
  { name: "documentation pages", content: JSON.stringify(DOC_PAGES) },
  { name: "changelog", content: JSON.stringify(RELEASES) },
  { name: "site copy", content: JSON.stringify(SITE) },
] as const

describe("public publication boundary", () => {
  test("detects planted internal details, so the scan is discriminating", () => {
    const canary = "The Durable Object stores state in D1 behind a wrangler deploy."
    const violations = FORBIDDEN_PUBLIC_PATTERNS.filter((rule) => rule.pattern.test(canary))
    expect(violations.length).toBeGreaterThanOrEqual(3)
  })

  test("exposes no internal architecture, topology, or planning detail", () => {
    for (const surface of PUBLIC_SURFACES) {
      for (const rule of FORBIDDEN_PUBLIC_PATTERNS) {
        expect({ surface: surface.name, detail: rule.detail, matched: rule.pattern.test(surface.content) }).toEqual({
          surface: surface.name,
          detail: rule.detail,
          matched: false,
        })
      }
    }
  })

  test("keeps private or credential-shaped values out of public copy", () => {
    for (const surface of PUBLIC_SURFACES) {
      expect(surface.content).not.toMatch(/sk-[A-Za-z0-9]{10,}/)
      expect(surface.content).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{10,}/)
      expect(surface.content).not.toMatch(/\/Users\/[A-Za-z0-9._-]+/)
      expect(surface.content).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    }
  })
})
