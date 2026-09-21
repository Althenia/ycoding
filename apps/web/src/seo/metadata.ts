import { createEffect, type Accessor } from "solid-js"
import { DOC_INDEX, findDocPage } from "../content/docs/registry"
import { SITE } from "../content/site"

/**
 * Route-owned document head metadata.
 *
 * Public routes get a canonical URL on the product origin plus OpenGraph and
 * Twitter summaries; the private workspace and unknown routes get a noindex
 * directive and no canonical, so a signed-in location is never advertised as
 * shareable and no unpublished path is ever canonicalized. One resolver owns
 * every route, so a page cannot ship a title without its matching head tags.
 */

export type HeadTag = {
  readonly tag: "meta" | "link"
  readonly attrs: Readonly<Record<string, string>>
}

export type RouteMetadata =
  | { readonly kind: "public"; readonly title: string; readonly description: string; readonly canonical: string }
  | { readonly kind: "private"; readonly title: string }
  | { readonly kind: "not-found"; readonly title: string }

const OPEN_GRAPH_IMAGE = "/icons/icon-512.png"
const DOCS_TITLE_SUFFIX = `${SITE.productName} docs`

const MANAGED_META_NAMES = ["description", "robots", "twitter:card", "twitter:title", "twitter:description", "twitter:image"] as const
const MANAGED_OPEN_GRAPH_PROPERTIES = [
  "og:type",
  "og:site_name",
  "og:title",
  "og:description",
  "og:url",
  "og:image",
  "og:image:alt",
] as const

export function resolveRouteMetadata(path: string): RouteMetadata {
  if (path === "/") return publicRoute(path, `${SITE.productName} — ${SITE.descriptor}`, SITE.description)
  if (path === "/docs") return publicRoute(path, `${DOC_INDEX.title} — ${SITE.productName}`, DOC_INDEX.description)
  if (path === "/changelog") {
    return publicRoute(path, `Changelog — ${SITE.productName}`, SITE.metadata.changelogDescription)
  }
  if (path.startsWith("/docs/")) {
    const page = findDocPage(path.slice("/docs/".length))
    if (page) return publicRoute(path, `${page.title} — ${DOCS_TITLE_SUFFIX}`, page.description)
    return { kind: "not-found", title: `Not found — ${DOCS_TITLE_SUFFIX}` }
  }
  if (path === "/remote" || path.startsWith("/remote/")) {
    return { kind: "private", title: `Remote workspace — ${SITE.productName}` }
  }
  return { kind: "not-found", title: `Not found — ${SITE.productName}` }
}

/** Describes the head tags the resolver owns for one route. */
export function headMetadata(metadata: RouteMetadata): readonly HeadTag[] {
  if (metadata.kind !== "public") return [{ tag: "meta", attrs: { name: "robots", content: "noindex,nofollow" } }]

  const image = `${SITE.origin}${OPEN_GRAPH_IMAGE}`
  return [
    { tag: "link", attrs: { rel: "canonical", href: metadata.canonical } },
    { tag: "meta", attrs: { name: "description", content: metadata.description } },
    { tag: "meta", attrs: { name: "robots", content: "index,follow" } },
    { tag: "meta", attrs: { property: "og:type", content: "website" } },
    { tag: "meta", attrs: { property: "og:site_name", content: SITE.productName } },
    { tag: "meta", attrs: { property: "og:title", content: metadata.title } },
    { tag: "meta", attrs: { property: "og:description", content: metadata.description } },
    { tag: "meta", attrs: { property: "og:url", content: metadata.canonical } },
    { tag: "meta", attrs: { property: "og:image", content: image } },
    { tag: "meta", attrs: { property: "og:image:alt", content: `${SITE.productName} ${SITE.descriptor}` } },
    { tag: "meta", attrs: { name: "twitter:card", content: "summary" } },
    { tag: "meta", attrs: { name: "twitter:title", content: metadata.title } },
    { tag: "meta", attrs: { name: "twitter:description", content: metadata.description } },
    { tag: "meta", attrs: { name: "twitter:image", content: image } },
  ]
}

/**
 * Replaces the route-owned head tags so navigation cannot leave stale metadata
 * behind: every managed tag is removed before the current route's set is added.
 * The static tags in index.html are managed by the same selectors, so the first
 * client render reconciles them instead of duplicating them.
 */
export function applyDocumentMetadata(metadata: RouteMetadata, target: Document = window.document): void {
  target.title = metadata.title
  const head = target.head
  for (const name of MANAGED_META_NAMES) removeAll(head, `meta[name="${name}"]`)
  for (const property of MANAGED_OPEN_GRAPH_PROPERTIES) removeAll(head, `meta[property="${property}"]`)
  removeAll(head, 'link[rel="canonical"]')
  for (const tag of headMetadata(metadata)) {
    const element = target.createElement(tag.tag)
    for (const [attribute, value] of Object.entries(tag.attrs)) element.setAttribute(attribute, value)
    head.appendChild(element)
  }
}

function removeAll(head: HTMLHeadElement, selector: string): void {
  for (const element of head.querySelectorAll(selector)) element.remove()
}

/** Applies the metadata for the current route on load and on every navigation. */
export function useRouteMetadata(path: Accessor<string>): void {
  createEffect(() => {
    applyDocumentMetadata(resolveRouteMetadata(path()))
  })
}

function publicRoute(path: string, title: string, description: string): RouteMetadata {
  return { kind: "public", title, description, canonical: `${SITE.origin}${path}` }
}
