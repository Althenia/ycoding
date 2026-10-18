import { createD1AuthStore } from "./auth/d1-store"
import { createD1McpStore } from "./auth/mcp/d1-store"
import { createMcpClientResolver } from "./auth/mcp/client"
import { createMcpAuthService } from "./auth/mcp/service"
import { googleEndpoints } from "./auth/google"
import { parseAllowedEmails } from "./auth/allowlist"
import type { AuthService } from "./auth/service"
import type { WorkerEnv } from "./env"
import { createMcpRouter } from "./mcp-router"
import { forwardMcpRequest } from "./mcp-forward"

export function createRelayMcpRoutes(env: WorkerEnv, service: AuthService) {
  const routes = new Map<string, ReturnType<typeof createMcpRouter>>()
  const store = createD1McpStore(env.DB)
  const authStore = createD1AuthStore(env.DB)
  return async (request: Request, rateLimit: (key: string) => boolean) => {
    const url = new URL(request.url)
    if (!(url.pathname === "/.well-known" || url.pathname.startsWith("/.well-known/") || url.pathname === "/api/mcp" || url.pathname.startsWith("/api/mcp/"))) return undefined
    let route = routes.get(url.origin)
    if (!route) {
      const clients = createMcpClientResolver({ store, issuer: url.origin, fetch: (input, init) => fetch(input, init) })
      const auth = createMcpAuthService({ store, issuer: url.origin, resolveClient: clients.resolve,
        authorizeDevice: service.authorizeAgentCommand,
        resolveOwner: (subject) => authStore.findOrCreateUser("google", subject, Date.now()) })
      route = createMcpRouter({ issuer: url.origin, auth, clients, endpoints: googleEndpoints(env),
        allowedEmails: parseAllowedEmails(env), fetch: (input, init) => fetch(input, init), rateLimit,
        deviceName: async (ownerID, deviceID) => {
          const device = await authStore.findDevice(deviceID)
          return device?.userID === ownerID && device.revokedAt === undefined ? device.name : undefined
        },
        forward: (principal, incoming) => forwardMcpRequest(env.DEVICE_RELAY, principal, incoming),
      })
      if (routes.size >= 8) routes.delete(routes.keys().next().value!)
      routes.set(url.origin, route)
    }
    return route(request)
  }
}
