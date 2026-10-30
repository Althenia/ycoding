import type { Tool } from "@modelcontextprotocol/client"
import type { CcaAuthorizationGrant, CcaAuthorizationInput } from "./errors"

export interface CcaLibraryScope {
  readonly sessionID: string
  readonly principal: {
    readonly profile: string
    readonly credentialID: string
    readonly accountID: string
    readonly accountGeneration: number
    readonly accessRevision: number
  }
  readonly roots: readonly string[]
  readonly current: () => Promise<void>
  readonly authorize: (input: CcaAuthorizationInput) => Promise<CcaAuthorizationGrant>
}

export interface CcaLibraryProcess {
  readonly check: () => Promise<void>
  readonly tools: readonly Tool[]
  readonly call: (name: string, args: unknown) => Promise<unknown>
  readonly close: () => Promise<void>
}

export interface CcaLibraryFactory {
  readonly open: (input: {
    readonly processID: string
    readonly cwd: string
    readonly readFile: (path: string) => Promise<{ readonly canonical: string; readonly bytes: Uint8Array }>
  }) => Promise<CcaLibraryProcess>
}
