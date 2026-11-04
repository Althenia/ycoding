export * as ComputerHistory from "./history"

import { createHash } from "node:crypto"
import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"

// Session-scoped computer-use history. One JSONL file per controlling Session is
// written only while that Session holds desktop claims: a `session` header line
// followed by one `event` line per computer call. Screenshots are referenced by
// digest, never copied, so history files carry metadata only. Retention is bounded
// by age (30 days) and count (200 files); files are plain JSONL the user can delete.
export const schema = 1
export const retentionDays = 30
export const maxFiles = 200
export const directoryName = "computer-history"

export interface Event {
  readonly sessionID: string
  readonly action: string
  readonly bundleID: string
  readonly pid: number
  readonly windowID: number
  readonly revision: string
  readonly effect?: "changed" | "unchanged" | "unverified"
  readonly screenshot?: {
    readonly sha256: string
    readonly width?: number
    readonly height?: number
    readonly scale?: number
  }
}

export interface StoredEvent extends Event {
  readonly type: "event"
  readonly at: string
}

export interface Entry {
  readonly id: string
  readonly file: string
  readonly sessionID: string
  readonly started: string
  readonly updated: string
  readonly events: number
}

export const screenshotRef = (image: string | undefined, width?: number, height?: number, scale?: number) =>
  image === undefined
    ? undefined
    : { sha256: createHash("sha256").update(image).digest("hex"), width, height, scale }

const fileFor = (started: Date, sessionID: string) =>
  `${started.toISOString().replaceAll(":", "-")}-${sessionID.replaceAll(/[^A-Za-z0-9._-]/g, "_")}.jsonl`

const idOf = (file: string) => file.replace(/\.jsonl$/, "")

function resolveFile(directory: string, id: string) {
  if (typeof id !== "string" || id.length === 0 || id.length > 200 || /[\\/]/.test(id) || id.includes(".."))
    throw new Error("Invalid computer history id")
  const file = path.join(directory, `${id}.jsonl`)
  if (path.dirname(file) !== path.resolve(directory)) throw new Error("Invalid computer history id")
  return file
}

async function files(directory: string): Promise<string[]> {
  const names = await readdir(directory).catch(() => [] as string[])
  return names.filter((name) => name.endsWith(".jsonl")).sort()
}

export function recorder(directory: string, now: () => Date = () => new Date()) {
  const started = new Map<string, string>()
  const record = async (event: Event) => {
    const at = now()
    let file = started.get(event.sessionID)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (!file) {
      file = fileFor(at, event.sessionID)
      started.set(event.sessionID, file)
      await appendFile(path.join(directory, file), `${JSON.stringify({ type: "session", schema, sessionID: event.sessionID, started: at.toISOString() })}\n`, { mode: 0o600 })
    }
    const stored: StoredEvent = { type: "event", at: at.toISOString(), ...event }
    await appendFile(path.join(directory, file), `${JSON.stringify(stored)}\n`, { mode: 0o600 })
  }
  const stop = (sessionID: string) => { started.delete(sessionID) }
  return { record, stop }
}

export async function list(directory: string): Promise<ReadonlyArray<Entry>> {
  const entries: Entry[] = []
  for (const file of await files(directory)) {
    const full = path.join(directory, file)
    const lines = (await readFile(full, "utf8").catch(() => "")).split("\n").filter((line) => line.trim().length > 0)
    const header = lines.length > 0 ? (JSON.parse(lines[0]) as { sessionID?: string; started?: string }) : {}
    const info = await stat(full).catch(() => undefined)
    entries.push({
      id: idOf(file),
      file,
      sessionID: typeof header.sessionID === "string" ? header.sessionID : "",
      started: typeof header.started === "string" ? header.started : "",
      updated: info ? info.mtime.toISOString() : "",
      events: Math.max(0, lines.length - 1),
    })
  }
  return entries
}

export async function read(directory: string, id: string, limit = 500): Promise<ReadonlyArray<StoredEvent>> {
  const lines = (await readFile(resolveFile(directory, id), "utf8")).split("\n").filter((line) => line.trim().length > 0)
  const events: StoredEvent[] = []
  for (const line of lines.slice(1)) {
    const parsed = JSON.parse(line) as StoredEvent
    if (parsed && parsed.type === "event") events.push(parsed)
    if (events.length >= limit) break
  }
  return events
}

export async function prune(directory: string, now: Date = new Date()): Promise<number> {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  const names = await files(directory)
  let removed = 0
  const kept: string[] = []
  for (const file of names) {
    const info = await stat(path.join(directory, file)).catch(() => undefined)
    if (info && info.mtime.getTime() < cutoff) {
      await rm(path.join(directory, file), { force: true })
      removed++
    } else kept.push(file)
  }
  for (const file of kept.slice(0, Math.max(0, kept.length - maxFiles))) {
    await rm(path.join(directory, file), { force: true })
    removed++
  }
  return removed
}

export async function clear(directory: string, sessionID?: string): Promise<number> {
  const names = sessionID === undefined ? await files(directory) : (await list(directory)).filter((entry) => entry.sessionID === sessionID).map((entry) => entry.file)
  for (const file of names) await rm(path.join(directory, file), { force: true })
  return names.length
}
