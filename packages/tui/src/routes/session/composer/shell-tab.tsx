import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { ScrollBoxRenderable, TextAttributes, type BoxRenderable } from "@opentui/core"
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
import { escapeTerminalText } from "../../../util/terminal-text"
import { Locale } from "../../../util/locale"
import { statusColor } from "../../shell-output/util"
import { useComposerTab } from "./index"

type ShellEntry = {
  shell: ShellInfo
  owner: SessionShellGroup["owner"]
}

type ShellRow =
  | { kind: "heading"; id: string; label: string }
  | { kind: "spacer"; id: string }
  | { kind: "shell"; id: string; entry: ShellEntry }

function shellRows(groups: readonly SessionShellGroup[]) {
  const entries = groups.flatMap((group) => group.shells.map((shell) => ({ shell, owner: group.owner })))
  const sections = ["Running", "Archived"]
    .map((label) => ({
      label,
      entries: entries
        .filter((entry) => (label === "Running" ? entry.shell.status === "running" : entry.shell.status !== "running"))
        .sort((a, b) => {
          const time = (entry: ShellEntry) =>
            label === "Archived" ? (entry.shell.time.completed ?? entry.shell.time.started) : entry.shell.time.started
          return time(b) - time(a) || (a.shell.id < b.shell.id ? -1 : a.shell.id > b.shell.id ? 1 : 0)
        }),
    }))
    .filter((section) => section.entries.length > 0)
  return sections.flatMap<ShellRow>((section, index) => [
    ...(index > 0 ? [{ kind: "spacer" as const, id: `spacer:${section.label}` }] : []),
    { kind: "heading", id: `heading:${section.label}`, label: section.label },
    ...section.entries.map((entry) => ({ kind: "shell" as const, id: entry.shell.id, entry })),
  ])
}

export function formatShellElapsed(shell: ShellInfo, now: number) {
  const completed = shell.status === "running" ? undefined : shell.time.completed
  const duration = Math.max(0, (completed ?? now) - shell.time.started)
  return formatDuration(duration / 1_000)
}

function canKillShell(shell: ShellInfo | undefined) {
  return shell?.status === "running"
}

