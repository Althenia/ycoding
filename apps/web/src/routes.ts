import type { LocationRewrite } from "@tanstack/solid-router"

/** Public site routes; `*slug` is a splat over the published documentation allowlist. */
export const PUBLIC_ROUTE_PATTERNS = ["/", "/docs", "/docs/*slug", "/changelog"] as const

export const REMOTE_ROOT = "/remote"

/** Remote workspace views; every entry has a fixture scenario in `verify/remote-scenarios.ts`. */
export const REMOTE_VIEWS = ["sessions", "session", "projects", "workspaces", "usage", "settings"] as const

export const REMOTE_ROUTE_PATHS = [REMOTE_ROOT, ...REMOTE_VIEWS.map((view) => `${REMOTE_ROOT}/${view}` as const)] as const
export const REMOTE_INVITE_PATH = `${REMOTE_ROOT}/invite`

export function canonicalRemotePath(pathname: string): string {
  return pathname.replace(/^\/remote(?:\/rust)+(?=\/|$)/, REMOTE_ROOT)
}

export function remoteRouteRewrite(): LocationRewrite {
  return {
    input: ({ url }) => {
      const pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1")
      url.pathname = pathname
      return url
    },
  }
}
