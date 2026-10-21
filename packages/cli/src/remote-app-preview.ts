export * as RemoteAppPreviewHost from "./remote-app-preview"

import { RemoteAppPreview, sha256Hex, type PreviewInput, type PreviewResult } from "@ycoding-ai/remote"
import type { RemoteLocalApp } from "./remote-local-app"
import { RemoteMcpApps } from "./remote-mcp-apps"

export type Config = {
  readonly origins: readonly string[]
  readonly ports: readonly number[]
  readonly frameAncestors: readonly string[]
}
export type Allocation = { readonly origin: string } | { readonly reason: "exhausted" | "rejected" }
export type Relay = {
  readonly enabled: () => boolean
  readonly allocate: (input: { registration: string; expiresAt: number }) => Promise<Allocation>
  readonly lease: (input: { origin: string; ticketHash: string; leaseTag: string; registration: string; expiresAt: number }) => Promise<boolean>
  readonly revoke: (input: { ticketHash: string } | { registration: string } | Record<string, never>) => void
}
export type Options = {
  readonly config: Config
  readonly registry: ReturnType<typeof RemoteLocalApp.create>
  readonly authorize: (scope: RemoteLocalApp.Scope, signal: AbortSignal) => Promise<boolean>
  readonly relay: Relay
  readonly now?: () => number
}

const maxLeaseMs = 900_000

export function create(options: Options) {
  const config = options.config
  const now = options.now ?? Date.now
  const registry = options.registry
  const active = new Map<string, { generation: string; registration: string; ticketHash: string | undefined }>()
  const gateway = RemoteAppPreview.create({
    origins: config.origins,
    frameAncestors: config.frameAncestors,
    now,
    authorize: options.authorize,
    dispatch: async (input) => {
      if (!config.ports.includes(registry.port({ id: input.id, owner: owner(input.scope) }))) throw new Error("Port is not eligible for preview")
      return registry.dispatch({ id: input.id, generation: input.generation, scope: input.scope, method: input.method, path: input.path, headers: input.headers,
        ...(input.body === undefined ? {} : { body: input.body }), signal: input.signal })
    },
  })

  const preview: RemoteMcpApps.Preview = {
    origins: () => options.relay.enabled() ? config.origins : [],
    async issue(input) {
      const app = input.registration
      if (!options.relay.enabled()) throw new Error("App preview is not enabled by the relay")
      if (!config.ports.includes(registry.port({ id: app.id, owner: owner(input.scope) }))) throw new Error("Port is not eligible for preview")
      const registration = await sha256Hex(`${app.id}:${app.generation}`)
      const allocation = await options.relay.allocate({ registration, expiresAt: app.expiresAt })
      if ("reason" in allocation) throw allocation.reason === "exhausted" ? new RemoteMcpApps.Error("preview_exhausted") : new Error("The relay refused a preview origin")
      const previous = active.get(app.id)?.ticketHash
      active.set(app.id, { generation: app.generation, registration, ticketHash: previous })
      const lease = await gateway.issue({ id: app.id, generation: app.generation, scope: input.scope, origin: allocation.origin, entryPath: app.entryPath,
        expiresAt: Math.min(app.expiresAt, now() + maxLeaseMs) })
      const ticketHash = await sha256Hex(new URL(lease.url).searchParams.get("ticket") ?? "")
      const accepted = await options.relay.lease({ origin: lease.origin, ticketHash, leaseTag: lease.tag, registration, expiresAt: lease.expiresAt }).catch(() => false)
      if (!accepted || input.signal.aborted) {
        gateway.revoke({ id: app.id, generation: app.generation })
        options.relay.revoke({ ticketHash })
        throw new Error("The relay did not accept the preview lease")
      }
      if (previous !== undefined) options.relay.revoke({ ticketHash: previous })
      active.set(app.id, { generation: app.generation, registration, ticketHash })
      return { url: lease.url, origin: lease.origin, expiresAt: lease.expiresAt }
    },
    revoke(input) {
      gateway.revoke(input)
      const current = active.get(input.id)
      if (current === undefined || current.generation !== input.generation) return
      options.relay.revoke({ registration: current.registration })
      active.delete(input.id)
    },
    clear() {
      for (const [id, current] of active) gateway.revoke({ id, generation: current.generation })
      active.clear()
      options.relay.revoke({})
    },
  }

  async function fetch(input: PreviewInput, signal: AbortSignal): Promise<PreviewResult> {
    const url = new URL(`${input.origin}${input.path}`)
    if (!config.origins.includes(input.origin) || url.origin !== input.origin || `${url.pathname}${url.search}` !== input.path)
      return { status: 404, headers: [["content-type", "text/plain; charset=utf-8"], ["cache-control", "no-store, no-transform"]], body: Buffer.from("not_found").toString("base64") }
    const response = await gateway.fetch(new Request(url, { method: input.method, headers: input.headers, signal }))
    const body = new Uint8Array(await response.arrayBuffer())
    const headers = [...response.headers].filter(([name]) => name !== "set-cookie").map(([name, value]) => [name, value] as const)
    return { status: response.status, headers: [...headers, ...response.headers.getSetCookie().map((value) => ["set-cookie", value] as const)], body: Buffer.from(body).toString("base64") }
  }

  return { preview, fetch, close: () => gateway.close() }
}

export type Host = ReturnType<typeof create>

function owner(scope: RemoteLocalApp.Scope): RemoteLocalApp.Owner {
  return { ownerID: scope.ownerID, deviceID: scope.deviceID, sessionID: scope.sessionID }
}
