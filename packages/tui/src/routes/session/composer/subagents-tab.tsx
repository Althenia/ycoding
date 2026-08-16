import type { SessionCacheDiagnostics, SessionInfo, SessionOrchestrationTask } from "@ycoding-ai/client"
import { createMemo, For, Show, createEffect, createSignal, onMount, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { TextAttributes, ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useRoute, useRouteData } from "../../../context/route"
import { useData } from "../../../context/data"
import { useClient } from "../../../context/client"
import { useTheme } from "../../../context/theme"
import { Locale } from "../../../util/locale"
import { Keymap } from "../../../context/keymap"
import { formatDiagnosticsModel } from "../../../util/cache-diagnostics"
import { activeSubagentSessionIDs, isActiveSubagent } from "../../../util/subagent"
import { useComposerTab } from "./index"
import { getGlyph } from "../../../ui/glyph"

export { activeSubagentSessionIDs, isActiveSubagent } from "../../../util/subagent"

interface SubagentEntry {
  sessionID: string
  agent: string
  title: string
  detail?: string
  awaitingInput: boolean
  status: SessionOrchestrationTask["state"]
  model?: string
  startedAt?: number
  current: boolean
}

type CancelClient = {
  readonly api: {
    readonly session: {
      readonly subagent: {
        readonly cancel: (input: { parentID: string; childID: string }) => Promise<unknown>
      }
    }
  }
}

export function formatSubagentModel(model: { providerID: string; id: string; variant?: string } | undefined) {
  return formatDiagnosticsModel(model)
}

export function formatSubagentCacheHit(diagnostics: SessionCacheDiagnostics | null | undefined) {
  return diagnostics?.cache.hitRatio === undefined ? undefined : `${Math.round(diagnostics.cache.hitRatio * 100)}% hit`
}

export function formatSubagentElapsed(startedAt: number | undefined, now: number) {
  if (startedAt === undefined) return undefined
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
}

export function entriesFromTasks(
  tasks: ReadonlyArray<SessionOrchestrationTask>,
  currentSessionID: string,
): SubagentEntry[] {
  return [...tasks]
    .sort((a, b) => {
      const state = Number(isActiveSubagent(b.state)) - Number(isActiveSubagent(a.state))
      if (state !== 0) return state
      const created = b.time.created - a.time.created
      if (created !== 0) return created
      return a.sessionID.localeCompare(b.sessionID)
    })
    .map((task) => ({
      sessionID: task.sessionID,
      agent: Locale.titlecase(task.agent),
      title: task.description,
      detail: task.question?.text ?? task.progress?.text,
      awaitingInput: Boolean(task.question?.text),
      status: task.state,
      model: formatSubagentModel(task.model),
      startedAt: task.time.created,
      current: task.sessionID === currentSessionID,
    }))
}

export function entriesFromBtwSessions(sessions: ReadonlyArray<SessionInfo>, currentSessionID: string): SubagentEntry[] {
  return sessions
    .filter((session) => session.agent === "btw")
    .toSorted((left, right) => {
      const created = left.time.created - right.time.created
      if (created !== 0) return created
      return left.id.localeCompare(right.id)
    })
    .map((session) => ({
      sessionID: session.id,
      agent: "BTW",
      title: session.title,
      status: "completed",
      model: formatSubagentModel(session.model),
      startedAt: session.time.created,
      current: session.id === currentSessionID,
      awaitingInput: false,
    }))
}

export function subagentSections(entries: ReadonlyArray<SubagentEntry>) {
  const active = entries.filter((entry) => isActiveSubagent(entry.status))
  const inactive = entries.filter((entry) => !isActiveSubagent(entry.status))
  return [
    ...(active.length > 0 ? [{ label: "ACTIVE", entries: active }] : []),
    ...(inactive.length > 0 ? [{ label: "INACTIVE", entries: inactive }] : []),
  ]
}

export function subagentScrollIndex(entries: ReadonlyArray<SubagentEntry>, index: number) {
  const active = entries.filter((entry) => isActiveSubagent(entry.status)).length
  const questionRowsBefore = entries.slice(0, index).filter((entry) => entry.awaitingInput).length
  return index + Number(active > 0) + Number(index >= active && entries.length > active) + questionRowsBefore
}

export function taskStatusLabel(state: SessionOrchestrationTask["state"]) {
  return {
    starting: "Starting",
    running: "Running",
    waiting: "Waiting",
    cancelling: "Cancelling",
    cancelled: "Cancelled",
    completed: "Completed",
    failed: "Failed",
    lost: "Lost",
  }[state]
}

export function canCancelSubagent(state: SessionOrchestrationTask["state"]) {
  return state === "running" || state === "waiting"
}

export function cancelManagedSubagent(client: CancelClient, parentID: string, childID: string) {
  return client.api.session.subagent.cancel({ parentID, childID })
}

export function SubagentMetadata(props: {
  model?: string
  cacheHit?: string
  elapsed?: string
  status?: string
  active: boolean
}) {
  const { themeV2 } = useTheme()
  const color = () => (props.active ? themeV2.text.action.primary.focused : themeV2.text.subdued)
  const telemetry = () => [props.cacheHit, props.elapsed].filter((value): value is string => Boolean(value))

  return (
    <box flexDirection="row" minWidth={0} gap={1}>
      <Show when={props.model}>
        <box minWidth={0} maxWidth={40} flexShrink={1}>
          <text fg={color()} wrapMode="none">
            {props.model}
          </text>
        </box>
      </Show>
      <Show when={props.model && (telemetry().length > 0 || props.status)}>
        <text fg={color()} flexShrink={0}>
          ·
        </text>
      </Show>
      <For each={telemetry()}>
        {(item, index) => (
          <>
            <text fg={color()} wrapMode="none" flexShrink={0}>
              {item}
            </text>
            <Show when={index() < telemetry().length - 1 || props.status}>
              <text fg={color()} flexShrink={0}>
                ·
              </text>
            </Show>
          </>
        )}
      </For>
      <Show when={props.status}>
        <text fg={color()} wrapMode="none" flexShrink={0}>
          {props.status}
        </text>
      </Show>
    </box>
  )
}

export function SubagentsTab(props: { sessionID: string }) {
  const route = useRouteData("session")
  const data = useData()
  const client = useClient()
  const { themeV2 } = useTheme()
  const navigation = useRoute()
  const navigate = (input: Parameters<typeof navigation.navigate>[0]) => navigation.navigate(input)
  const composer = useComposerTab()
  const shortcuts = Keymap.useShortcuts()
  const dimensions = useTerminalDimensions()

  const session = createMemo(() => data.session.get(props.sessionID))
  const parentID = createMemo(() => session()?.parentID ?? props.sessionID)
  const entries = createMemo(() => {
    const tasks = entriesFromTasks(data.session.subagent.list(parentID()), route.sessionID)
    const taskIDs = new Set(tasks.map((task) => task.sessionID))
    return [
      ...tasks,
      ...entriesFromBtwSessions(
        data.session.family(parentID()).flatMap((sessionID) => {
          const session = data.session.get(sessionID)
          return session ? [session] : []
        }),
        route.sessionID,
      ).filter((entry) => !taskIDs.has(entry.sessionID)),
    ]
  })
  const sections = createMemo(() => subagentSections(entries()))
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    if (!composer.active("subagents")) return
    const id = parentID()
    void data.session.subagent.sync(id).catch((error) => console.error("Failed to load durable subagent tasks", error))
  })
  createEffect(() => {
    if (!composer.active("subagents")) return
    entries().forEach((entry) => void data.session.diagnostics.sync(entry.sessionID).catch(() => undefined))
  })
  createEffect(() => {
    if (dimensions().width < 100 || !composer.active("subagents") || !entries().some((entry) => entry.status === "running")) return
    const interval = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(interval))
  })

  const [store, setStore] = createStore({ selected: 0 })
  let selectedSessionID = ""
  let wasActive = false
  let scroll: ScrollBoxRenderable | undefined

  const selected = createMemo(() => store.selected)
  const selectedEntry = createMemo(() => entries()[selected()])

  createEffect(() => {
    const active = composer.active("subagents")
    if (!active) {
      if (wasActive) {
        selectedSessionID = ""
        setStore("selected", 0)
      }
      wasActive = false
      return
    }
    const list = entries()
    if (selectedSessionID !== route.sessionID && list.length > 0) {
      const currentIdx = list.findIndex((entry) => entry.current)
      const next = currentIdx >= 0 ? currentIdx : 0
      selectedSessionID = route.sessionID
      setStore("selected", next)
      const scrollCurrentIntoView = () => scrollToIndex(next, true)
      scrollCurrentIntoView()
      requestAnimationFrame(scrollCurrentIntoView)
    }
    wasActive = true
    if (store.selected >= list.length) moveTo(Math.max(0, list.length - 1))
  })

  function moveTo(next: number, center = false) {
    setStore("selected", next)
    scrollToIndex(next, center)
  }

  function scrollToIndex(index: number, center: boolean) {
    if (!scroll) return
    const rowIndex = subagentScrollIndex(entries(), index)
    if (center) {
      scroll.scrollTo(Math.max(0, rowIndex - Math.floor(scroll.viewport.height / 2)))
      return
    }
    if (rowIndex >= scroll.scrollTop + scroll.viewport.height) scroll.scrollTo(rowIndex - scroll.viewport.height + 1)
    if (rowIndex < scroll.scrollTop) scroll.scrollTo(rowIndex)
  }

  onMount(() => {
    const cleanup = composer.register({
      id: "subagents",
      label: "Subagents",
      hints: () => {
        const entry = selectedEntry()
        if (!entry || !canCancelSubagent(entry.status)) return []
        return [
          {
            label: "cancel",
            shortcut: shortcuts.get("composer.subagent.interrupt") ?? "",
          },
        ]
      },
      onClose: () => {
        const id = session()?.parentID
        if (id) navigate({ type: "session", sessionID: id })
      },
    })
    onCleanup(cleanup)
  })

  Keymap.createLayer(() => ({
    mode: "composer",
    enabled: () => composer.active("subagents"),
    commands: [
      {
        id: "composer.subagent.up",
        title: "Previous subagent",
        group: "Composer",
        bind: "up",
        run() {
          if (store.selected === 0) {
            composer.close()
            return
          }
          moveTo(store.selected - 1, true)
        },
      },
      {
        id: "composer.subagent.down",
        title: "Next subagent",
        group: "Composer",
        bind: "down",
        run() {
          const list = entries()
          if (list.length === 0) return
          moveTo((store.selected + 1) % list.length, true)
        },
      },
      {
        id: "composer.subagent.select",
        title: "Navigate to subagent",
        group: "Composer",
        bind: "return",
        run() {
          const entry = entries()[store.selected]
          if (entry) navigate({ type: "session", sessionID: entry.sessionID })
        },
      },
      {
        id: "composer.subagent.interrupt",
        title: "Cancel subagent",
        group: "Composer",
        bind: "ctrl+d",
        run() {
          const entry = selectedEntry()
          if (!entry || !canCancelSubagent(entry.status)) return
          const id = parentID()
          void cancelManagedSubagent(client, id, entry.sessionID)
            .then(() => {
              data.session.subagent.invalidate(id)
              return data.session.subagent.sync(id)
            })
            .catch((error) => console.error("Failed to cancel durable subagent task", error))
        },
      },
    ],
  }))

  return (
    <Show when={composer.active("subagents")}>
      <scrollbox
        scrollbarOptions={{ visible: false }}
        maxHeight={8}
        ref={(value: ScrollBoxRenderable) => (scroll = value)}
      >
        <Show when={entries().length > 0} fallback={<text fg={themeV2.text.subdued}> No subagents</text>}>
          <For each={sections()}>
            {(section) => (
              <box flexDirection="column">
                <text fg={themeV2.text.subdued} attributes={TextAttributes.BOLD}>
                  {section.label}
                </text>
                <For each={section.entries}>
                  {(entry) => {
                    const entryIndex = createMemo(() => entries().indexOf(entry))
                    const active = createMemo(() => entryIndex() === selected())
                    const awaitingInput = createMemo(() => entry.awaitingInput)
                    return (
                      <box
                        flexDirection="column"
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={
                          active()
                            ? themeV2.background.action.primary.focused
                            : entry.current
                              ? themeV2.background.action.primary.selected
                              : themeV2.background.action.primary.default
                        }
                        onMouseOver={() => setStore("selected", entryIndex())}
                        onMouseUp={() => {
                          setStore("selected", entryIndex())
                          navigate({
                            type: "session",
                            sessionID: entry.sessionID,
                          })
                        }}
                      >
                        <box flexDirection="row" minWidth={0} flexGrow={1}>
                          <text
                            fg={
                              active()
                                ? themeV2.text.action.primary.focused
                                : entry.current
                                  ? themeV2.text.action.primary.selected
                                  : themeV2.text.action.primary.default
                            }
                            attributes={active() ? TextAttributes.BOLD : undefined}
                            wrapMode="none"
                          >
                            <span
                              style={{
                                fg: awaitingInput()
                                  ? themeV2.text.feedback.warning.default
                                  : themeV2.text.feedback.info.default,
                              }}
                            >
                              {getGlyph(awaitingInput() ? "awaitingInput" : "subagent").rendered}
                            </span>
                            {entry.agent}: {entry.title}
                          </text>
                          <box flexGrow={1} />
                          <SubagentMetadata
                            model={entry.model}
                            cacheHit={dimensions().width >= 100 ? formatSubagentCacheHit(data.session.diagnostics.get(entry.sessionID)) : undefined}
                            elapsed={
                              dimensions().width >= 100 && entry.status === "running"
                                ? formatSubagentElapsed(entry.startedAt, now())
                                : undefined
                            }
                            status={taskStatusLabel(entry.status)}
                            active={active()}
                          />
                        </box>
                        <Show when={entry.awaitingInput && entry.detail}>
                          <text fg={themeV2.text.subdued} paddingLeft={2} wrapMode="none">
                            └ {entry.detail}
                          </text>
                        </Show>
                      </box>
                    )
                  }}
                </For>
              </box>
            )}
          </For>
        </Show>
      </scrollbox>
    </Show>
  )
}
