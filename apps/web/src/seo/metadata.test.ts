import { describe, expect, test } from "bun:test"
import { PUBLIC_DOC_PATHS, findDocPage } from "../content/docs/registry"
import { SITE } from "../content/site"
import { parseLocation } from "../router/route"
import { headMetadata, resolveRouteMetadata, type HeadTag } from "./metadata"

const REMOTE_ROUTES = ["/remote", "/remote/sessions", "/remote/activity", "/remote/settings"] as const

function attrsFor(tags: readonly HeadTag[], key: { readonly name?: string; readonly property?: string; readonly rel?: string }) {
  return tags.filter((tag) => {
    if (key.rel !== undefined) return tag.tag === "link" && tag.attrs.rel === key.rel
    if (key.property !== undefined) return tag.tag === "meta" && tag.attrs.property === key.property
    return tag.tag === "meta" && tag.attrs.name === key.name
  })
}

describe("route metadata resolution", () => {
  test("marks every published public route indexable with its canonical origin path", () => {
    for (const path of ["/", "/docs", "/changelog", ...PUBLIC_DOC_PATHS]) {
      const metadata = resolveRouteMetadata(path)
      expect({ path, kind: metadata.kind }).toEqual({ path, kind: "public" })
      if (metadata.kind !== "public") throw new Error(`expected public metadata for ${path}`)
      expect(metadata.canonical).toBe(`${SITE.origin}${path}`)
      expect(metadata.title.length).toBeGreaterThan(0)
      expect(metadata.description.length).toBeGreaterThan(20)
    }
  })

  test("keeps the existing visible titles for public pages", () => {
    expect(resolveRouteMetadata("/").title).toBe(`${SITE.productName} — ${SITE.descriptor}`)
    expect(resolveRouteMetadata("/docs").title).toBe(`Documentation — ${SITE.productName}`)
    expect(resolveRouteMetadata("/changelog").title).toBe(`Changelog — ${SITE.productName}`)
    const page = findDocPage("configuration/guardrails")
    expect(resolveRouteMetadata("/docs/configuration/guardrails").title).toBe(
      `${page?.title} — ${SITE.productName} docs`,
    )
  })

  test("marks every remote workspace route private without a canonical origin", () => {
    for (const path of REMOTE_ROUTES) {
      const metadata = resolveRouteMetadata(path)
      expect({ path, kind: metadata.kind }).toEqual({ path, kind: "private" })
      expect(metadata).not.toHaveProperty("canonical")
      expect(metadata).not.toHaveProperty("description")
      expect(metadata.title.length).toBeGreaterThan(0)
    }
  })

  test("treats unknown and unpublished documentation routes as not found", () => {
    for (const path of ["/unknown", "/docs/does-not-exist", "/docs/installation/extra", "/docs/architecture"]) {
      const metadata = resolveRouteMetadata(path)
      expect({ path, kind: metadata.kind }).toEqual({ path, kind: "not-found" })
      expect(metadata).not.toHaveProperty("canonical")
    }
  })

  test("never carries query or fragment content from the location into canonical metadata", () => {
    const secretDocument = parseLocation("/docs/installation?token=sk-live-route-secret#fragment").path
    const metadata = resolveRouteMetadata(secretDocument)
    expect(metadata.kind).toBe("public")
    if (metadata.kind !== "public") throw new Error("expected public metadata")
    expect(metadata.canonical).toBe(`${SITE.origin}/docs/installation`)

    const privateMetadata = resolveRouteMetadata(parseLocation("/remote/sessions?session=abc123#panel").path)
    expect(privateMetadata).not.toHaveProperty("canonical")

    const serialized = JSON.stringify(headMetadata(metadata))
    expect(serialized).not.toContain("sk-live-route-secret")
    expect(serialized).not.toContain("token=")
    expect(serialized).not.toContain("#fragment")
  })
})

describe("document head metadata", () => {
  test("emits exactly one canonical link, one description, and one robots directive", () => {
    const tags = headMetadata(resolveRouteMetadata("/docs/quickstart"))
    expect(attrsFor(tags, { rel: "canonical" })).toEqual([
      { tag: "link", attrs: { rel: "canonical", href: `${SITE.origin}/docs/quickstart` } },
    ])
    expect(attrsFor(tags, { name: "description" })).toHaveLength(1)
    expect(attrsFor(tags, { name: "robots" })).toEqual([
      { tag: "meta", attrs: { name: "robots", content: "index,follow" } },
    ])
  })

  test("publishes an OpenGraph and Twitter summary for indexable routes", () => {
    const metadata = resolveRouteMetadata("/")
    const tags = headMetadata(metadata)
    expect(attrsFor(tags, { property: "og:type" })[0]?.attrs.content).toBe("website")
    expect(attrsFor(tags, { property: "og:site_name" })[0]?.attrs.content).toBe(SITE.productName)
    expect(attrsFor(tags, { property: "og:title" })[0]?.attrs.content).toBe(metadata.title)
    expect(attrsFor(tags, { property: "og:description" })[0]?.attrs.content).toBe(
      metadata.kind === "public" ? metadata.description : "",
    )
    expect(attrsFor(tags, { property: "og:url" })[0]?.attrs.content).toBe(`${SITE.origin}/`)
    expect(attrsFor(tags, { property: "og:image" })[0]?.attrs.content).toBe(`${SITE.origin}/icons/icon-512.png`)
    expect(attrsFor(tags, { name: "twitter:card" })[0]?.attrs.content).toBe("summary")
    expect(attrsFor(tags, { name: "twitter:title" })[0]?.attrs.content).toBe(metadata.title)
    expect(attrsFor(tags, { name: "twitter:image" })[0]?.attrs.content).toBe(`${SITE.origin}/icons/icon-512.png`)
  })

  test("emits only a noindex directive for private and not-found routes", () => {
    for (const path of ["/remote/settings", "/unknown", "/docs/does-not-exist"]) {
      const tags = headMetadata(resolveRouteMetadata(path))
      expect({ path, tags }).toEqual({
        path,
        tags: [{ tag: "meta", attrs: { name: "robots", content: "noindex,nofollow" } }],
      })
    }
  })

})
