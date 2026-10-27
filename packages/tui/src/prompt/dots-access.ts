import { createEffect, createSignal, on, onCleanup, untrack } from "solid-js"
import type { DotsAccess } from "@ycoding-ai/client"

export function createDotsAccess(input: {
  sessionID: () => string | undefined
  rootSessionID: () => string | undefined
  location: () => string
  connected: () => boolean
  owner?: () => unknown
  paletteOpen: () => boolean
  get: (sessionID: string, signal: AbortSignal) => Promise<DotsAccess>
  set: (input: { sessionID: string; enabled: boolean; expectedRevision: number }) => Promise<DotsAccess>
  error: (error: unknown) => void
}) {
  const [value, setValue] = createSignal<DotsAccess>()
  const [ready, setReady] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const revisions = new Map<string, number>()
  let generation = 0
  let disposed = false
  let reading: { controller: AbortController; promise: Promise<void> } | undefined
  let writing: object | undefined

  function invalidate() {
    generation++
    reading?.controller.abort()
    reading = undefined
    setReady(false)
  }

  function accept(next: DotsAccess, sessionID: string) {
    if (next.sessionID !== sessionID || next.revision < (revisions.get(next.rootSessionID) ?? 0))
      throw new Error("Dots access changed. Reopen the command palette to refresh.")
    revisions.set(next.rootSessionID, next.revision)
    setValue(next)
    setReady(true)
    setFailed(false)
  }

  function refresh(): Promise<void> {
    const sessionID = input.sessionID()
    if (disposed || !sessionID || !input.connected()) return Promise.resolve()
    if (reading) return reading.promise
    const cycle = generation
    const controller = new AbortController()
    setReady(false)
    const promise = (async () => {
      try {
        const next = await input.get(sessionID, controller.signal)
        if (disposed || cycle !== generation) return
        accept(next, sessionID)
      } catch (error) {
        if (disposed || cycle !== generation) return
        setFailed(true)
        input.error(error)
      }
    })().finally(() => {
      if (reading?.controller === controller) reading = undefined
    })
    reading = { controller, promise }
    return promise
  }

  const visible = () => {
    const current = value()
    return !!current && current.configured && !current.inherited &&
      current.sessionID === input.sessionID() && current.rootSessionID === current.sessionID && input.connected()
  }

  async function toggle() {
    const current = value()
    if (disposed || !current || !visible() || !ready() || writing) return
    const cycle = generation
    const operation = {}
    writing = operation
    setPending(true)
    setReady(false)
    try {
      const next = await input.set({ sessionID: current.sessionID, enabled: !current.enabled, expectedRevision: current.revision })
      if (disposed || cycle !== generation) return
      accept(next, current.sessionID)
    } catch (error) {
      if (disposed || cycle !== generation) return
      input.error(error)
      invalidate()
      await refresh()
    } finally {
      if (writing === operation) {
        writing = undefined
        setPending(false)
      }
    }
  }

  function changed(event: { sessionID: string; enabled: boolean; revision: number }) {
    const root = value()?.rootSessionID ?? input.rootSessionID()
    if (disposed || !input.connected() || event.sessionID !== root || event.revision <= (revisions.get(root) ?? -1)) return
    revisions.set(root, event.revision)
    invalidate()
    void refresh()
  }

  createEffect(on(
    () => [input.sessionID(), input.location(), input.connected(), input.owner?.()] as const,
    () => {
      invalidate()
      writing = undefined
      setPending(false)
      setValue(undefined)
      setFailed(false)
      void refresh()
    },
  ))
  createEffect(on(input.paletteOpen, (open) => {
    if (open && !writing) void refresh()
  }))
  onCleanup(() => {
    disposed = true
    invalidate()
  })

  return {
    value, ready, pending, refresh, toggle, changed,
    visible: () => visible() && (ready() || pending()),
    label: () => value() ? (value()!.enabled ? "On" : "Off") : failed() ? "Unavailable" : "Checking",
  }
}

export function dotsAccessCommand(access: ReturnType<typeof createDotsAccess>) {
  return {
    name: "session.dots.access",
    title: `Dots access · ${access.label()}`,
    description: access.pending() ? "Updating access…" : "Allow Dots access to this Session family",
    category: "Session",
    palette: access.visible(),
    run: () => untrack(access.toggle),
  }
}
