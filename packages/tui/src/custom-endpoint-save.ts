import { writeCustomEndpoint } from "./custom-endpoint-config"
import type { CustomEndpointResult } from "./component/dialog-custom-endpoint"

export async function saveCustomEndpoint(
  configDir: string,
  result: CustomEndpointResult,
  services: {
    syncRegistration: () => Promise<unknown>
    registered: (providerID: string) => boolean
    connectKey: (input: { integrationID: string; key: string; label: string }) => Promise<unknown>
    activate: (credentialID: string) => Promise<unknown>
    refresh: () => Promise<unknown>
  },
) {
  const providerID = result.provider?.trim() || "custom-openai"
  await writeCustomEndpoint(configDir, {
    baseURL: result.baseURL,
    api: result.api,
    provider: providerID,
    catalog: result.catalog,
    models: result.models,
  })
  let registered = false
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await services.syncRegistration()
    if (services.registered(providerID)) {
      registered = true
      break
    }
    if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!registered) throw new Error("Endpoint config saved, but its integration did not register; profile connection was not completed.")

  try {
    if (result.credentialID) await services.activate(result.credentialID)
    else if (result.apiKey)
      await services.connectKey({ integrationID: providerID, key: result.apiKey, label: result.profile?.trim() || "default" })
    await services.refresh()
  } catch {
    throw new Error(result.apiKey || result.credentialID
      ? "Endpoint config saved, but credential profile connection failed."
      : "Endpoint config saved, but provider read-model refresh failed.")
  }
  return { providerID, credentialConnected: !!result.apiKey || !!result.credentialID }
}
