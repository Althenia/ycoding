/**
 * Worker entry for `ycoding-cloud`.
 *
 * Surface:
 * - `GET /health` liveness probe.
 * - `/api/auth/*`, `/api/me`, `/api/devices/*` authentication and device metadata.
 * - `/ws/agent` bearer-authenticated local agent relay socket.
 * - `/ws/client` cookie-authenticated browser relay socket.
 * - everything else is served from the asset binding (landing, docs, changelog,
 *   and the `/remote/*` SPA owned by the web lane).
 *
 * There is no unauthenticated relay path. Sign-in is restricted to the
 * server-side `GOOGLE_ALLOWED_EMAILS` allowlist and fails closed when unset.
 */

import { parseAllowedEmails } from "./auth/allowlist"
import { googleEndpoints } from "./auth/google"
import { createD1AuthStore } from "./auth/d1-store"
import { createAuthService } from "./auth/service"
import type { WorkerEnv } from "./env"
import { DeviceRelay } from "./relay/durable-object"
import { boundedCleanupInterval, createRouter } from "./router"

export { DeviceRelay }

let router: ((request: Request) => Promise<Response>) | undefined

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    router ??= createRouter({
      service: createAuthService(createD1AuthStore(env.DB)),
      relay: env.DEVICE_RELAY,
      endpoints: googleEndpoints(env),
      allowedEmails: parseAllowedEmails(env),
      cleanupEveryMs: boundedCleanupInterval(env.CLEANUP_INTERVAL_MS),
      // Bind to a local: workerd rejects calling the global fetch as a member reference.
      fetch: (input, init) => globalThis.fetch(input, init),
      ...(env.ASSETS === undefined ? {} : { assets: env.ASSETS }),
    })
    return router(request)
  },

  /** Scheduled sweep of expired authentication metadata (no session content). */
  async scheduled(_controller: ScheduledController, env: WorkerEnv): Promise<void> {
    await createAuthService(createD1AuthStore(env.DB)).cleanup()
  },
}
