import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

export async function writeCustomEndpoint(configDir: string, result: {
  baseURL: string
  api: "chat" | "responses"
  provider?: string
  worker?: "ollama" | "vllm"
  profile?: string
  catalog?: "openai-models"
  models?: { id: string; modelID?: string; name?: string; family?: string; api?: "chat" | "responses"; disabled?: boolean; tools?: boolean }[]
}) {
  const configFiles = ["ycoding.json", "ycoding.jsonc"]
  const configPath = await configFiles.reduce<Promise<string | undefined>>(async (previous, filename) => {
    const found = await previous
    if (found) return found
    try {
      await access(path.join(configDir, filename))
      return filename
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }, Promise.resolve(undefined))
  const fullPath = path.join(configDir, configPath ?? configFiles[0]!)
  const text = configPath ? await readFile(fullPath, "utf-8") : "{}\n"
  const errors: ParseError[] = []
  const current = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined
  if (errors.length || !current || typeof current !== "object" || Array.isArray(current)) throw new Error("Unable to parse YCoding config")

  const providerID = result.provider?.trim() || (result.worker ? "runpod" : "custom-openai")
  if (result.worker && !/^https:\/\/api\.runpod\.ai\/v2\/[a-zA-Z0-9_-]+$/.test(result.baseURL))
    throw new Error("Runpod Jobs endpoint must be https://api.runpod.ai/v2/<ENDPOINT_ID>")
  const providers = recordAt(current, "providers")
  const existing = recordAt(providers, providerID)
  if (result.worker && existing.package !== undefined && existing.package !== "@ycoding-ai/ai/providers/runpod")
    throw new Error("Endpoint name belongs to a different provider package")
  recordAt(existing, "settings")
  const models = recordAt(existing, "models")
  if (result.catalog) recordAt(existing, "catalog")
  for (const model of result.models ?? []) {
    const existingModel = recordAt(models, model.id)
    if (model.tools !== undefined) recordAt(existingModel, "capabilities")
  }
  const options = { formattingOptions: { tabSize: 2, insertSpaces: true } }
  const changes: [string[], unknown][] = [
    [["providers", providerID, "package"], result.worker ? "@ycoding-ai/ai/providers/runpod" : "aisdk:@ai-sdk/openai-compatible"],
    [["providers", providerID, "settings", "baseURL"], result.baseURL],
    ...(result.worker ? [[ ["providers", providerID, "settings", "worker"], result.worker] as [string[], unknown]] : [[ ["providers", providerID, "settings", "api"], result.api] as [string[], unknown]]),
    ...(!result.worker && result.catalog ? [[ ["providers", providerID, "catalog", "source"], result.catalog] as [string[], unknown]] : []),
    ...(result.models ?? []).flatMap((model) => [
      ...(!(model.id in models) ? [[ ["providers", providerID, "models", model.id], {}] as [string[], unknown]] : []),
      ...(["modelID", "name", "family", "api", "disabled"] as const).flatMap((field): [string[], unknown][] =>
        model[field] === undefined ? [] : [[ ["providers", providerID, "models", model.id, field], model[field]]],
      ),
      ...(model.tools === undefined ? [] : [[ ["providers", providerID, "models", model.id, "capabilities", "tools"], model.tools] as [string[], unknown]]),
    ]),
  ]
  const updated = changes.reduce((source, [segments, value]) => applyEdits(source, modify(source, segments, value, options)), text)
  await mkdir(configDir, { recursive: true })
  await writeFile(fullPath, updated)
  return providerID
}

function recordAt(parent: Record<string, unknown>, key: string) {
  const value = parent[key]
  if (value === undefined) return {}
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  throw new Error("Invalid custom endpoint config structure")
}
