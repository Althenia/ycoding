import { createContext, createSignal, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import path from "node:path"
import { Keymap } from "./context/keymap"
import { useTuiPaths } from "./context/runtime"
import { useToast } from "./ui/toast"
import { useTheme } from "./context/theme"
import { useLog } from "./context/log"
import { createRemotePreferenceRepository } from "./remote-preference"

export type RemoteStatus = {
  state: "off" | "connecting" | "on" | "other-process" | "error"
  message?: string
  notice?: string
}

export type RemoteConnectorPort = {
  notice: string
  status: () => RemoteStatus
  subscribe: (listener: (status: RemoteStatus) => void) => () => void
  start: () => Promise<void>
  stop: () => Promise<void>
}

type RemoteContextValue = {
  status: () => RemoteStatus
  connect: () => Promise<void>
  disconnect: () => Promise<void>
}

const Context = createContext<RemoteContextValue>()
const unavailable: RemoteContextValue = {
  status: () => ({ state: "off" }),
  connect: async () => {},
  disconnect: async () => {},
}

export function useRemote() {
  return useContext(Context) ?? unavailable
}

export function RemoteProvider(props: ParentProps<{
  create?: () => Promise<RemoteConnectorPort>
  inspect?: () => Promise<RemoteStatus>
  registerFinalizer?: (dispose: () => Promise<void>) => void
}>) {
  const toast = useToast()
  const log = useLog({ component: "remote" })
  const paths = useTuiPaths()
  const repository = createRemotePreferenceRepository(path.join(paths.state, "remote.json"))
  const [status, setStatus] = createSignal<RemoteStatus>({ state: "off" })
  let connector: RemoteConnectorPort | undefined
  let unsubscribe: (() => void) | undefined
  let generation = 0
  let pending: Promise<void> | undefined
  let poll: ReturnType<typeof setInterval> | undefined

  async function inspect() {
    if (!props.inspect || !["off", "other-process"].includes(status().state)) return
    try {
      const next = await props.inspect()
      if (["off", "other-process"].includes(status().state)) setStatus(next)
    } catch (error) {
      setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

  function connect(save = true) {
    if (pending) return pending
    const cycle = ++generation
    const task = (async () => {
      try {
        if (save) await repository.save(true)
        if (cycle !== generation || status().state === "on") return
        setStatus({ state: "connecting" })
        const next = connector ?? await props.create?.()
        if (!next) throw new Error("Remote connector is unavailable in this TUI")
        if (cycle !== generation) {
          await next.stop()
          return
        }
        connector = next
        unsubscribe ??= connector.subscribe((value) => {
          if (value.state === "off" && status().state === "connecting") return
          setStatus(value)
          if (value.state === "error" && value.message)
            toast.show({ variant: "error", title: "Remote connection", message: value.message, duration: 6000 })
        })
        toast.show({ variant: "info", title: "Remote access", message: connector.notice, duration: 6000 })
        await connector.start()
        if (cycle !== generation) await connector.stop()
      } catch (error) {
        if (cycle !== generation) return
        const message = error instanceof Error ? error.message : String(error)
        setStatus({ state: "error", message })
        toast.show({ variant: "error", title: "Remote connection", message, duration: 6000 })
      }
    })()
    pending = task
    void task.then(() => { if (pending === task) pending = undefined })
    return task
  }

  async function disconnect() {
    generation++
    try {
      await repository.save(false)
      await connector?.stop()
      setStatus({ state: "off" })
      await inspect()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus({ state: "error", message })
      toast.show({ variant: "error", title: "Remote connection", message, duration: 6000 })
    }
  }

  async function dispose() {
    generation++
    unsubscribe?.()
    await pending
    await connector?.stop()
  }

  onMount(() => {
    props.registerFinalizer?.(dispose)
    poll = setInterval(() => { void inspect() }, 2_000)
    void repository.load().then((enabled) => enabled ? connect(false) : inspect()).catch((error) => {
      setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) })
    })
  })
  onCleanup(() => {
    if (poll) clearInterval(poll)
    void dispose().catch((error) => log.error("Could not stop remote connector", { error }))
  })

  return <Context.Provider value={{ status, connect: () => connect(), disconnect }}><RemoteCommands />{props.children}</Context.Provider>
}

function RemoteCommands() {
  const remote = useRemote()
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      { id: "remote.connect", title: "Connect remote", group: "Remote", palette: true, run: () => { void remote.connect() } },
      { id: "remote.disconnect", title: "Disconnect remote", group: "Remote", palette: true, run: () => { void remote.disconnect() } },
    ],
  }))
  return null
}

export function RemoteStatusLine() {
  const remote = useRemote()
  const { themeV2 } = useTheme()
  const label = () => {
    const state = remote.status().state
    if (state === "other-process") return "remote on elsewhere"
    return `remote ${state}`
  }
  return <box width="100%" height={1} flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor={themeV2.background.chrome}>
    <text fg={themeV2.text.subdued} wrapMode="none" truncate>{label()}</text>
  </box>
}
