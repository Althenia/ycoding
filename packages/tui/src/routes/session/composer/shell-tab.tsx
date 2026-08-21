import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { SessionInfo, ShellInfo } from "@ycoding-ai/client"
import { useClient } from "../../../context/client"
import { useData } from "../../../context/data"
import { Keymap } from "../../../context/keymap"
import { useLocation } from "../../../context/location"
import { useTheme } from "../../../context/theme"
import { useRoute } from "../../../context/route"
import type { SessionShellGroup } from "../../../util/session"
import { formatDuration } from "../../../util/format"
import { abbreviateHome } from "../../../util/path-format"
import { useComposerTab } from "./index"

type ShellEntry = {
  shell: ShellInfo
  owner: SessionShellGroup["owner"]
}

export function formatShellElapsed(shell: ShellInfo, now: number) {
  const completed = shell.status === "running" ? undefined : shell.time.completed
  const duration = Math.max(0, (completed ?? now) - shell.time.started)
  return formatDuration(duration / 1_000)
}

export function ShellRows(props: {
  groups: readonly SessionShellGroup[]
  now: number
  selected: string | undefined
  onSelect: (shell: ShellInfo) => void
  designLabels?: boolean
}) {
  const { themeV2 } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <For each={props.groups}>
      {(group, groupIndex) => {
        const unknown = group.owner.label === "Unknown session"
        return (
          <box flexDirection="column">
            <text fg={unknown ? themeV2.text.feedback.warning.default : themeV2.text.subdued} attributes={TextAttributes.BOLD}>
              {props.designLabels ? shellOwnerLabel(group.owner.label) : group.owner.label}
            </text>
            <Show when={!unknown}>
              <box height={1} />
            </Show>
            <For each={group.shells}>
              {(shell, shellIndex) => {
                const active = createMemo(() => props.selected === shell.id)
                const color = () => (active() ? themeV2.text.action.primary.focused : themeV2.text.action.primary.default)
                return (
                  <>
                    <box
                      flexDirection="row"
                      minWidth={0}
                      backgroundColor={active() ? themeV2.background.action.primary.focused : themeV2.background.action.primary.default}
                      onMouseOver={() => props.onSelect(shell)}
                    >
                      <box width={16} flexShrink={0}>
                        <text fg={active() ? themeV2.text.action.primary.focused : statusColor(shell.status, themeV2)} wrapMode="none">
                          {shell.status}
                        </text>
                      </box>
                      <text fg={color()} attributes={active() ? TextAttributes.BOLD : undefined} wrapMode="none">
                        {shell.command}
                      </text>
                      <Show when={dimensions().width >= 100}>
                        <box width={2} flexShrink={0} />
                        <text fg={active() ? themeV2.text.action.primary.focused : themeV2.text.subdued} wrapMode="none">
                          · {abbreviateHome(shell.cwd, process.env.HOME ?? "")}
                        </text>
                        <box flexGrow={1} />
                        <text fg={active() ? themeV2.text.action.primary.focused : themeV2.text.subdued} wrapMode="none">
                          {shell.status === "running" && shell.pid !== undefined
                            ? `pid ${shell.pid} · ${formatShellElapsed(shell, props.now)}`
                            : `exit — · ${formatShellElapsed(shell, props.now)}`}
                        </text>
                      </Show>
                    </box>
                    <Show when={shellIndex() < group.shells.length - 1}>
                      <box height={1} />
                    </Show>
                  </>
                )
              }}
            </For>
            <Show when={groupIndex() < props.groups.length - 1}>
              <box height={2} />
            </Show>
          </box>
        )
      }}
    </For>
  )
}

