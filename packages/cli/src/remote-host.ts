import { RemoteConnection } from "@ycoding-ai/server/remote-connection"
import type { createRemoteConnector } from "./commands/handlers/remote/connector"
import { createRemotePreferenceRepository } from "./remote-preference"
import { RemoteSetupError } from "./remote-error"
import { DeviceAuthorizationError } from "./remote-credentials"

type Connector = ReturnType<typeof createRemoteConnector>

export async function createRemoteHost(input: {
  file: string
  create: () => Promise<Connector>
  scheduleRetry?: (retry: () => void, delayMs: number) => () => void
}): Promise<RemoteConnection.Interface> {
  const repository = createRemotePreferenceRepository(input.file)
  let current: Awaited<ReturnType<RemoteConnection.Interface["status"]>> = { state: "off" }
  let connector: Connector | undefined
  let unsubscribe: (() => void) | undefined
  let generation = 0
  let transition = Promise.resolve()
  let desired = false
  const pending = new Set<Promise<void>>()
  let cancelRetry: (() => void) | undefined
  let retryAttempt = 0

  function retry(cycle: number, message: string) {
    if (!desired || cycle !== generation || cancelRetry) return
    const delay = Math.min(1_000 * 2 ** retryAttempt, 30_000)
    if (delay < 30_000) retryAttempt++
    current = { state: "connecting", message: `${message}; retrying in ${delay / 1_000}s` }
    const callback = () => {
      cancelRetry = undefined
      if (desired && cycle === generation) run(cycle)
    }
    if (input.scheduleRetry) cancelRetry = input.scheduleRetry(callback, delay)
    else {
      const timer = setTimeout(callback, delay)
      cancelRetry = () => clearTimeout(timer)
    }
  }

  function start() {
    if (desired && current.state !== "error") return current
    const previous = connector
    unsubscribe?.()
    unsubscribe = undefined
    connector = undefined
    desired = true
    retryAttempt = 0
    const cycle = ++generation
    current = { state: "connecting" }
    run(cycle, previous)
    return current
  }

  function run(cycle: number, previous?: Connector) {
    const running = (async () => {
      try {
        await previous?.stop()
        if (cycle !== generation) return
        const next = connector ?? await input.create()
        if (cycle !== generation) { await next.stop(); return }
        connector = next
        unsubscribe ??= next.subscribe((status) => {
          if (cycle !== generation || (status.state === "off" && current.state === "connecting")) return
          if (status.state === "other-process" || (status.state === "error" && status.retryable)) {
            retry(cycle, status.message ?? "Remote connection failed")
            return
          }
          if (status.state === "on") retryAttempt = 0
          current = { state: status.state, ...(status.message ? { message: status.message } : {}) }
        })
        await next.settled()
        if (cycle !== generation) return
        await next.start()
        if (cycle !== generation) await next.stop()
      } catch (error) {
        if (cycle !== generation) return
        if (error instanceof RemoteSetupError || error instanceof DeviceAuthorizationError) current = { state: "error", message: error.message }
        else retry(cycle, "Could not start remote connector")
      }
    })()
    pending.add(running)
    void running.finally(() => { pending.delete(running) })
  }

  async function stop() {
    desired = false
    generation++
    cancelRetry?.()
    cancelRetry = undefined
    unsubscribe?.()
    unsubscribe = undefined
    await connector?.stop()
    connector = undefined
    current = { state: "off" }
  }

  const enabled = await repository.load().catch((error: unknown) => {
    current = { state: "error", message: error instanceof SyntaxError ? "Invalid remote preference JSON" : "Could not read remote connection preference" }
    return false
  })
  if (enabled) start()
  return {
    status: async () => current,
    set: (enabled) => {
      const next = transition.then(async () => {
        await repository.save(enabled)
        if (enabled) return start()
        await stop()
        return current
      })
      transition = next.then(() => undefined, () => undefined)
      return next
    },
    shutdown: async () => { await transition; await stop(); await Promise.all(pending) },
  }
}
