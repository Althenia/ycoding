import { createContext, createSignal, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import type { Remote } from "@ycoding-ai/schema/remote"
import { Keymap } from "./context/keymap"
import { useClient } from "./context/client"
import { useToast } from "./ui/toast"
import { useTheme } from "./context/theme"
import type { PaletteStatusCommand } from "./component/command-palette"
import { errorMessage } from "./util/error"

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
  const client = props.server ? undefined : useClient()
  const server = props.server ?? {
    get: () => client!.api.remote.get(),
    set: (enabled: boolean) => client!.api.remote.set({ enabled }),
  }
  const toast = useToast()
  const connection = createSwitch(server, (next) => {
    if (next.state === "connecting" || next.state === "on")
      toast.show({ variant: "info", title: "Remote access", message: "Connecting grants the machine owner access to every existing and future Session on this backend.", duration: 6000 })
  }, (message) => toast.show({ variant: "error", title: "Remote connection", message, duration: 6000 }))
  return <Context.Provider value={{ status: connection.status, toggle: connection.toggle }}><RemoteCommands />{props.children}</Context.Provider>
}

function createSwitch(
  server: RemoteServer,
  onEnabled: (next: RemoteStatus) => void,
  onFailure: (message: string) => void,
) {
  const [status, setStatus] = createSignal<RemoteStatus>({ state: "off" })
  let generation = 0
  let disposed = false
  let requested: boolean | undefined
  let statusFailure: string | undefined
  let enabling: { message?: string } | undefined
  let poll: ReturnType<typeof setInterval> | undefined

  function report(message: string) {
    if (!enabling || enabling.message === message) return
    enabling.message = message
    onFailure(message)
  }

  function accept(next: RemoteStatus) {
    statusFailure = undefined
    setStatus(() => next)
    if (next.state === "error") report(next.message ?? "Remote connection failed. Check the runtime log.")
    if (next.state === "connecting" && next.message) report(next.message)
    if (next.state === "off") report("Remote connection stayed off. Check the server status before trying again.")
    if (next.state !== "connecting") enabling = undefined
  }

  function recordFailure(error: unknown) {
    const message = errorMessage(error)
    statusFailure = message
    setStatus(() => ({ state: "error", message }))
    return message
  }

  async function refresh() {
    if (requested !== undefined) return
    const cycle = generation
    try {
      const next = await server.get()
      if (!disposed && cycle === generation && requested === undefined) accept(next)
    } catch (error) {
      if (!disposed && cycle === generation && requested === undefined) report(recordFailure(error))
    }
  }

  async function toggle() {
    if (requested === undefined && statusFailure !== undefined) {
      onFailure(statusFailure)
      return
    }
    const cycle = ++generation
    const enabled = requested === undefined ? status().state === "off" : !requested
    requested = enabled
    enabling = enabled ? {} : undefined
    try {
      const next = await server.set(enabled)
      if (!disposed && cycle === generation) {
        if (enabled) onEnabled(next)
        accept(next)
      }
    } catch (error) {
      if (disposed || cycle !== generation) return
      enabling = undefined
      onFailure(recordFailure(error))
    } finally {
      if (cycle === generation) requested = undefined
    }
  }

  onMount(() => {
    void refresh()
    poll = setInterval(() => {
      void refresh()
    }, 2_000)
  })
  onCleanup(() => {
    disposed = true
    if (poll) clearInterval(poll)
  })

  return { status, toggle }
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

function RemotePaletteStatus(props: { status: () => { state: string } }) {
  const { theme } = useTheme().contextual("elevated")
  return <span style={{ fg: props.status().state === "on" ? theme.text.feedback.success.default : theme.text.subdued }}>● {props.status().state}</span>
}
