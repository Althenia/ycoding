import type { LocationRewrite } from "@tanstack/solid-router"
import { remoteShellPath, RUST_REMOTE_SHELL, type RemoteShellPath } from "./pwa/offline"

/** Public site routes; `*slug` is a splat over the published documentation allowlist. */
export const PUBLIC_ROUTE_PATTERNS = ["/", "/docs", "/docs/*slug", "/changelog"] as const

export const REMOTE_ROOT = "/remote"

/** Remote workspace views; every entry has a fixture scenario in `verify/remote-scenarios.ts`. */
export const REMOTE_VIEWS = ["sessions", "session", "projects", "workspaces", "usage", "settings"] as const

export const REMOTE_ROUTE_PATHS = [REMOTE_ROOT, ...REMOTE_VIEWS.map((view) => `${REMOTE_ROOT}/${view}` as const)] as const
export const REMOTE_INVITE_PATH = `${REMOTE_ROOT}/invite`

type Under<Path extends string> = Path | `${Path}/${string}`

function under<Path extends string>(pathname: string, root: Path): pathname is Under<Path> {
  return pathname === root || pathname.startsWith(`${root}/`)
}

export function remoteWorkspaceRoot(pathname: string): RemoteShellPath {
  return remoteShellPath(pathname) ?? REMOTE_ROOT
}

export function remoteDocumentPath(pathname: Under<typeof REMOTE_ROOT>, root: RemoteShellPath): Under<RemoteShellPath> {
  return pathname === REMOTE_ROOT ? root : `${root}/${pathname.slice(REMOTE_ROOT.length + 1)}`
}

export function remoteRouteRewrite(root: RemoteShellPath): LocationRewrite {
  return {
    input: ({ url }) => {
      const pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1")
      url.pathname = remoteShellPath(pathname) === RUST_REMOTE_SHELL ? `${REMOTE_ROOT}${pathname.slice(RUST_REMOTE_SHELL.length)}` : pathname
      return url
    },
    output: ({ url }) => {
      if (root === REMOTE_ROOT || !under(url.pathname, REMOTE_ROOT)) return undefined
      const publicURL = new URL(url)
      publicURL.pathname = remoteDocumentPath(url.pathname, root)
      return publicURL
    },
  }
}
