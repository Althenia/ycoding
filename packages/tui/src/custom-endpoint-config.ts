import type { ProviderConfigureInput } from "@ycoding-ai/client/v5"
import type { CustomEndpointResult } from "./component/dialog-custom-endpoint"

export function customEndpointConfiguration(
  result: CustomEndpointResult,
  location?: ProviderConfigureInput["location"],
): ProviderConfigureInput {
  return {
    location,
    providerID: result.provider?.trim() || (result.worker ? "runpod" : "custom-openai"),
    scope: "global",
    endpoint: result.worker
      ? { baseURL: result.baseURL, worker: result.worker }
      : { baseURL: result.baseURL, api: result.api },
    ...(result.catalog ? { catalog: result.catalog } : {}),
    ...(result.models ? { models: result.models } : {}),
  }
}
