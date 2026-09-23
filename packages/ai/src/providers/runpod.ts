import { ProviderID } from "../schema"
import { ollamaRoute, vllmRoute } from "../protocols/runpod"
import { AuthOptions } from "../route/auth-options"
import type { ProviderPackage } from "../provider-package"

export interface Settings extends ProviderPackage.Settings {
  readonly worker: "ollama" | "vllm"
  readonly baseURL: string
  readonly apiKey?: string
}

export const model: ProviderPackage.Definition<Settings>["model"] = (modelID, settings) =>
  (settings.worker === "ollama" ? ollamaRoute : settings.worker === "vllm" ? vllmRoute : requireWorker()).with({
    provider: "runpod",
    endpoint: { baseURL: settings.baseURL },
    auth: AuthOptions.bearer(settings, "RUNPOD_API_KEY"),
    headers: settings.headers === undefined ? undefined : { ...settings.headers },
    http: settings.body === undefined ? undefined : { body: { ...settings.body } },
    limits: settings.limits,
  }).model({ id: modelID, provider: ProviderID.make("runpod") })

function requireWorker(): never {
  throw new Error("Runpod Serverless requires settings.worker: ollama or vllm")
}
