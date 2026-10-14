import type { ProviderConfigureInput } from "@ycoding-ai/client/v5"
import type { CustomEndpointResult } from "./component/dialog-custom-endpoint"

export function customEndpointConfiguration(
  result: CustomEndpointResult,
  location?: ProviderConfigureInput["location"],
): ProviderConfigureInput {
  return {
    location,
    providerID: result.provider?.trim() || "custom-openai",
    scope: "global",
    endpoint: { baseURL: result.baseURL, api: result.api },
    ...(result.catalog ? { catalog: result.catalog } : {}),
    ...(result.models ? { models: result.models } : {}),
  }
}
