import type { Endpoint, EnsureOptions, StopOptions } from "@ycoding-ai/client/service"
import { DesktopError, type ConnectionState, type Selection } from "./contract"

export type RestartPorts = {
  state: () => ConnectionState
  selection: Selection
  endpoint: Endpoint
  command: readonly string[]
  version: string
  current: () => boolean
  disconnect: () => Promise<unknown>
  connect: (selection: Selection) => Promise<ConnectionState>
  service: {
    discover: () => Promise<Endpoint | undefined>
    stop: (options: StopOptions) => Promise<void>
    ensure: (options: EnsureOptions) => Promise<Endpoint>
  }
}

export class BackendRestart {
  private busy = false

  async run(input: unknown, ports: RestartPorts): Promise<ConnectionState> {
    if (this.busy) throw new DesktopError("A backend restart is already in progress.")
    const state = ports.state()
    if (!input || typeof input !== "object" || Object.keys(input).join() !== "revision" || !("revision" in input) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1 || input.revision !== state.revision || state.status !== "connected" || ports.selection.mode !== state.mode)
      throw new DesktopError("The backend connection changed. Refresh before restarting it.")
    this.busy = true
    try {
      if (ports.selection.mode === "shared") {
        const url = new URL(ports.endpoint.url)
        if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new DesktopError("Only a registered local service can be restarted.")
        if (state.backendPID === undefined) throw new DesktopError("The registered service identity is unavailable. Reconnect before restarting it.")
        const registered = await ports.service.discover()
        if (!registered || new URL(registered.url).href !== url.href || registered.auth?.type !== ports.endpoint.auth?.type || registered.auth?.username !== ports.endpoint.auth?.username || registered.auth?.password !== ports.endpoint.auth?.password)
          throw new DesktopError("Only the connected registered local service can be restarted.")
      }
      if (!ports.current()) throw new DesktopError("The backend connection changed. Refresh before restarting it.")
      await ports.disconnect()
      if (!ports.current()) throw new DesktopError("The backend connection changed during restart.")
      if (ports.selection.mode === "shared") {
        try { await ports.service.stop({ expected: { ...ports.endpoint, pid: state.backendPID! } }) }
        catch { throw new DesktopError("The shared service stop is unconfirmed. Reconnect and inspect it before retrying.") }
        if (!ports.current()) throw new DesktopError("The backend connection changed during restart.")
        await ports.service.ensure({ command: ports.command, version: ports.version })
        if (!ports.current()) throw new DesktopError("The backend connection changed during restart.")
      }
      return await ports.connect(ports.selection)
    } finally { this.busy = false }
  }
}
