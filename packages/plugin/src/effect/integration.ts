import type {
  ConnectionInfo,
  IntegrationCommandMethod,
  IntegrationEnvMethod,
  IntegrationKeyMethod,
  IntegrationMethod,
  IntegrationOAuthMethod,
} from "@ycoding-ai/client"
export type {
  ConnectionInfo,
  IntegrationCommandMethod,
  IntegrationEnvMethod,
  IntegrationKeyMethod,
  IntegrationMethod,
  IntegrationOAuthMethod,
} from "@ycoding-ai/client"
import type { Credential } from "@ycoding-ai/schema/credential"

type IntegrationInputs = Readonly<Record<string, string>>
type IntegrationRef = { id: string; name: string }
type CredentialOAuth = Credential.OAuth
type CredentialValue = Credential.Value
import type { IntegrationApi } from "@ycoding-ai/client/effect/api"
import type { Effect, Scope } from "effect"
import type { Transform } from "./registration.js"

export type IntegrationOAuthAuthorization = {
  readonly url: string
  readonly instructions: string
  readonly expiresAt?: number
} & (
  | {
      readonly mode: "auto"
      readonly callback: Effect.Effect<CredentialOAuth, unknown>
    }
  | {
      readonly mode: "code"
      readonly callback: (code: string) => Effect.Effect<CredentialOAuth, unknown>
    }
)
export type IntegrationOAuthMethodRegistration = {
  readonly integrationID: string
  readonly method: IntegrationOAuthMethod
  readonly authorize: (inputs: IntegrationInputs) => Effect.Effect<IntegrationOAuthAuthorization, unknown, Scope.Scope>
  readonly refresh?: (credential: CredentialOAuth) => Effect.Effect<CredentialOAuth, unknown>
  readonly label?: (credential: CredentialOAuth) => string | undefined
}
export type IntegrationMethodRegistration =
  | IntegrationOAuthMethodRegistration
  | {
      readonly integrationID: string
      readonly method: IntegrationCommandMethod
    }
  | {
      readonly integrationID: string
      readonly method: IntegrationKeyMethod
    }
  | {
      readonly integrationID: string
      readonly method: IntegrationEnvMethod
    }

export interface IntegrationDraft {
  list(): readonly IntegrationRef[]
  get(id: string): IntegrationRef | undefined
  update(id: string, update: (integration: IntegrationRef) => void): void
  remove(id: string): void
  readonly method: {
    list(integrationID: string): readonly IntegrationMethod[]
    update(input: IntegrationMethodRegistration): void
    remove(integrationID: string, method: IntegrationMethod): void
  }
}

export interface IntegrationDomain extends Omit<IntegrationApi<unknown>, "wellknown"> {
  readonly transform: Transform<IntegrationDraft>
  readonly reload: () => Effect.Effect<void>
  readonly connection: {
    readonly active: (integrationID: string) => Effect.Effect<ConnectionInfo | undefined>
    readonly resolve: (connection: ConnectionInfo) => Effect.Effect<CredentialValue | undefined, unknown>
  }
}
