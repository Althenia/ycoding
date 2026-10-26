import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Remote } from "@ycoding-ai/schema/remote"

export type RemoteMcpPreference = { readonly enabled: boolean; readonly epoch: string }
export type RemoteMcpHost = Awaited<ReturnType<typeof createRemoteMcpHost>>

const laneHoldMessage = "MCP lane read-only; recovery needed."
const off = (): Remote.McpStatus => ({ state: "off", message: "Enable Relay MCP, then authorize each client with a fresh sign-in and consent." })

export async function createRemoteMcpHost(input: { file: string; remote: () => string }) {
  let preference: RemoteMcpPreference = { enabled: false, epoch: crypto.randomUUID() }
  let pendingRevocation = false
  let current: Remote.McpStatus = off()
  let clientCapabilities: Remote.McpStatus["clientCapabilities"]
  let transport: { url: string; send: (state: RemoteMcpPreference) => Promise<void> } | undefined
  let laneHold = false
  let generation = 0
  let admitted = false
  let authorization = new AbortController()
  authorization.abort()
  let transition = Promise.resolve()

  function revoke() {
    clientCapabilities = undefined
    admitted = false
    authorization.abort()
  }

  try {
    const stored: unknown = JSON.parse(await readFile(input.file, "utf8"))
    if (typeof stored !== "object" || stored === null || !("enabled" in stored) || typeof stored.enabled !== "boolean" ||
      !("epoch" in stored) || typeof stored.epoch !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(stored.epoch) ||
      ("pendingRevocation" in stored && typeof stored.pendingRevocation !== "boolean") ||
      Object.keys(stored).some((key) => key !== "enabled" && key !== "epoch" && key !== "pendingRevocation")) throw new Error("Invalid preference")
    preference = { enabled: stored.enabled, epoch: stored.epoch }
    pendingRevocation = "pendingRevocation" in stored && stored.pendingRevocation === true
    current = pendingRevocation
      ? { state: "error", message: "Relay MCP revocation is unconfirmed; run `ycoding remote connect` to synchronize the disabled state" }
      : preference.enabled ? { state: "connecting" } : off()
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"))
      current = { state: "error", message: "Could not read relay MCP preference; run `ycoding remote mcp off` to reset it" }
  }

  async function save(next: RemoteMcpPreference, pending = pendingRevocation) {
    await mkdir(path.dirname(input.file), { recursive: true })
    const temporary = `${input.file}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ ...next, ...(pending ? { pendingRevocation: true } : {}) }), { mode: 0o600 })
      await rename(temporary, input.file)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    preference = next
    pendingRevocation = pending
  }

  async function synchronize(cycle: number) {
    const connection = transport
    if (!connection) {
      if (cycle === generation) current = { state: "error", message: "Relay MCP revocation is unconfirmed; run `ycoding remote connect` to synchronize the disabled state" }
      return current
    }
    current = { state: "connecting" }
    try {
      await connection.send(preference)
      if (cycle !== generation || connection !== transport) return current
      if (!preference.enabled && pendingRevocation) await save(preference, false)
      if (cycle !== generation || connection !== transport) return current
      if (preference.enabled && authorization.signal.aborted) authorization = new AbortController()
      if (!preference.enabled) authorization.abort()
      admitted = preference.enabled
      current = preference.enabled ? { state: "on", url: connection.url } : off()
    } catch {
      if (cycle === generation) {
        revoke()
        current = { state: "error", message: "Relay MCP state could not be confirmed; run `ycoding remote connect` and retry `ycoding remote mcp status`" }
      }
    }
    return current
  }

  return {
    status: (): Remote.McpStatus => ({ ...current, ...(current.state === "on" && laneHold ? { message: laneHoldMessage } : {}), ...(clientCapabilities === undefined ? {} : { clientCapabilities }) }),
    setLaneHold: (held: boolean) => { laneHold = held },
    setClientCapabilities: (value: Remote.McpStatus["clientCapabilities"]) => { clientCapabilities = admitted ? value : undefined },
    advertisement: () => preference,
    authorizationSignal: () => authorization.signal,
    allowed: (epoch: string) => admitted && preference.enabled && preference.epoch === epoch && transport !== undefined,
    attach: async (url: string, send: (state: RemoteMcpPreference) => Promise<void>) => {
      revoke()
      transport = { url, send }
      await synchronize(++generation)
    },
    detach: () => {
      generation++
      transport = undefined
      revoke()
      if (!pendingRevocation) current = preference.enabled ? { state: "connecting" } : off()
    },
    set: (enabled: boolean): Promise<Remote.McpStatus> => {
      const cycle = ++generation
      if (!enabled) revoke()
      const next = transition.then(async () => {
        if (enabled && input.remote() !== "on") {
          if (cycle === generation) current = { state: "error", message: "Remote connection must be on; run `ycoding remote connect` first" }
          return current
        }
        const changed = preference.enabled !== enabled
        const wasEnabled = preference.enabled
        try {
          if (enabled && pendingRevocation) {
            await synchronize(cycle)
            if (pendingRevocation || cycle !== generation) return current
          }
          await save({ enabled, epoch: changed ? crypto.randomUUID() : preference.epoch }, !enabled && (wasEnabled || pendingRevocation))
        } catch {
          if (cycle === generation) current = { state: "error", message: "Could not save relay MCP preference; check state-directory access and retry `ycoding remote mcp off`" }
          return current
        }
        if (cycle !== generation) return current
        if (!enabled && !wasEnabled && !pendingRevocation && !transport) {
          current = off()
          return current
        }
        return synchronize(cycle)
      })
      transition = next.then(() => undefined, () => undefined)
      return next
    },
    settled: () => transition,
  }
}
