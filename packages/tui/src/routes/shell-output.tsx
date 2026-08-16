import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js"
import { useRoute, useRouteData } from "../context/route"
import { useData } from "../context/data"
import { useClient } from "../context/client"
import { useLocation } from "../context/location"
import { useTheme } from "../context/theme"
import { Keymap } from "../context/keymap"
import { groupSessionShells } from "../util/session"
import { useTerminalDimensions } from "@opentui/solid"
import stripAnsi from "strip-ansi"
import type { ShellInfo } from "@ycoding-ai/client"
import { ShellOutputHeader } from "./shell-output/header"
import { ShellOutputStream } from "./shell-output/stream"
import { ShellOutputMetadata } from "./shell-output/metadata"
import { ShellOutputFooter } from "./shell-output/footer"

export function ShellOutput() {
  const route = useRouteData("shell-output")
  const { navigate } = useRoute()
  const data = useData()
  const client = useClient()
  const location = useLocation()
  const { themeV2 } = useTheme()
  const dimensions = useTerminalDimensions()

  const [shellFetch, setShellFetch] = createSignal<ShellInfo | undefined>()

  const shell = createMemo(() => {
    const fromStore = data.shell.get(route.shellID) ?? data.shell.list().find((s) => s.id === route.shellID)
    return fromStore ?? shellFetch()
  })
  const sessions = createMemo(() => data.session.list())
  const groups = createMemo(() => groupSessionShells(data.shell.list(), sessions(), route.sessionID))
  const owner = createMemo(() => {
    const s = shell()
    if (!s) return ""
    for (const group of groups()) {
      if (group.shells.some((sh) => sh.id === s.id)) return group.owner.label
    }
    return ""
  })

  const [now, setNow] = createSignal(Date.now())
  const [outputText, setOutputText] = createSignal("")
  const [cursor, setCursor] = createSignal(0)
  const [loading, setLoading] = createSignal(false)

  let outputLoading = false

  createEffect(() => {
    const s = shell()
    if (!s || s.status !== "running") return
    const interval = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(interval))
  })

  async function loadOutput() {
    const s = shell()
    if (!s || outputLoading) return
    outputLoading = true
    setLoading(true)
    const ref = location.current
    await client.api.shell
      .output({
        id: s.id,
        cursor: cursor(),
        limit: 64 * 1024,
        location: ref ? { directory: ref.directory, workspace: ref.workspaceID } : undefined,
      })
      .then((response) => {
        if (shell()?.id !== s.id) return
        setOutputText((current) => current + stripAnsi(response.data.output))
        setCursor(response.data.cursor)
      })
      .catch(() => undefined)
    outputLoading = false
    setLoading(false)
  }

  createEffect(() => {
    const s = shell()
    if (!s) return
    void loadOutput()
  })

  createEffect(() => {
    const s = shell()
    if (!s || s.status !== "running") return
    const interval = setInterval(() => void loadOutput(), 1_000)
    onCleanup(() => clearInterval(interval))
  })

  function back() {
    navigate({ type: "session", sessionID: route.sessionID })
  }

  function kill() {
    const s = shell()
    if (!s) return
    const ref = location.current
    void client.api.shell.remove({
      id: s.id,
      location: ref ? { directory: ref.directory, workspace: ref.workspaceID } : undefined,
    })
  }

  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        id: "shell-output.back",
        title: "Go back to session",
        group: "Shell Output",
        run: back,
      },
      {
        id: "shell-output.kill",
        title: "Kill shell command",
        group: "Shell Output",
        run: kill,
      },
    ],
  }))

  onMount(() => {
    if (!shell()) {
      void Promise.all([
        data.location.sync(),
        data.shell.sync(),
      ]).catch(() => undefined)
      // Direct fetch fallback if shell data is not in the store
      if (!shell()) {
        void client.api.shell.list({ location: location.current ? { directory: location.current.directory, workspace: location.current.workspaceID } : undefined })
          .then((response) => {
            const found = response.data.find((s) => s.id === route.shellID)
            if (found) setShellFetch(found)
          })
          .catch(() => undefined)
      }
    }
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={themeV2.background.default}
    >
      <Show when={shell()} fallback={
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={themeV2.text.subdued}>Loading shell data...</text>
        </box>
      }>
        {(s) => (
          <>
            <ShellOutputHeader shell={s()} owner={owner()} now={now()} />
            <ShellOutputStream text={outputText()} loading={loading()} />
            <ShellOutputMetadata shell={s()} owner={owner()} now={now()} />
            <ShellOutputFooter shell={s()} owner={owner()} onKill={kill} onBack={back} />
          </>
        )}
      </Show>
    </box>
  )
}
