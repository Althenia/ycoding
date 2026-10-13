import { customEndpointConfiguration } from "./custom-endpoint-config"
import type { CustomEndpointResult } from "./component/dialog-custom-endpoint"
import type { ProviderConfigureInput, ProviderConfigureOutput } from "@ycoding-ai/client/v5"

export async function saveCustomEndpoint(
  result: CustomEndpointResult,
  services: {
    configure: (input: ProviderConfigureInput) => Promise<ProviderConfigureOutput>
    connectKey: (input: { integrationID: string; key: string; label: string }) => Promise<unknown>
    activate: (credentialID: string) => Promise<unknown>
    refresh: () => Promise<unknown>
  },
  location?: ProviderConfigureInput["location"],
) {
  const configured = await services.configure(customEndpointConfiguration(result, location))
  if (!configured.registered)
    throw new Error(
      "Endpoint config saved, but its integration did not register; profile connection was not completed.",
    )
  try {
    if (result.credentialID) await services.activate(result.credentialID)
    else if (result.apiKey)
      await services.connectKey({
        integrationID: configured.providerID,
        key: result.apiKey,
        label: result.profile?.trim() || "default",
      })
    await services.refresh()
  } catch {
    throw new Error(
      result.apiKey || result.credentialID
        ? "Endpoint config saved, but credential profile connection failed."
        : "Endpoint config saved, but provider read-model refresh failed.",
    )
  }
  return { providerID: configured.providerID, credentialConnected: !!result.apiKey || !!result.credentialID }
}
