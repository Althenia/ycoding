import { DurableObject } from "cloudflare:workers"
import { createPreviewDirectoryStore, type PreviewAccess, type PreviewAllocation, type PreviewDevice, type PreviewLeaseInput } from "./directory-store"

export class PreviewDirectory extends DurableObject {
  readonly #store = createPreviewDirectoryStore({
    sql: this.ctx.storage.sql,
    transactionSync: (operation) => this.ctx.storage.transactionSync(operation),
  })

  allocate(input: PreviewDevice & { readonly registration: string; readonly expiresAt: number; readonly origins: readonly string[] }): PreviewAllocation {
    return this.#store.allocate(input)
  }

  register(input: PreviewLeaseInput): boolean {
    return this.#store.register(input)
  }

  redeem(ticketHash: string, origin: string): PreviewAccess {
    return this.#store.redeem(ticketHash, origin)
  }

  bind(input: PreviewDevice & { readonly ticketHash: string; readonly cookieHash: string }): boolean {
    return this.#store.bind(input)
  }

  resolve(cookieHash: string, leaseTag: string, origin: string): PreviewAccess {
    return this.#store.resolve(cookieHash, leaseTag, origin)
  }

  revoke(input: PreviewDevice & { readonly ticketHash?: string; readonly registration?: string }): void {
    this.#store.revoke(input)
  }
}
