import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { ShellInfo } from "@ycoding-ai/client"
import { useClient } from "../../../context/client"
import { useData } from "../../../context/data"
import { Keymap } from "../../../context/keymap"
import { useTheme } from "../../../context/theme"
import { useToast } from "../../../ui/toast"
import { errorMessage } from "../../../util/error"
import { useRoute } from "../../../context/route"
import { groupSessionShells, type SessionShellGroup } from "../../../util/session"
import { formatDuration } from "../../../util/format"
import { abbreviateHome } from "../../../util/path-format"
import { shellStatusLabel, statusColor } from "../../shell-output/util"
import { useComposerTab } from "./index"

type ShellEntry = {
  shell: ShellInfo
  owner: SessionShellGroup["owner"]
}

export function formatShellElapsed(shell: ShellInfo, now: number) {
  const completed = shell.status === "running" || shell.status === "queued" ? undefined : shell.time.completed
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
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <For each={props.groups}>
      {(group, groupIndex) => {
        return (
          <box flexDirection="column">
            <text fg={theme.text.subdued} attributes={TextAttributes.BOLD}>
              {props.designLabels ? shellOwnerLabel(group.owner.label) : group.owner.label}
            </text>
            <box height={1} />
            <For each={group.shells}>
              {(shell, shellIndex) => {
                const active = createMemo(() => props.selected === shell.id)
                const color = () => (active() ? theme.text.action.primary.focused : theme.text.action.primary.default)
                return (
                  <>
                    <box
                      flexDirection="row"
                      minWidth={0}
                      backgroundColor={active() ? theme.background.action.primary.focused : theme.background.action.primary.default}
                      onMouseOver={() => props.onSelect(shell)}
                    >
                      <box width={16} flexShrink={0}>
                        <text fg={active() ? theme.text.action.primary.focused : statusColor(shell.status, theme)} wrapMode="none">
                          {shellStatusLabel(shell)}
                        </text>
                      </box>
                      <text fg={color()} attributes={active() ? TextAttributes.BOLD : undefined} wrapMode="none">
                        {shell.command}
                      </text>
                      <Show when={dimensions().width >= 100}>
                        <box width={2} flexShrink={0} />
                        <text fg={active() ? theme.text.action.primary.focused : theme.text.subdued} wrapMode="none">
                          · {abbreviateHome(shell.cwd, process.env.HOME ?? "")}
                        </text>
                        <box flexGrow={1} />
                        <text fg={active() ? theme.text.action.primary.focused : theme.text.subdued} wrapMode="none">
                          {shell.status === "queued"
                            ? `waiting · ${formatShellElapsed(shell, props.now)}`
                            : shell.status === "running" && shell.pid !== undefined
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
  const client = useClient()
  const route = useRoute()
  const { theme } = useTheme()
  const composer = useComposerTab()
  const toast = useToast()

  const shells = createMemo(() => data.shell.listFamily(props.sessionID))
  const groups = createMemo(() => groupSessionShells(shells(), data.session.list(), props.sessionID, { includeSettled: true }))
  const entries = createMemo(() => groups().flatMap((group) => group.shells.map((shell) => ({ shell, owner: group.owner }))))
  const [now, setNow] = createSignal(Date.now())
  const [selected, setSelected] = createSignal(0)
  let scroll: ScrollBoxRenderable | undefined

  const selectedEntry = createMemo(() => entries()[selected()])
  let pickerGeneration = 0

  createEffect(() => {
    const sessionID = props.sessionID
    const generation = ++pickerGeneration
    onCleanup(() => { pickerGeneration++ })
    if (!composer.active("shell")) return
    const current = () => generation === pickerGeneration && props.sessionID === sessionID && composer.active("shell")
    void data.shell.syncFamily(sessionID, current).catch((error) => { if (current()) console.error("Failed to load shell commands", error) })
  })

  createEffect(() => {
    if (!entries().some((entry) => entry.shell.status === "running" || entry.shell.status === "queued")) return
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
        async run() {
          const generation = pickerGeneration
          const sessionID = props.sessionID
          const entry = selectedEntry()
          if (!entry) return
          const current = () => generation === pickerGeneration && props.sessionID === sessionID && composer.active("shell")
          const verification = await data.shell.owner(entry.shell, sessionID).then((owner) => ({ owner }), (error: unknown) => ({ error }))
          if (!current()) return
          if ("error" in verification || !verification.owner) {
            toast.show({ title: "Failed to verify shell owner", message: "error" in verification ? errorMessage(verification.error) : "Shell is not available in this family.", variant: "error" })
            return
          }
          await client.api.shell.remove({
            id: entry.shell.id,
            location: { directory: verification.owner.location.directory, workspace: verification.owner.location.workspaceID },
          }).then(() => {
            if (!current()) return
            setSelected(0)
            if (scroll) scroll.scrollTo(0)
          }, (error: unknown) => {
            if (current()) toast.show({ title: "Failed to kill shell", message: errorMessage(error), variant: "error" })
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
        <Show when={groups().length > 0} fallback={<text fg={theme.text.subdued}> No shell commands</text>}>
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

function shellOwnerLabel(label: string) {
  if (label === "Main chat") return "MAIN CHAT · THIS SESSION"
  return `SUBAGENT · ${label.toUpperCase()}`
}