export function ShellTab(props: { sessionID: string }) {
  const data = useData()
  const location = useLocation()
  const client = useClient()
  const route = useRoute()
  const { themeV2 } = useTheme()
  const composer = useComposerTab()

  const session = createMemo(() => data.session.get(props.sessionID))
  const shells = createMemo(() => data.shell.list(session()?.location))
  const groups = createMemo(() => pickerShellGroups(shells(), data.session.list(), props.sessionID))
  const entries = createMemo(() => groups().flatMap((group) => group.shells.map((shell) => ({ shell, owner: group.owner }))))
  const [now, setNow] = createSignal(Date.now())
  const [selected, setSelected] = createSignal(0)
  let scroll: ScrollBoxRenderable | undefined

  const selectedEntry = createMemo(() => entries()[selected()])

  createEffect(() => {
    if (!composer.active("shell")) return
    void data.shell.sync(session()?.location).catch((error) => console.error("Failed to load shell commands", error))
  })

  createEffect(() => {
    if (!entries().some((entry) => entry.shell.status === "running")) return
    const interval = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(interval))
  })

  createEffect(() => {
    if (selected() >= entries().length) setSelected(0)
  })

  createEffect(() => {
    if (!scroll) return
    const target = scroll.getChildren()[groupIndex()]
    if (!target) return
    const y = target.y - scroll.y
    if (y >= scroll.height || y < 0) scroll.scrollBy(y - Math.floor(scroll.height / 2))
  })

  const groupIndex = createMemo(() => {
    const entry = selectedEntry()
    if (!entry) return 0
    return groups().findIndex((group) => group.shells.includes(entry.shell))
  })

  function openOutput(entry: ShellEntry) {
    route.navigate({ type: "shell-output", sessionID: props.sessionID, shellID: entry.shell.id })
  }

  onMount(() => {
    const cleanup = composer.register({
      id: "shell",
      label: "Shell",
      hints: () =>
        selectedEntry()
          ? [
              { label: "Enter", shortcut: "view output", gapAfter: 3 },
              { label: "↑↓", shortcut: "move", gapAfter: 4 },
              { label: "⌃x k", shortcut: "kill", gapAfter: 3 },
              { label: "Esc", shortcut: "close" },
            ]
          : [],
    })
    onCleanup(cleanup)
  })

  Keymap.createLayer(() => ({
    mode: "composer",
    enabled: () => composer.active("shell"),
    commands: [
      {
        id: "composer.shell.up",
        title: "Previous shell",
        group: "Composer",
        bind: "up",
        run() {
          if (selected() === 0) {
            composer.close()
            return
          }
          setSelected((previous) => previous - 1)
        },
      },
      {
        id: "composer.shell.down",
        title: "Next shell",
        group: "Composer",
        bind: "down",
        run() {
          const list = entries()
          if (list.length === 0) return
          setSelected((previous) => (previous + 1) % list.length)
        },
      },
      {
        id: "composer.shell.output",
        title: "Open shell output",
        group: "Composer",
        bind: "return",
        run() {
          const entry = selectedEntry()
          if (entry) openOutput(entry)
        },
      },
      {
        id: "composer.shell.kill",
        title: "Kill shell command",
        group: "Composer",
        bind: "<leader>k",
        run() {
          const entry = selectedEntry()
          if (!entry) return
          setSelected(0)
          if (scroll) scroll.scrollTo(0)
          const ref = location.current
          void client.api.shell.remove({
            id: entry.shell.id,
            location: ref ? { directory: ref.directory, workspace: ref.workspaceID } : undefined,
          })
        },
      },
    ],
  }))

  return (
    <Show when={composer.active("shell")}>
      <scrollbox
        scrollbarOptions={{ visible: false }}
        maxHeight={16}
        paddingTop={2}
        ref={(value: ScrollBoxRenderable) => (scroll = value)}
      >
        <Show when={groups().length > 0} fallback={<text fg={themeV2.text.subdued}> No shell commands</text>}>
          <ShellRows
            groups={groups()}
            now={now()}
            selected={selectedEntry()?.shell.id}
            onSelect={(shell) => setSelected(entries().findIndex((entry) => entry.shell.id === shell.id))}
            designLabels
          />
        </Show>
      </scrollbox>
    </Show>
  )
}

function pickerShellGroups(shells: readonly ShellInfo[], sessions: readonly SessionInfo[], currentSessionID: string): SessionShellGroup[] {
  const descendants = descendantSessionIDs(sessions, currentSessionID)
  const owners = [currentSessionID, ...descendants]
  const groups = owners.flatMap((sessionID) => {
    const owned = shells.filter((shell) => shell.metadata.sessionID === sessionID)
    if (owned.length === 0) return []
    const owner = sessions.find((session) => session.id === sessionID)
    return [
      {
        owner: { label: sessionID === currentSessionID ? "Main chat" : `${owner?.agent ?? "Subagent"} · ${owner?.title ?? ""}` },
        shells: owned,
      },
    ]
  })
  const unknown = shells.filter((shell) => {
    const sessionID = shell.metadata.sessionID
    return typeof sessionID !== "string" || !sessions.some((session) => session.id === sessionID)
  })
  if (unknown.length === 0) return groups
  return [...groups, { owner: { label: "Unknown session" }, shells: unknown }]
}

function descendantSessionIDs(sessions: readonly SessionInfo[], parentID: string): string[] {
  return sessions
    .filter((session) => session.parentID === parentID)
    .flatMap((session) => [session.id, ...descendantSessionIDs(sessions, session.id)])
}

function shellOwnerLabel(label: string) {
  if (label === "Main chat") return "MAIN CHAT · THIS SESSION"
  if (label === "Unknown session") return "UNKNOWN SESSION"
  return `SUBAGENT · ${label.toUpperCase()}`
}

function statusColor(status: ShellInfo["status"], themeV2: ReturnType<typeof useTheme>["themeV2"]) {
  if (status === "running") return themeV2.text.feedback.success.default
  if (status === "exited") return themeV2.text.feedback.success.default
  if (status === "timeout") return themeV2.text.feedback.warning.default
  return themeV2.text.feedback.error.default
}
