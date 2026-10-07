import { acquireRemoteLock } from "./lock"
import { DeviceAuthorizationError } from "../../../remote-credentials"
import { RemoteSetupError } from "../../../remote-error"

export type RemoteConnectorStatus = {
  state: "off" | "connecting" | "on" | "other-process" | "error"
  message?: string
  notice?: string
  retryable?: boolean
}

export type RemoteConnectorBridge = {
  connect: () => Promise<void>
  close: () => Promise<void>
  subscribe?: (listener: (connected: boolean) => void) => () => void
}

export function createRemoteConnector(input: {
  directory: string
  notice: string
  makeBridge: (hooks: { onDiagnostic: (message: string) => void; onTerminal: (message: string, retryable?: boolean) => void }) => RemoteConnectorBridge
  onDiagnostic?: (message: string) => void
}) {
  const listeners = new Set<(status: RemoteConnectorStatus) => void>()
  let current: RemoteConnectorStatus = { state: "off" }
  let lock: Awaited<ReturnType<typeof acquireRemoteLock>> | undefined
  let bridge: RemoteConnectorBridge | undefined
  let starting: Promise<void> | undefined
  let settlement: Promise<void> = Promise.resolve()
  let generation = 0
  let unsubscribe: (() => void) | undefined

  async function cleanup() {
    unsubscribe?.()
    unsubscribe = undefined
    const previous = bridge
    bridge = undefined
    try {
      await previous?.close()
    } finally {
      if (lock?.owned) await lock.release()
      lock = undefined
    }
  }

  function setStatus(next: RemoteConnectorStatus) {
    current = next
    listeners.forEach((listener) => listener(next))
  }

  function start() {
    if (starting) return starting
    if (current.state === "on") return Promise.resolve()
    const cycle = ++generation
    setStatus({ state: "connecting", notice: input.notice })
    starting = (async () => {
      await settlement
      if (cycle !== generation) return
      lock = await acquireRemoteLock(input.directory)
      if (cycle !== generation) {
        if (lock.owned) await lock.release()
        lock = undefined
        return
      }
      if (!lock.owned) {
        setStatus({ state: "other-process", message: `Remote is on in another process (PID ${lock.pid})` })
        return
      }
      bridge = input.makeBridge({
        onDiagnostic: (message) => input.onDiagnostic?.(message),
        onTerminal: (message, retryable = false) => {
          if (cycle !== generation) return
          setStatus({ state: "error", message, retryable })
          settlement = cleanup().catch(() => {
            input.onDiagnostic?.("Could not close terminal remote connection")
          })
        },
      })
      const next = bridge
      unsubscribe = next.subscribe?.((connected) => {
        if (cycle !== generation || current.state === "error") return
        setStatus({ state: connected ? "on" : "connecting", notice: input.notice })
      })
      await next.connect()
      if (cycle !== generation || current.state === "error") return
      if (!next.subscribe) setStatus({ state: "on", notice: input.notice })
    })().catch(async (error: unknown) => {
      try {
        await cleanup()
      } catch {
        input.onDiagnostic?.("Could not close failed remote connection")
      }
      if (cycle === generation && current.state !== "error") {
        const terminal = error instanceof DeviceAuthorizationError || error instanceof RemoteSetupError
        setStatus({ state: "error", message: terminal ? error.message : "Could not start remote connection", retryable: !terminal })
      }
    }).finally(() => {
      starting = undefined
    })
    return starting
  }

  async function stop() {
    generation++
    await cleanup()
    await starting
    await settlement
    setStatus({ state: "off" })
  }

  return {
    notice: input.notice,
    start,
    stop,
    status: () => current,
    subscribe(listener: (status: RemoteConnectorStatus) => void) {
      listeners.add(listener)
      listener(current)
      return () => listeners.delete(listener)
    },
    settled: () => settlement,
  }
}
