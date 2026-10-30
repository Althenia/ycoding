import { createEffect, createSignal, on, onCleanup } from "solid-js"
import type { Dots } from "@ycoding-ai/schema/dots"
import { errorMessage } from "./util/error"

export function createDotsConnection(input: {
  connected: () => boolean
  owner: () => unknown
  get: (signal: AbortSignal) => Promise<Dots.NativeStatus>
  set: (input: { enabled: boolean; expectedRevision: number }) => Promise<Dots.NativeStatus>
  attach: (input: Dots.ComputerAttach) => Promise<Dots.NativeStatus>
  error: (error: unknown) => void
}) {
  const [opened, setOpened] = createSignal(false)
  const [status, setStatus] = createSignal<Dots.NativeStatus>()
  const [ready, setReady] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [attachFailure, setAttachFailure] = createSignal<string>()
  const [confirming, setConfirming] = createSignal(false)
  let disposed = false
  let generation = 0
  let epoch = 0
  let owner = input.owner()
  let connected = input.connected()
  let revision = -1
  let reading: { controller: AbortController; promise: Promise<void> } | undefined
  let writing = false
  let attachTarget: Dots.ComputerTarget | undefined

  const attachable = (value: Dots.NativeStatus | undefined) => !!value?.access.enabled && value.computer?.state === "detached"

  function invalidate() {
    generation++
    reading?.controller.abort()
    reading = undefined
    setReady(false)
  }

  function accept(next: Dots.NativeStatus) {
    if (next.access.revision < revision) throw new Error("Dots access changed. Refresh to read the current state.")
    revision = next.access.revision
    setStatus(next)
    setFailure(undefined)
    setReady(true)
    if (!attachable(next)) setConfirming(false)
  }

  function refresh(): Promise<void> {
    if (disposed || !opened() || !input.connected() || writing) return Promise.resolve()
    if (reading) return reading.promise
    const cycle = generation
    const controller = new AbortController()
    setReady(false)
    async function load() {
      try {
        const next = await input.get(controller.signal)
        if (disposed || cycle !== generation) return
        accept(next)
      } catch (error) {
        if (disposed || cycle !== generation) return
        setFailure(errorMessage(error))
      } finally {
        if (reading?.controller === controller) reading = undefined
      }
    }
    const promise = load()
    reading = { controller, promise }
    return promise
  }

  const canToggle = () => opened() && input.connected() && ready() && !pending() &&
    !!status() && (status()!.access.enabled || status()!.configuration.ready)

  const canAttach = () => opened() && input.connected() && !pending() && !failure() && attachable(status())

  async function mutate(run: () => Promise<Dots.NativeStatus>, fail: (error: unknown) => void) {
    const scope = epoch
    writing = true
    setPending(true)
    invalidate()
    try {
      const next = await run()
      if (disposed || scope !== epoch) return
      accept(next)
    } catch (error) {
      if (disposed || scope !== epoch) return
      fail(error)
      input.error(error)
    } finally {
      writing = false
      if (!disposed) {
        await refresh()
        setPending(false)
      }
    }
  }

  async function toggle() {
    const current = status()
    if (disposed || !current || !canToggle() || writing) return
    await mutate(
      () => input.set({ enabled: !current.access.enabled, expectedRevision: current.access.revision }),
      (error) => setFailure(errorMessage(error)),
    )
  }

  function requestAttach() {
    if (disposed || writing || !canAttach()) return
    setAttachFailure(undefined)
    attachTarget = status()?.computer?.target
    setConfirming(true)
  }

  async function attach() {
    if (disposed || writing || !confirming() || !canAttach()) return
    setConfirming(false)
    setAttachFailure(undefined)
    await mutate(() => input.attach({ replaceOthers: true, ...(attachTarget === undefined ? {} : { expectedTarget: attachTarget }) }), (error) => setAttachFailure(errorMessage(error)))
  }

  createEffect(on(
    () => [opened(), input.connected(), input.owner()] as const,
    ([open, nextConnected, nextOwner]) => {
      if (nextOwner !== owner || nextConnected !== connected) epoch++
      if (nextOwner !== owner) {
        revision = -1
        setStatus(undefined)
        setFailure(undefined)
        setAttachFailure(undefined)
      }
      setConfirming(false)
      owner = nextOwner
      connected = nextConnected
      invalidate()
      if (!open || !nextConnected) return
      void refresh()
      const poll = setInterval(() => { void refresh() }, 2000)
      onCleanup(() => clearInterval(poll))
    },
  ))
  onCleanup(() => {
    disposed = true
    invalidate()
  })

  return {
    status, ready, pending, failure, attachFailure, canToggle, canAttach, refresh, toggle, requestAttach, attach,
    confirmingAttach: () => confirming() && canAttach(),
    cancelAttach: () => setConfirming(false),
    connected: input.connected,
    open: () => { if (!disposed) setOpened(true) },
    close: () => setOpened(false),
  }
}
