import { acquireRemoteLock } from "./lock"

export type RemoteConnectorStatus = {
  state: "off" | "connecting" | "on" | "other-process" | "error"
  message?: string
  notice?: string
}

export type RemoteConnectorBridge = {
  connect: () => Promise<void>
  close: () => Promise<void>
}

export function createRemoteConnector(input: {
  directory: string
  notice: string
  makeBridge: (hooks: { onDiagnostic: (message: string) => void; onTerminal: (message: string) => void }) => RemoteConnectorBridge
  onDiagnostic?: (message: string) => void
}) {
  const listeners = new Set<(status: RemoteConnectorStatus) => void>()
  let current: RemoteConnectorStatus = { state: "off" }
  let lock: Awaited<ReturnType<typeof acquireRemoteLock>> | undefined
  let bridge: RemoteConnectorBridge | undefined
  let starting: Promise<void> | undefined
  let settlement: Promise<void> = Promise.resolve()
  let generation = 0

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
        onTerminal: (message) => {
          if (cycle !== generation) return
          setStatus({ state: "error", message })
          settlement = (async () => {
            try {
              await bridge?.close()
            } finally {
              if (lock?.owned) await lock.release()
              bridge = undefined
              lock = undefined
            }
          })().catch(() => {
            input.onDiagnostic?.("Could not close terminal remote connection")
          })
        },
      })
      await bridge.connect()
      if (cycle !== generation || current.state === "error") return
      setStatus({ state: "on", notice: input.notice })
    })().catch(async (error: unknown) => {
      try {
        await bridge?.close()
      } catch {
        input.onDiagnostic?.("Could not close failed remote connection")
      } finally {
        if (lock?.owned) await lock.release()
        bridge = undefined
        lock = undefined
      }
      if (cycle === generation) setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) })
    }).finally(() => {
      starting = undefined
    })
    return starting
  }

  async function stop() {
    generation++
    await bridge?.close()
    await starting
    await settlement
    if (lock?.owned) await lock.release()
    bridge = undefined
    lock = undefined
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
