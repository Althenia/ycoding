import { createContext, createSignal, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import type { Remote } from "@ycoding-ai/schema/remote"
import { Keymap } from "./context/keymap"
import { useClient } from "./context/client"
import { useToast } from "./ui/toast"
import { useTheme } from "./context/theme"
import type { PaletteStatusCommand } from "./component/command-palette"

export type RemoteStatus = Remote.Status

type RemoteServer = {
  get: () => Promise<RemoteStatus>
  set: (enabled: boolean) => Promise<RemoteStatus>
}

type RemoteContextValue = {
  status: () => RemoteStatus
  toggle: () => Promise<void>
}

const Context = createContext<RemoteContextValue>()
const unavailable: RemoteContextValue = {
  status: () => ({ state: "off" }),
  toggle: async () => {},
}

export function useRemote() {
  return useContext(Context) ?? unavailable
}

export function RemoteProvider(props: ParentProps<{ server?: RemoteServer }>) {
  const server = props.server ?? (() => {
    const client = useClient()
    return {
      get: () => client.api.remote.get(),
      set: (enabled: boolean) => client.api.remote.set({ enabled }),
    }
  })()
  const toast = useToast()
  const [status, setStatus] = createSignal<RemoteStatus>({ state: "off" })
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
    const cycle = ++generation
    const enabled = status().state !== "on"
    try {
      const next = await server.set(enabled)
      if (!disposed && cycle === generation) {
        setStatus(next)
        if (enabled && (next.state === "connecting" || next.state === "on"))
          toast.show({ variant: "info", title: "Remote access", message: "Connecting grants the machine owner access to every existing and future Session on this backend.", duration: 6000 })
      }
    } catch (error) {
      if (disposed || cycle !== generation) return
      const message = error instanceof Error ? error.message : String(error)
      setStatus({ state: "error", message })
      toast.show({ variant: "error", title: "Remote connection", message, duration: 6000 })
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

  return <Context.Provider value={{ status, toggle }}><RemoteCommands />{props.children}</Context.Provider>
}

function RemoteCommands() {
  const remote = useRemote()
  const command = {
    id: "remote.toggle",
    title: "Remote connection",
    group: "Remote",
    palette: true,
    paletteStatus: () => <RemotePaletteStatus status={remote.status} />,
    run: () => { void remote.toggle() },
  } satisfies PaletteStatusCommand
  Keymap.createLayer(() => ({ mode: "global", commands: [command] }))
  return null
}

function RemotePaletteStatus(props: { status: () => RemoteStatus }) {
  const { theme } = useTheme().contextual("elevated")
  return <span style={{ fg: props.status().state === "on" ? theme.text.feedback.success.default : theme.text.subdued }}>● {props.status().state}</span>
}
