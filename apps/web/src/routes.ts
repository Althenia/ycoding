/** Public site routes; `*slug` is a splat over the published documentation allowlist. */
export const PUBLIC_ROUTE_PATTERNS = ["/", "/docs", "/docs/*slug", "/changelog"] as const

/** Remote workspace views; every entry has a fixture scenario in `verify/remote-scenarios.ts`. */
export const REMOTE_VIEWS = ["sessions", "session", "usage", "settings"] as const

export const REMOTE_ROUTE_PATHS = ["/remote", ...REMOTE_VIEWS.map((view) => `/remote/${view}` as const)] as const

export const REMOTE_INVITE_PATH = "/remote/invite"
