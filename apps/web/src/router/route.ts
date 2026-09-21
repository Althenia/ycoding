export type RouteParams = Record<string, string>

export type ParsedLocation = {
  readonly path: string
  readonly hash: string
}

/**
 * Splits a browser location into a normalized pathname and a decoded hash.
 * Query strings are dropped: every route in this application is path-addressed
 * except in-page documentation anchors.
 */
export function parseLocation(input: string): ParsedLocation {
  const hashIndex = input.indexOf("#")
  const hash = hashIndex >= 0 ? safeDecode(input.slice(hashIndex + 1)) : ""
  const withoutHash = hashIndex >= 0 ? input.slice(0, hashIndex) : input
  const queryIndex = withoutHash.indexOf("?")
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash
  return { path: normalizePath(pathname), hash }
}

export function normalizePath(input: string): string {
  const segments = input
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(safeDecode)
  return segments.length === 0 ? "/" : `/${segments.join("/")}`
}

/**
 * Matches one route pattern against a pathname.
 * `:name` captures exactly one segment; a trailing `*name` captures one or more.
 */
export function matchPath(pattern: string, pathname: string): RouteParams | null {
  const patternSegments = segmentsOf(pattern)
  const pathSegments = segmentsOf(pathname)
  const params: RouteParams = {}

  for (const [index, patternSegment] of patternSegments.entries()) {
    if (patternSegment.startsWith("*")) {
      const rest = pathSegments.slice(index)
      if (rest.length === 0) return null
      const name = patternSegment.slice(1)
      if (name.length > 0) params[name] = rest.join("/")
      return params
    }

    const pathSegment = pathSegments[index]
    if (pathSegment === undefined) return null

    if (patternSegment.startsWith(":")) {
      params[patternSegment.slice(1)] = pathSegment
      continue
    }

    if (patternSegment !== pathSegment) return null
  }

  return pathSegments.length === patternSegments.length ? params : null
}

export function matchRoutes<TRoute extends { readonly path: string }>(
  routes: readonly TRoute[],
  pathname: string,
): { readonly route: TRoute; readonly params: RouteParams } | null {
  const path = normalizePath(pathname)
  for (const route of routes) {
    const params = matchPath(route.path, path)
    if (params) return { route, params }
  }
  return null
}

function segmentsOf(value: string): string[] {
  return value
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(safeDecode)
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