export function ShellRows(props: {
  groups: readonly SessionShellGroup[]
  now: number
  selected: string | undefined
  onSelect: (shell: ShellInfo) => void
}) {
  const { theme } = useTheme()
  const rows = createMemo(() => shellRows(props.groups))

  return (
    <For each={rows().map((row) => row.id)}>
      {(id) => {
        const initial = rows().find((row) => row.id === id)!
        const row = () => rows().find((row) => row.id === id) ?? initial
        const heading = () => {
          const value = row()
          return value.kind === "heading" ? value.label : undefined
        }
        const entry = () => {
          const value = row()
          return value.kind === "shell" ? value.entry : undefined
        }
        return (
          <>
            <Show when={row().kind === "spacer"}>
              <box height={1} flexShrink={0} />
            </Show>
            <Show when={heading()}>
              {(label) => (
                <text
                  height={1}
                  flexShrink={0}
                  fg={theme.text.feedback.info.default}
                  attributes={TextAttributes.BOLD}
                  wrapMode="none"
                >
                  {label()}
                </text>
              )}
            </Show>
            <Show when={entry()}>
              {(entry) => {
                const active = createMemo(() => props.selected === id)
                const color = () => (active() ? theme.text.action.primary.focused : theme.text.action.primary.default)
                const [width, setWidth] = createSignal(0)
                let box: BoxRenderable | undefined
                const ownerWidth = () => Math.min(32, Math.max(12, Math.floor(width() / 4)))
                const elapsed = () => formatShellElapsed(entry().shell, props.now)
                return (
                  <box
                    id={`shell-picker:${id}`}
                    height={1}
                    flexShrink={0}
                    flexDirection="row"
                    minWidth={0}
                    width="100%"
                    ref={(value: BoxRenderable) => {
                      box = value
                      setWidth(value.width)
                    }}
                    onSizeChange={() => setWidth(box?.width ?? 0)}
                    backgroundColor={
                      active() ? theme.background.action.primary.focused : theme.background.action.primary.default
                    }
                    onMouseOver={() => props.onSelect(entry().shell)}
                  >
                    <box width={16} flexShrink={0}>
                      <text
                        fg={active() ? theme.text.action.primary.focused : statusColor(entry().shell.status, theme)}
                        wrapMode="none"
                        truncate
                      >
                        {entry().shell.status}
                      </text>
                    </box>
                    <box flexGrow={1} flexShrink={1} minWidth={0} paddingRight={2}>
                      <text fg={color()} attributes={active() ? TextAttributes.BOLD : undefined} wrapMode="none">
                        {Locale.truncateWidth(
                          escapeTerminalText(entry().shell.command.replace(/\s+/g, " ").trim()),
                          Math.min(72, Math.max(0, width() - 16 - ownerWidth() - elapsed().length - 2)),
                        )}
                      </text>
                    </box>
                    <box width={ownerWidth()} flexShrink={0} paddingRight={2}>
                      <text fg={active() ? theme.text.action.primary.focused : theme.text.subdued} wrapMode="none">
                        {Locale.truncateWidth(
                          escapeTerminalText(entry().owner.label.replace(/\s+/g, " ")),
                          ownerWidth() - 2,
                        )}
                      </text>
                    </box>
                    <text
                      flexShrink={0}
                      fg={active() ? theme.text.action.primary.focused : theme.text.subdued}
                      wrapMode="none"
                    >
                      {elapsed()}
                    </text>
                  </box>
                )
              }}
            </Show>
          </>
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
  const dimensions = useTerminalDimensions()

  const shells = createMemo(() => data.shell.listFamily(props.sessionID))
  const groups = createMemo(() =>
    groupSessionShells(shells(), data.session.list(), props.sessionID, { includeSettled: true }),
  )
  const rows = createMemo(() => shellRows(groups()))
  const entries = createMemo(() => rows().flatMap((row) => (row.kind === "shell" ? [row.entry] : [])))
  const [now, setNow] = createSignal(Date.now())
  const [selected, setSelected] = createSignal<string>()
  let scroll: ScrollBoxRenderable | undefined

  const selectedEntry = createMemo(() => entries().find((entry) => entry.shell.id === selected()))
  let pickerGeneration = 0

  createEffect(() => {
    const sessionID = props.sessionID
    const generation = ++pickerGeneration
    onCleanup(() => {
      pickerGeneration++
    })
    if (!composer.active("shell")) return
    const current = () => generation === pickerGeneration && props.sessionID === sessionID && composer.active("shell")
    void data.shell.syncFamily(sessionID, current).catch((error) => {
      if (current()) console.error("Failed to load shell commands", error)
    })
  })

  createEffect(() => {
    if (!entries().some((entry) => entry.shell.status === "running")) return
    const interval = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(interval))
  })

  createEffect(() => {
    if (!entries().some((entry) => entry.shell.id === selected())) setSelected(entries()[0]?.shell.id)
  })

  createEffect(
    on([rows, selected, dimensions, () => composer.active("shell")], () => {
      const id = selected()
      const reveal = () => {
        if (!id || !scroll || scroll.isDestroyed || selected() !== id || !composer.active("shell")) return
        scroll.scrollChildIntoView(`shell-picker:${id}`)
      }
      reveal()
      const frame = requestAnimationFrame(reveal)
      onCleanup(() => cancelAnimationFrame(frame))
    }),
  )

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
              ...(canKillShell(selectedEntry()?.shell) ? [{ label: "⌃x k", shortcut: "kill", gapAfter: 3 }] : []),
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
          const index = entries().findIndex((entry) => entry.shell.id === selected())
          if (index <= 0) {
            composer.close()
            return
          }
          setSelected(entries()[index - 1]?.shell.id)
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
          const index = list.findIndex((entry) => entry.shell.id === selected())
          setSelected(list[(index + 1) % list.length]?.shell.id)
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
          if (!entry || !canKillShell(entry.shell)) return
          const current = () =>
            generation === pickerGeneration && props.sessionID === sessionID && composer.active("shell")
          const verification = await data.shell.owner(entry.shell, sessionID).then(
            (owner) => ({ owner }),
            (error: unknown) => ({ error }),
          )
          if (!current() || !canKillShell(data.shell.get(entry.shell.id))) return
          if ("error" in verification || !verification.owner) {
            toast.show({
              title: "Failed to verify shell owner",
              message:
                "error" in verification ? errorMessage(verification.error) : "Shell is not available in this family.",
              variant: "error",
            })
            return
          }
          await client.api.shell
            .remove({
              id: entry.shell.id,
              location: {
                directory: verification.owner.location.directory,
                workspace: verification.owner.location.workspaceID,
              },
            })
            .catch((error: unknown) => {
              if (current())
                toast.show({ title: "Failed to kill shell", message: errorMessage(error), variant: "error" })
            })
        },
      },
    ],
  }))

  return (
    <Show when={composer.active("shell")}>
      <scrollbox
        scrollbarOptions={{ visible: false }}
        maxHeight={Math.max(1, Math.min(16, dimensions().height - 16))}
        paddingTop={dimensions().height <= 24 ? 1 : 2}
        ref={(value: ScrollBoxRenderable) => (scroll = value)}
      >
        <Show when={groups().length > 0} fallback={<text fg={theme.text.subdued}> No shell commands</text>}>
          <ShellRows
            groups={groups()}
            now={now()}
            selected={selectedEntry()?.shell.id}
            onSelect={(shell) => setSelected(shell.id)}
          />
        </Show>
      </scrollbox>
    </Show>
  )
}
