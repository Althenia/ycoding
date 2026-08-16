import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

export function validateModelsSnapshot(text: string, source: string) {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new Error(`Invalid models.dev snapshot: ${source}`, { cause })
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Models.dev snapshot must be a JSON object: ${source}`)
  }
  return text
}

export async function readModelsSnapshot(file: string) {
  return validateModelsSnapshot(await readFile(file, "utf8"), file)
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export async function fetchModelsSnapshot(
  url: string,
  fetcher: FetchLike = globalThis.fetch,
  timeoutMs = 30_000,
) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) }).catch((cause) => {
    throw new Error(`Failed to refresh models.dev snapshot: ${url}`, { cause })
  })
  if (!response.ok) throw new Error(`Models.dev refresh failed with status ${response.status}: ${url}`)
  return validateModelsSnapshot(await response.text(), url)
}

export async function writeModelsSnapshot(file: string, text: string) {
  const value = validateModelsSnapshot(text, file)
  const temp = `${file}.tmp`
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(temp, value.endsWith("\n") ? value : `${value}\n`)
  await rename(temp, file)
}
