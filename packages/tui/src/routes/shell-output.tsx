import { Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { useRoute, useRouteData } from "../context/route"
import { useData } from "../context/data"
import { useClient } from "../context/client"
import { useTheme } from "../context/theme"
import { Keymap } from "../context/keymap"
import { groupSessionShells } from "../util/session"
import { useTerminalDimensions } from "@opentui/solid"
import stripAnsi from "strip-ansi"
import type { ShellInfo } from "@ycoding-ai/client"
import { appendShellOutputTail } from "./shell-output/util"
import { ShellOutputHeader } from "./shell-output/header"
import { ShellOutputStream } from "./shell-output/stream"
import { ShellOutputMetadata } from "./shell-output/metadata"
import { ShellOutputFooter } from "./shell-output/footer"

export function ShellOutput() {
  const route = useRouteData("shell-output")
  const { navigate } = useRoute()
  const data = useData()
  const client = useClient()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const [shellFetch, setShellFetch] = createSignal<ShellInfo | undefined>()
  const [lookup, setLookup] = createSignal<"loading" | "ready" | "error">("loading")

  const shell = createMemo(() => {
    if (lookup() !== "ready") return undefined
    const fromStore = data.shell.get(route.shellID) ?? data.shell.list().find((s) => s.id === route.shellID)
    const candidate = fromStore ?? shellFetch()
    if (!candidate || candidate.id !== route.shellID) return undefined
    return groupSessionShells([candidate], data.session.list(), route.sessionID, { includeSettled: true }).length
      ? candidate
      : undefined
  })
  const sessions = createMemo(() => data.session.list())
  const groups = createMemo(() =>
    groupSessionShells(shell() ? [shell()!] : [], sessions(), route.sessionID, { includeSettled: true }),
  )
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
  const [outputError, setOutputError] = createSignal<string>()

  let readGeneration = 0
  let outputLoading: number | undefined
  let settlementPending = false
  let wasLive = false
  onCleanup(() => {
    readGeneration++
  })
  onCleanup(
    data.on("shell.deleted", (event) => {
      if (event.data.id !== route.shellID) return
      readGeneration++
      settlementPending = false
      wasLive = false
      outputLoading = undefined
      setLookup("error")
      setShellFetch(undefined)
      setOutputText("")
      setCursor(0)
      setLoading(false)
      setOutputError(undefined)
    }),
  )

  createEffect(() => {
    const sessionID = route.sessionID
    const shellID = route.shellID
    const generation = ++readGeneration
    settlementPending = false
    wasLive = false
    setLookup("loading")
    setShellFetch(undefined)
    setOutputText("")
    setCursor(0)
    setLoading(false)
    setOutputError(undefined)
    void findShell(sessionID, shellID, generation)
  })

  async function findShell(sessionID: string, shellID: string, generation: number) {
    const members = await data.shell.syncFamily(sessionID, () => generation === readGeneration).catch(() => undefined)
    if (generation !== readGeneration) return
    if (!members) {
      setLookup("error")
      return
    }
    const locations = new Map(members.map((member) => [JSON.stringify(member.location), member.location]))
    for (const ref of locations.values()) {
      if (generation !== readGeneration) return
      const response = await client.api.shell
        .get({ id: shellID, location: { directory: ref.directory, workspace: ref.workspaceID } })
        .catch(() => undefined)
      if (generation !== readGeneration) return
      if (!response || response.data.id !== shellID) continue
      const owner = await data.shell.owner(response.data, sessionID).catch(() => undefined)
      if (generation !== readGeneration) return
      if (!owner || owner.location.directory !== ref.directory || owner.location.workspaceID !== ref.workspaceID)
        continue
      setShellFetch(response.data)
      setLookup("ready")
      return
    }
    setLookup("error")
  }

  createEffect(() => {
    const s = shell()
    if (!s || s.status !== "running") return
    const interval = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(interval))
  })

  async function loadOutput(settled = false) {
    const generation = readGeneration
    if (outputLoading === generation) {
      if (settled) settlementPending = true
      return
    }
    const s = untrack(shell)
    if (!s) return
    outputLoading = generation
    settlementPending = false
    setLoading(true)
    setOutputError(undefined)
    while (generation === readGeneration) {
      const owner = await data.shell.owner(s, route.sessionID).catch(() => undefined)
      if (generation !== readGeneration) return
      if (!owner || untrack(shell)?.metadata.sessionID !== s.metadata.sessionID) {
        setLookup("error")
        break
      }
      const from = untrack(cursor)
      const response = await client.api.shell
        .output({
          id: s.id,
          cursor: from,
          limit: 64 * 1024,
          location: { directory: owner.location.directory, workspace: owner.location.workspaceID },
        })
        .catch(() => undefined)
      if (generation !== readGeneration) return
      if (!response) {
        setOutputError("Captured output could not be read.")
        break
      }
      if (untrack(shell)?.id !== s.id || untrack(shell)?.metadata.sessionID !== s.metadata.sessionID) {
        setLookup("error")
        break
      }
      const page = response.data
      if (page.output) setOutputText((current) => appendShellOutputTail(current, stripAnsi(page.output)))
      setCursor(page.cursor)
      if (page.cursor <= from || page.cursor >= page.size) {
        if (settlementPending) {
          settlementPending = false
          continue
        }
        break
      }
    }
    if (generation !== readGeneration) return
    outputLoading = undefined
    settlementPending = false
    setLoading(false)
  }

  createEffect(() => {
    const s = shell()
    if (!s) return
    const live = s.status === "running"
    const settled = wasLive && !live
    wasLive = live
    void loadOutput(settled)
  })

  createEffect(() => {
    const s = shell()
    if (!s || outputError() || s.status !== "running") return
    const interval = setInterval(() => void loadOutput(), 1_000)
    onCleanup(() => clearInterval(interval))
  })

  function back() {
    navigate({ type: "session", sessionID: route.sessionID })
  }

  async function kill() {
    const generation = readGeneration
    const s = shell()
    if (!s || s.status !== "running") return
    const owner = await data.shell.owner(s, route.sessionID).catch(() => undefined)
    if (generation !== readGeneration) return
    if (!owner || shell()?.metadata.sessionID !== s.metadata.sessionID) {
      setLookup("error")
      return
    }
    await client.api.shell
      .remove({
        id: s.id,
        location: { directory: owner.location.directory, workspace: owner.location.workspaceID },
      })
      .catch(() => {
        if (generation === readGeneration) setOutputError("Shell could not be stopped.")
      })
  }

  function retry() {
    if (shell()) {
      void loadOutput()
      return
    }
    setLookup("loading")
    void findShell(route.sessionID, route.shellID, ++readGeneration)
  }

  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        id: "shell-output.retry",
        title: "Retry shell output",
        group: "Shell Output",
        bind: "r",
        run: retry,
      },
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

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background.default}
    >
      <Show
        when={shell()}
        fallback={
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <Show when={lookup() !== "loading"} fallback={<text fg={theme.text.subdued}>Loading shell data...</text>}>
              <text fg={theme.text.feedback.error.default}>Shell is not available in this family.</text>
              <text fg={theme.text.feedback.info.default} onMouseUp={retry}>
                Retry shell lookup · r
              </text>
            </Show>
          </box>
        }
      >
        {(s) => (
          <>
            <ShellOutputHeader shell={s()} owner={owner()} now={now()} />
            <ShellOutputStream text={outputText()} loading={loading()} error={outputError()} onRetry={retry} />
            <ShellOutputMetadata shell={s()} owner={owner()} now={now()} />
            <ShellOutputFooter shell={s()} owner={owner()} onKill={kill} onBack={back} />
          </>
        )}
      </Show>
    </box>
  )
}
