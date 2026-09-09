import { Pty } from "@ycoding-ai/schema/pty"
import type { SessionInfo } from "@ycoding-ai/client"
import { useTerminalDimensions } from "@opentui/solid"
import { Option, Schema } from "effect"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { TerminalInspector, type TerminalInspectorRef } from "../component/terminal-inspector"
import { TerminalInspectorState } from "../component/terminal-inspector-state"
import { createTerminalInspectorTransport } from "../component/terminal-inspector-transport"
import { useClient } from "../context/client"
import { useClipboard } from "../context/clipboard"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { useLocation } from "../context/location"
import { useRoute, useRouteData } from "../context/route"
import { useTheme } from "../context/theme"

const decodeInfo = Schema.decodeUnknownOption(Pty.Info)

export function SessionTerminalInspector() {
  const route = useRouteData("terminal-inspector")
  const router = useRoute()
  const client = useClient()
  const data = useData()
  const currentLocation = useLocation()
  const clipboard = useClipboard()
  const dimensions = useTerminalDimensions()
  const { themeV2 } = useTheme()
  const [state, setState] = createSignal<TerminalInspectorState>()
  const [terminalLocation, setTerminalLocation] = createSignal<SessionInfo["location"]>()
  const [failed, setFailed] = createSignal(false)
  let request: AbortController | undefined
  let inspector: TerminalInspectorRef | undefined

  const ownerLocation = () => data.session.get(route.sessionID)?.location ?? currentLocation.current
  const accept = (value: unknown) => {
    const info = Option.getOrUndefined(decodeInfo(value))
    if (!info || info.id !== route.ptyID || info.sessionID !== route.sessionID) return false
    const current = state()
    if (current) current.updateInfo(info)
    else setState(new TerminalInspectorState(info))
    setFailed(false)
    return true
  }
  const load = () => {
    request?.abort()
    const owner = ownerLocation()
    if (!owner) {
      setFailed(true)
      return
    }
    const location = { directory: owner.directory, workspace: owner.workspaceID }
    const controller = new AbortController()
    request = controller
    setTerminalLocation(owner)
    setFailed(false)
    void client.api.pty
      .get({ ptyID: route.ptyID, sessionID: route.sessionID, location }, { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted && !accept(response.data)) setFailed(true)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
  }
  const back = () => router.navigate({ type: "session", sessionID: route.sessionID })
  const transport = (terminalState: TerminalInspectorState) => {
    const location = terminalLocation()
    if (!location) throw new Error("Terminal Location is unavailable")
    return createTerminalInspectorTransport({
      api: () => client.api,
      baseUrl: () => client.baseUrl(),
      ptyID: terminalState.snapshot().info.id,
      sessionID: route.sessionID,
      location,
    })
  }

  onMount(() => {
    load()
    const subscriptions = [
      client.event.on("pty.updated", (event) => {
        if (event.data.info.id === route.ptyID) accept(event.data.info)
      }),
      client.event.on("pty.exited", (event) => {
        if (event.data.id === route.ptyID) load()
      }),
      client.event.on("pty.deleted", (event) => {
        if (event.data.id !== route.ptyID) return
        state()?.disconnected("Terminal is no longer available")
        setState(undefined)
        setFailed(true)
      }),
    ]
    onCleanup(() => subscriptions.forEach((unsubscribe) => unsubscribe()))
  })
  onCleanup(() => request?.abort())

  const closeShortcut = Keymap.useShortcut("terminal-inspector.close")
  const leaveInputShortcut = Keymap.useShortcut("terminal-inspector.leave-input")
  const writeClipboard = clipboard.write
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        id: "terminal-inspector.close",
        title: "Close terminal inspector",
        group: "Terminal",
        palette: true,
        bind: "escape",
        enabled: () => state()?.canInput() !== true,
        run: () => void inspector?.close(),
      },
      {
        id: "terminal-inspector.leave-input",
        title: "Return terminal control",
        group: "Terminal",
        palette: true,
        bind: "ctrl+]",
        enabled: () => state()?.canInput() === true,
        run: () => void inspector?.returnControl(),
      },
      {
        id: "terminal-inspector.take-control",
        title: "Take terminal control",
        group: "Terminal",
        palette: true,
        bind: false,
        enabled: () => state()?.snapshot().synchronization === "synchronized" && state()?.canInput() !== true,
        run: () => void inspector?.takeControl(),
      },
      {
        id: "terminal-inspector.resume-agent",
        title: "Resume agent terminal control",
        group: "Terminal",
        palette: true,
        bind: false,
        enabled: () => state()?.snapshot().info.control.owner === "paused",
        run: () => void inspector?.resumeAgent(),
      },
      {
        id: "terminal-inspector.fit",
        title: "Fit terminal to pane",
        group: "Terminal",
        palette: true,
        bind: false,
        enabled: () => state()?.canInput() === true,
        run: () => void inspector?.fit(),
      },
      {
        id: "terminal-inspector.copy",
        title: "Copy terminal selection",
        group: "Terminal",
        palette: true,
        bind: false,
        enabled: () => Boolean(state()?.selectedText() && clipboard.write),
        run: () => void inspector?.copySelection(),
      },
    ],
  }))

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={themeV2.background.default}
    >
      <Show
        when={state()}
        fallback={
          <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
            <text>{failed() ? "Unable to load Session terminal" : "Loading Session terminal…"}</text>
            <Show when={failed()}>
              <text onMouseUp={load}>Retry</text>
              <text onMouseUp={back}>Close view</text>
            </Show>
          </box>
        }
      >
        {(terminalState) => (
          <TerminalInspector
            ref={(value) => (inspector = value)}
            state={terminalState()}
            transport={transport(terminalState())}
            pane={{
              rows: Math.min(Pty.MAX_ROWS, Math.max(1, dimensions().height - 4)),
              cols: Math.min(Pty.MAX_COLS, Math.max(1, dimensions().width)),
            }}
            closeHint={closeShortcut()}
            leaveInputHint={leaveInputShortcut()}
            copy={writeClipboard ? (text) => writeClipboard(text) : undefined}
            onClose={back}
          />
        )}
      </Show>
    </box>
  )
}
