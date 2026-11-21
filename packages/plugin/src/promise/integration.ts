import type { IntegrationApi } from "@ycoding-ai/client/promise/api"
import type { IntegrationDraft, IntegrationMethodRegistration } from "../effect/integration.js"
import type { ConnectionInfo } from "@ycoding-ai/client"
import type { Credential } from "@ycoding-ai/schema/credential"
import type { Transform } from "./registration.js"

export type { IntegrationDraft, IntegrationMethodRegistration }

export interface IntegrationDomain extends Omit<IntegrationApi, "wellknown"> {
  readonly transform: Transform<IntegrationDraft>
  readonly reload: () => Promise<void>
  readonly connection: {
    readonly active: (integrationID: string) => Promise<ConnectionInfo | undefined>
    readonly resolve: (
      connection: ConnectionInfo,
    ) => Promise<Credential.Value | undefined>
  }
}
