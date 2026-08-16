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
import { stringWidth } from "../../../util/string-width"
import { formatDiagnosticsModel } from "../../../util/cache-diagnostics"
import { activeSubagentSessionIDs, isActiveSubagent } from "../../../util/subagent"
import { railPlacement, railWidth } from "../rail"
import { useComposerTab } from "./index"

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

const taskStateOrder = {
  waiting: 0,
  starting: 1,
  running: 1,
  cancelling: 2,
  completed: 3,
  cancelled: 4,
  failed: 5,
  lost: 6,
} as const

export function formatSubagentModel(model: { providerID: string; id: string; variant?: string } | undefined) {
  return formatDiagnosticsModel(model)
}

export function formatSubagentCacheHit(diagnostics: SessionCacheDiagnostics | null | undefined) {
  return diagnostics?.cache.hitRatio === undefined ? "—" : `${Math.round(diagnostics.cache.hitRatio * 100)}% hit`
}

export function formatSubagentElapsed(startedAt: number | undefined, now: number) {
  if (startedAt === undefined) return undefined
  return Locale.duration(Math.max(0, now - startedAt))
}

export function entriesFromTasks(
  tasks: ReadonlyArray<SessionOrchestrationTask>,
  currentSessionID: string,
): SubagentEntry[] {
  return [...tasks]
    .sort((a, b) => {
      const state = taskStateOrder[a.state] - taskStateOrder[b.state]
      if (state !== 0) return state
      const created = b.time.created - a.time.created
      if (created !== 0) return created
      return a.sessionID.localeCompare(b.sessionID)
    })
    .map((task) => ({
      sessionID: task.sessionID,
      agent: task.agent,
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
    starting: "starting",
    running: "running",
    waiting: "? awaiting",
    cancelling: "cancelling",
    cancelled: "cancelled",
    completed: "completed",
    failed: "failed",
    lost: "lost",
  }[state]
}

export function canCancelSubagent(state: SessionOrchestrationTask["state"]) {
  return state === "starting" || state === "running" || state === "waiting"
}

export function cancelManagedSubagent(client: CancelClient, parentID: string, childID: string) {
  return client.api.session.subagent.cancel({ parentID, childID })
}

/** Status column, longest rendered agent label, and the description floor the metadata may not eat. */
const STATUS_WIDTH = 16
const AGENT_WIDTH = 16
const TITLE_MIN_WIDTH = 8
/** Composer padding (3 left, 4 right) plus the row's own right padding. */
const COMPOSER_INSET = 8

/**
 * The picker row shares its terminal with the docked rail, so the widest row it can own is the
 * terminal minus the rail and the composer insets. Trailing fields drop whole rather than collide,
 * and the model truncates only when it cannot fit on its own.
 */
export function subagentMetadata(input: {
  width: number
  model?: string
  status?: string
  cacheHit?: string
  elapsed?: string
}) {
  const budget =
    input.width -
    (railPlacement(input.width) === "docked" ? Math.round(railWidth(input.width)) : 0) -
    COMPOSER_INSET -
    STATUS_WIDTH -
    AGENT_WIDTH -
    TITLE_MIN_WIDTH -
    4
  const fields = [input.model, input.status, input.cacheHit, input.elapsed].filter(
    (value): value is string => Boolean(value),
  )
  for (let count = fields.length; count > 1; count--) {
    const value = fields.slice(0, count).join(" · ")
    if (stringWidth(value) <= budget) return value
  }
  return Locale.truncateWidth(fields[0] ?? "", budget)
}

export function SubagentMetadata(props: { model?: string; cacheHit?: string; elapsed?: string; status?: string }) {
  const { themeV2 } = useTheme()
  const dimensions = useTerminalDimensions()
  const metadata = createMemo(() =>
    subagentMetadata({
      width: dimensions().width,
      model: props.model,
      status: props.status,
      cacheHit: props.cacheHit,
      elapsed: props.elapsed,
    }),
  )

  return (
    <Show when={metadata()}>
      {(value) => (
        <box flexShrink={0}>
          <text fg={themeV2.text.subdued} wrapMode="none">
            {value()}
          </text>
        </box>
      )}
    </Show>
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
  const dimensions = useTerminalDimensions()

  const session = createMemo(() => data.session.get(props.sessionID))
  const parentID = createMemo(() => session()?.parentID ?? props.sessionID)
  const page = createMemo(() => data.session.subagent.page(parentID()))
  const pager = createMemo(() => data.session.subagent.navigation(parentID()))
  const entries = createMemo(() => entriesFromTasks(page()?.data ?? [], route.sessionID))
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
  let selectedEntryID = ""
  let activeRouteSessionID = ""
  let wasActive = false
  let scroll: ScrollBoxRenderable | undefined

  const selected = createMemo(() => store.selected)
  const selectedEntry = createMemo(() => entries()[selected()])

  createEffect(() => {
    const active = composer.active("subagents")
    if (!active) {
      if (wasActive) {
        selectedEntryID = ""
        activeRouteSessionID = ""
        setStore("selected", 0)
      }
      wasActive = false
      return
    }
    const list = entries()
    if (activeRouteSessionID !== route.sessionID) {
      activeRouteSessionID = route.sessionID
      selectedEntryID = route.sessionID
    }
    const selectedIdx = list.findIndex((entry) => entry.sessionID === selectedEntryID)
    if (selectedIdx < 0 && list.length > 0) {
      const currentIdx = list.findIndex((entry) => entry.current)
      const next = currentIdx >= 0 ? currentIdx : 0
      selectedEntryID = list[next]!.sessionID
      setStore("selected", next)
      const scrollCurrentIntoView = () => scrollToIndex(next, true)
      scrollCurrentIntoView()
      requestAnimationFrame(scrollCurrentIntoView)
    }
    if (selectedIdx >= 0 && selectedIdx !== store.selected) setStore("selected", selectedIdx)
    wasActive = true
    if (store.selected >= list.length) moveTo(Math.max(0, list.length - 1))
  })

  function moveTo(next: number, center = false) {
    selectedEntryID = entries()[next]?.sessionID ?? ""
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
        if (!entry) return []
        return [
          { label: "Enter", shortcut: "attach", gapAfter: 3 },
          { label: "↑↓", shortcut: "move", gapAfter: 3 },
          { label: "⌃x k", shortcut: "cancel", gapAfter: 4 },
          { label: "r", shortcut: "answer", gapAfter: 3 },
          ...(pager().older ? [{ label: "⌃n", shortcut: "older", gapAfter: 3 }] : []),
          ...(pager().newer ? [{ label: "⌃p", shortcut: "newer", gapAfter: 3 }] : []),
          { label: "Esc", shortcut: "close" },
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
        id: "composer.subagent.older",
        title: "Load older subagents",
        group: "Composer",
        bind: "ctrl+n",
        run() {
          if (!pager().older) return
          void data.session.subagent.loadOlder(parentID()).catch((error) => console.error("Failed to load older subagents", error))
        },
      },
      {
        id: "composer.subagent.newer",
        title: "Load newer subagents",
        group: "Composer",
        bind: "ctrl+p",
        run() {
          if (!pager().newer) return
          void data.session.subagent.loadNewer(parentID()).catch((error) => console.error("Failed to load newer subagents", error))
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
        title: "Attach to subagent",
        group: "Composer",
        bind: "return",
        run() {
          const entry = entries()[store.selected]
          if (entry) navigate({ type: "session", sessionID: entry.sessionID })
        },
      },
      {
        id: "composer.subagent.answer",
        title: "Answer subagent",
        group: "Composer",
        bind: "r",
        run() {
          const entry = selectedEntry()
          if (entry?.awaitingInput) navigate({ type: "session", sessionID: entry.sessionID })
        },
      },
      {
        id: "composer.subagent.interrupt",
        title: "Cancel subagent",
        group: "Composer",
        bind: "<leader>k",
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
        width="100%"
        maxWidth={dimensions().width}
        maxHeight={16}
        paddingTop={2}
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
                    const statusColor = createMemo(() => {
                      if (awaitingInput()) return themeV2.text.feedback.warning.default
                      if (entry.status === "running") return themeV2.text.feedback.success.default
                      if (entry.status === "cancelled") return themeV2.text.feedback.error.default
                      return themeV2.text.subdued
                    })
                    return (
                      <>
                        <box
                          flexDirection="row"
                          minWidth={0}
                          flexGrow={1}
                          paddingRight={1}
                          backgroundColor={active() ? themeV2.background.surface.offset : undefined}
                          onMouseOver={() => moveTo(entryIndex())}
                          onMouseUp={() => {
                            moveTo(entryIndex())
                            navigate({
                              type: "session",
                              sessionID: entry.sessionID,
                            })
                          }}
                        >
                          <box width={STATUS_WIDTH} flexShrink={0}>
                            <text fg={statusColor()} wrapMode="none">
                              {taskStatusLabel(entry.status)}
                            </text>
                          </box>
                          <box flexShrink={0}>
                            <text
                              fg={
                                active() || entry.current
                                  ? themeV2.text.feedback.info.default
                                  : themeV2.text.default
                              }
                              attributes={active() ? TextAttributes.BOLD : undefined}
                              wrapMode="none"
                            >
                              {Locale.truncateWidth(entry.agent, AGENT_WIDTH)}
                            </text>
                          </box>
                          <box flexDirection="row" minWidth={0} flexGrow={1} flexShrink={1} paddingLeft={2} paddingRight={2}>
                            <text fg={themeV2.text.subdued} wrapMode="none" truncate>
                              {`· ${entry.title}`}
                            </text>
                          </box>
                          <SubagentMetadata
                            model={entry.model}
                            cacheHit={formatSubagentCacheHit(data.session.diagnostics.get(entry.sessionID))}
                            elapsed={formatSubagentElapsed(entry.startedAt, now())}
                            status={entry.status === "running" ? "attached" : undefined}
                          />
                        </box>
                        <Show when={entry.awaitingInput && entry.detail}>
                          <box paddingLeft={16}>
                            <text fg={themeV2.text.feedback.warning.default} wrapMode="none">
                              ? {entry.detail}
                            </text>
                          </box>
                        </Show>
                      </>
                    )
                  }}
                </For>
              </box>
            )}
          </For>
          <Show when={pager().older || pager().newer}>
            <box flexDirection="row" gap={3} paddingTop={1}>
              <Show when={pager().newer}>
                <text fg={themeV2.text.action.primary.default} onMouseUp={() => void data.session.subagent.loadNewer(parentID())}>
                  newer
                </text>
              </Show>
              <Show when={pager().older}>
                <text fg={themeV2.text.action.primary.default} onMouseUp={() => void data.session.subagent.loadOlder(parentID())}>
                  {page()?.position === "top" ? `+${Math.max(0, (page()?.summary.total ?? 0) - entries().length)} more` : "older"}
                </text>
              </Show>
            </box>
          </Show>
        </Show>
      </scrollbox>
    </Show>
  )
}
