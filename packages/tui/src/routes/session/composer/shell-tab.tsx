import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { ShellInfo } from "@ycoding-ai/client"
import { useClient } from "../../../context/client"
import { useData } from "../../../context/data"
import { Keymap } from "../../../context/keymap"
import { useLocation } from "../../../context/location"
import { useTheme } from "../../../context/theme"
import { useRoute } from "../../../context/route"
import { groupSessionShells, type SessionShellGroup } from "../../../util/session"
import { useComposerTab } from "./index"

type ShellEntry = {
  shell: ShellInfo
  owner: SessionShellGroup["owner"]
}

export function formatShellElapsed(shell: ShellInfo, now: number) {
  const completed = shell.status === "running" ? undefined : shell.time.completed
  const duration = Math.max(0, (completed ?? now) - shell.time.started)
  const seconds = Math.floor(duration / 1_000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

export function ShellRows(props: {
  groups: readonly SessionShellGroup[]
  now: number
  selected: string | undefined
  onSelect: (shell: ShellInfo) => void
}) {
  const { themeV2 } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <For each={props.groups}>
      {(group) => (
        <box flexDirection="column">
          <text
            fg={group.owner.label === "Unknown session" ? themeV2.text.feedback.warning.default : themeV2.text.subdued}
            attributes={TextAttributes.BOLD}
          >
            {group.owner.label}
          </text>
          <For each={group.shells}>
            {(shell) => {
              const active = createMemo(() => props.selected === shell.id)
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    active() ? themeV2.background.action.primary.focused : themeV2.background.action.primary.default
                  }
                  onMouseOver={() => props.onSelect(shell)}
                >
                  <text
                    fg={active() ? themeV2.text.action.primary.focused : themeV2.text.action.primary.default}
                    attributes={active() ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {shell.command}
                  </text>
                  <Show when={dimensions().width >= 100}>
                    <text fg={active() ? themeV2.text.action.primary.focused : themeV2.text.subdued} wrapMode="none">
                      {shell.cwd}
                    </text>
                    <Show when={shell.pid !== undefined}>
                      <text fg={active() ? themeV2.text.action.primary.focused : themeV2.text.subdued} wrapMode="none">
                        pid {shell.pid}
                      </text>
                    </Show>
                    <text fg={active() ? themeV2.text.action.primary.focused : themeV2.text.subdued} wrapMode="none">
                      {formatShellElapsed(shell, props.now)}
                    </text>
                  </Show>
                  <text fg={active() ? themeV2.text.action.primary.focused : statusColor(shell.status, themeV2)} wrapMode="none">
                    {shell.status}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      )}
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
  const shortcuts = Keymap.useShortcuts()

  const groups = createMemo(() => groupSessionShells(data.shell.list(), data.session.list(), props.sessionID))
  const entries = createMemo(() => groups().flatMap((group) => group.shells.map((shell) => ({ shell, owner: group.owner }))))
  const [now, setNow] = createSignal(Date.now())
  const [selected, setSelected] = createSignal(0)
  let scroll: ScrollBoxRenderable | undefined

  const selectedEntry = createMemo(() => entries()[selected()])

  createEffect(() => {
    if (!entries().some((entry) => entry.shell.status === "running")) return
    const interval = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(interval))
  })

  createEffect(() => {
    if (selected() >= entries().length) setSelected(Math.max(0, entries().length - 1))
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
      hints: () => {
        if (!selectedEntry()) return []
        return [
          { label: "output", shortcut: shortcuts.get("composer.shell.output") ?? "" },
          { label: "kill", shortcut: shortcuts.get("composer.shell.kill") ?? "" },
        ]
      },
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
        bind: "ctrl+d",
        run() {
          const entry = selectedEntry()
          if (!entry) return
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
      <scrollbox scrollbarOptions={{ visible: false }} maxHeight={8} ref={(value: ScrollBoxRenderable) => (scroll = value)}>
        <Show when={groups().length > 0} fallback={<text fg={themeV2.text.subdued}> No shell commands</text>}>
          <ShellRows
            groups={groups()}
            now={now()}
            selected={selectedEntry()?.shell.id}
            onSelect={(shell) => setSelected(entries().findIndex((entry) => entry.shell.id === shell.id))}
          />
        </Show>
      </scrollbox>
    </Show>
  )
}

function statusColor(status: ShellInfo["status"], themeV2: ReturnType<typeof useTheme>["themeV2"]) {
  if (status === "running") return themeV2.text.feedback.success.default
  if (status === "exited") return themeV2.text.feedback.success.default
  if (status === "timeout") return themeV2.text.feedback.warning.default
  return themeV2.text.feedback.error.default
}
