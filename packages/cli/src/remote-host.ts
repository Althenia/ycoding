import { RemoteConnection } from "@ycoding-ai/server/remote-connection"
import type { createRemoteConnector } from "./commands/handlers/remote/connector"
import { createRemotePreferenceRepository } from "./remote-preference"

type Connector = ReturnType<typeof createRemoteConnector>

export async function createRemoteHost(input: {
  file: string
  create: () => Promise<Connector>
}): Promise<RemoteConnection.Interface> {
  const repository = createRemotePreferenceRepository(input.file)
  let current: Awaited<ReturnType<RemoteConnection.Interface["status"]>> = { state: "off" }
  let connector: Connector | undefined
  let unsubscribe: (() => void) | undefined
  let generation = 0
  let transition = Promise.resolve()

  function start() {
    if (current.state === "on" || current.state === "connecting") return current
    const cycle = ++generation
    current = { state: "connecting" }
    void (async () => {
      try {
        const next = connector ?? await input.create()
        if (cycle !== generation) { await next.stop(); return }
        connector = next
        unsubscribe ??= next.subscribe((status) => {
          if (cycle !== generation || (status.state === "off" && current.state === "connecting")) return
          current = status.state === "other-process"
            ? { state: "error", message: status.message ?? "Another server holds the remote connector lock" }
            : { state: status.state, ...(status.message ? { message: status.message } : {}) }
        })
        await next.start()
        if (cycle !== generation) await next.stop()
      } catch (error) {
        if (cycle === generation) current = { state: "error", message: error instanceof Error ? error.message : String(error) }
      }
    })()
    return current
  }

  async function stop() {
    generation++
    unsubscribe?.()
    unsubscribe = undefined
    await connector?.stop()
    connector = undefined
    current = { state: "off" }
  }

  const enabled = await repository.load().catch((error: unknown) => {
    current = { state: "error", message: error instanceof SyntaxError ? "Invalid remote preference JSON" : error instanceof Error ? error.message : String(error) }
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
    shutdown: async () => { await transition; await stop() },
  }
}
