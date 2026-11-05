import fs from "node:fs/promises"
import path from "node:path"
import { DesktopError, utf8Length, type Preferences, type Selection } from "./contract"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function validateSelection(value: unknown): Selection {
  if (!record(value) || (value.mode !== "own" && value.mode !== "shared")) throw new DesktopError("Choose a backend mode.")
  if (Object.keys(value).some((key) => key !== "mode" && key !== "server")) throw new DesktopError("Unsupported backend choice.")
  if (value.mode === "own") {
    if (value.server !== undefined) throw new DesktopError("An own backend cannot use a shared endpoint.")
    return { mode: "own" }
  }
  if (value.server === undefined || (typeof value.server === "string" && value.server.trim() === "")) return { mode: "shared" }
  if (typeof value.server !== "string" || utf8Length(value.server) > 2048) throw new DesktopError("Enter a valid shared endpoint.")
  let url: URL
  try { url = new URL(value.server.trim()) } catch { throw new DesktopError("Enter a valid HTTP(S) shared endpoint.") }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new DesktopError("Use an HTTP(S) origin without credentials, query, fragment or API path.")
  return { mode: "shared", server: url.href }
}

async function stored(file: string): Promise<{ mode?: Selection["mode"]; sharedEndpoint?: string }> {
  let text: string
  try { text = await fs.readFile(file, "utf8") } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {}
    throw new Error("Could not read backend preferences. They were not changed.")
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!record(value) || (value.mode !== "own" && value.mode !== "shared") || Object.keys(value).some((key) => key !== "mode" && key !== "sharedEndpoint")) throw new Error()
    const endpoint = validateSelection({ mode: "shared", server: value.sharedEndpoint })
    return { mode: value.mode, ...(endpoint.mode === "shared" && endpoint.server ? { sharedEndpoint: endpoint.server } : {}) }
  } catch { throw new Error("Could not read backend preferences. They were not changed.") }
}

export async function readPreferences(file: string): Promise<Preferences> {
  try {
    const value = await stored(file)
    return value.mode ? {
      selection: value.mode === "own" ? { mode: "own" } : { mode: "shared", ...(value.sharedEndpoint ? { server: value.sharedEndpoint } : {}) },
      ...(value.sharedEndpoint ? { sharedEndpoint: value.sharedEndpoint } : {}),
    } : {}
  } catch { return { error: "Could not read backend preferences. Choose a mode for this launch; saved data was not changed." } }
}

export async function savePreferences(file: string, input: unknown) {
  const selection = validateSelection(input)
  const previous = await stored(file)
  const sharedEndpoint = selection.mode === "shared" ? selection.server : previous.sharedEndpoint
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = file + ".tmp"
  await fs.writeFile(temporary, JSON.stringify({ mode: selection.mode, ...(sharedEndpoint ? { sharedEndpoint } : {}) }) + "\n", { mode: 0o600 })
  await fs.rename(temporary, file)
}
