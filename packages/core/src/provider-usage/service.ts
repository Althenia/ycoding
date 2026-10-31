export * as ProviderUsageService from "./service"

import { createHash } from "node:crypto"
import { Context, Effect } from "effect"
import { Provider } from "@ycoding-ai/schema/provider"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { UsageForecast } from "@ycoding-ai/schema/usage-forecast"
import type { Credential } from "../credential"

export interface GetInput {
  readonly providerID: Provider.ID
  readonly credentialID?: Credential.ID
  readonly refresh?: boolean
}

export interface Interface {
  readonly get: (input: GetInput) => Effect.Effect<ProviderUsage.Snapshot>
  readonly list: (input?: { readonly refresh?: boolean }) => Effect.Effect<ReadonlyArray<ProviderUsage.Snapshot>>
  readonly observe: (observation: ProviderUsage.Observation, profileSource?: string) => Effect.Effect<void>
  readonly forecast: (input: UsageForecast.Input) => Effect.Effect<UsageForecast.Info>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/ProviderUsage") {}

export const accountIdentityDigest = (credential: Credential.Info) =>
  createHash("sha256").update(JSON.stringify({
    integrationID: credential.integrationID,
    credentialID: credential.id,
    accountGeneration: credential.accountGeneration,
  })).digest("hex")
