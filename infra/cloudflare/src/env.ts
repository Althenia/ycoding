/** Worker bindings plus the Google configuration the relay needs. */
export type WorkerEnv = {
  readonly DB: D1Database
  readonly DEVICE_RELAY: DurableObjectNamespace
  /** Static assets built by the web lane (landing, docs, changelog, remote SPA). */
  readonly ASSETS: Fetcher
  readonly GOOGLE_CLIENT_ID?: string
  readonly GOOGLE_CLIENT_SECRET?: string
  /**
   * Server-only sign-in allowlist: comma, whitespace, or newline separated Google
   * email addresses. Missing or empty denies every sign-in. Never returned to a
   * client and never logged.
   */
  readonly GOOGLE_ALLOWED_EMAILS?: string
  /** Optional sweep cadence override, clamped to a bounded range. */
  readonly CLEANUP_INTERVAL_MS?: string
  /** Test-only overrides; production uses the Google endpoints. */
  readonly GOOGLE_ISSUER?: string
  readonly GOOGLE_AUTHORIZATION_ENDPOINT?: string
  readonly GOOGLE_TOKEN_ENDPOINT?: string
  readonly GOOGLE_JWKS_URI?: string
}
