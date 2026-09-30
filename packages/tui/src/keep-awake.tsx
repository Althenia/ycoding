import { createContext, createSignal, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import type { KeepAwake } from "@ycoding-ai/schema/keep-awake"
import { Keymap } from "./context/keymap"
import { useClient } from "./context/client"
import { useToast } from "./ui/toast"
import { useTheme } from "./context/theme"
import type { PaletteStatusCommand } from "./component/command-palette"

export type KeepAwakeStatus = KeepAwake.Status

type KeepAwakeServer = {
  get: () => Promise<KeepAwakeStatus>
  set: (enabled: boolean) => Promise<KeepAwakeStatus>
}

type KeepAwakeContextValue = {
  status: () => KeepAwakeStatus | undefined
  toggle: () => Promise<void>
}

const Context = createContext<KeepAwakeContextValue>()
const unavailable: KeepAwakeContextValue = {
  status: () => undefined,
  toggle: async () => {},
}

export function useKeepAwake() {
  return useContext(Context) ?? unavailable
}

export function KeepAwakeProvider(props: ParentProps<{ server?: KeepAwakeServer }>) {
  const server = props.server ?? (() => {
    const client = useClient()
    return {
      get: () => client.api.keepAwake.get(),
      set: (enabled: boolean) => client.api.keepAwake.set({ enabled }),
    }
  })()
  const toast = useToast()
  const [status, setStatus] = createSignal<KeepAwakeStatus>()
  let generation = 0
  let disposed = false
  let poll: ReturnType<typeof setInterval> | undefined

  async function refresh() {
    const cycle = generation
    try {
      const next = await server.get()
      if (!disposed && cycle === generation) setStatus(next)
    } catch (error) {
      if (!disposed && cycle === generation)
        setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function toggle() {
    const current = status()
    if (disposed || !current) return
    if (current.state === "unsupported") {
      toast.show({ variant: "info", title: "Keep machine awake", message: current.message ?? "Not supported on this machine.", duration: 6000 })
      return
    }
    const cycle = ++generation
    const enabled = current.state !== "on"
    try {
      const next = await server.set(enabled)
      if (disposed || cycle !== generation) return
      setStatus(next)
      if (next.state === "on")
        toast.show({ variant: "info", title: "Keep machine awake", message: "Idle sleep only; manual sleep and lid still apply.", duration: 6000 })
      if (next.state === "error" || next.state === "unsupported")
        toast.show({ variant: "error", title: "Keep machine awake", message: next.message ?? "Keep machine awake is unavailable.", duration: 6000 })
    } catch (error) {
      if (disposed || cycle !== generation) return
      const message = error instanceof Error ? error.message : String(error)
      setStatus({ state: "error", message })
      toast.show({ variant: "error", title: "Keep machine awake", message, duration: 6000 })
    }
  }

  onMount(() => {
    void refresh()
    poll = setInterval(() => { void refresh() }, 2_000)
  })
  onCleanup(() => {
    disposed = true
    if (poll) clearInterval(poll)
  })

  return <Context.Provider value={{ status, toggle }}><KeepAwakeCommands />{props.children}</Context.Provider>
}

function KeepAwakeCommands() {
  const awake = useKeepAwake()
  const command = {
    id: "keepAwake.toggle",
    title: "Keep machine awake",
    group: "Machine",
    palette: true,
    paletteStatus: () => <KeepAwakePaletteStatus status={awake.status} />,
    run: () => { void awake.toggle() },
  } satisfies PaletteStatusCommand
  Keymap.createLayer(() => ({ mode: "global", commands: [command] }))
  return null
}

function KeepAwakePaletteStatus(props: { status: () => KeepAwakeStatus | undefined }) {
  const { themeV2 } = useTheme().contextual("elevated")
  const color = () =>
    props.status()?.state === "on"
      ? themeV2.text.feedback.success.default
      : props.status()?.state === "error"
        ? themeV2.text.feedback.error.default
        : themeV2.text.subdued
  return <span style={{ fg: color() }}>● {props.status()?.state ?? "Checking"}</span>
}
