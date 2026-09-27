import type { ProjectInventoryEntry, SessionInfo } from "@ycoding-ai/client"
import { TextAttributes, type InputRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import path from "path"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useClient } from "../context/client"
import { Keymap } from "../context/keymap"
import { useLocation } from "../context/location"
import { useRoute, useRouteData } from "../context/route"
import { useTuiPaths } from "../context/runtime"
import { removeProjectCopy } from "../component/project-copy-remove"
import { Spinner } from "../component/spinner"
import { useTheme } from "../context/theme"
import { abbreviateHome } from "../util/path-format"
import { Locale } from "../util/locale"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useToast } from "../ui/toast"

type WorkspaceEntry = ProjectInventoryEntry

export function WorkspacesScreen() {
  const route = useRouteData("workspaces")
  const router = useRoute()
  const client = useClient()
  const location = useLocation()
  const paths = useTuiPaths()
  const dialog = useDialog()
  const toast = useToast()
  const [entries, setEntries] = createSignal<WorkspaceEntry[]>([])
  const [search, setSearch] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [error, setError] = createSignal(false)
  const [cursor, setCursor] = createSignal<string>()
  const [selected, setSelected] = createSignal(0)
  const [armed, setArmed] = createSignal<string>()
  const [recent, setRecent] = createSignal<{ directory: string; sessions: SessionInfo[]; loading: boolean }>()
  const [searchTarget, setSearchTarget] = createSignal<InputRenderable>()
  const dimensions = useTerminalDimensions()
  let generation = 0
  let recentGeneration = 0
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  const requested = new Set<string>()
  const inFlight = new Set<string>()
  const currentDirectory = () => location.current?.directory ?? paths.cwd
  const entriesByGroup = createMemo(() => {
    const groups: { key: string; title: string; worktree: string; entries: WorkspaceEntry[] }[] = []
    for (const entry of entries()) {
      const key = JSON.stringify([entry.projectID, entry.projectWorktree])
      const group = groups.at(-1)
      if (group?.key === key) {
        group.entries.push(entry)
        continue
      }
      groups.push({
        key,
        title: entry.projectName ?? path.basename(entry.projectWorktree),
        worktree: abbreviateHome(entry.projectWorktree, paths.home),
        entries: [entry],
      })
    }
    return groups
  })
  const selectedEntry = () => entries()[selected()]

  async function loadPage(token: number, pageCursor?: string) {
    if (pageCursor && (requested.has(pageCursor) || inFlight.has(pageCursor))) return
    if (pageCursor) {
      requested.add(pageCursor)
      inFlight.add(pageCursor)
    }
    if (pageCursor) setLoadingMore(true)
    else {
      setLoading(true)
      setError(false)
    }
    try {
      const result = await client.api.project.inventory({
        limit: 50,
        search: search().trim() || undefined,
        cursor: pageCursor,
      })
      if (token !== generation) return
      setEntries((current) => (pageCursor ? [...current, ...result.data] : result.data))
      setCursor(result.cursor.next ?? undefined)
      setSelected((current) => Math.min(current, Math.max(0, (pageCursor ? entries().length : result.data.length) - 1)))
      if (!pageCursor && dimensions().width >= 120) loadRecent(result.data[0])
    } catch {
      if (token === generation) setError(true)
    } finally {
      if (pageCursor) inFlight.delete(pageCursor)
      if (token === generation) {
        if (pageCursor) setLoadingMore(false)
        else setLoading(false)
      }
    }
  }

  function resetPages() {
    generation += 1
    requested.clear()
    setCursor(undefined)
    setEntries([])
    setSelected(0)
    setArmed(undefined)
    setLoading(true)
    setError(false)
    return generation
  }

  function reload() {
    if (searchTimer) clearTimeout(searchTimer)
    void loadPage(resetPages())
  }

  function loadRecent(entry: WorkspaceEntry | undefined) {
    const token = ++recentGeneration
    if (!entry) {
      setRecent(undefined)
      return
    }
    setRecent({ directory: entry.directory, sessions: [], loading: true })
    void client.api.session.list({ directory: entry.directory, limit: 3, order: "desc", parentID: null }).then(
      (result) => {
        if (token === recentGeneration) setRecent({ directory: entry.directory, sessions: result.data, loading: false })
      },
      () => {
        if (token === recentGeneration) setRecent({ directory: entry.directory, sessions: [], loading: false })
      },
    )
  }

  function moveSelection(delta: number) {
    const next = Math.min(Math.max(0, selected() + delta), entries().length - 1)
    setSelected(next)
    setArmed(undefined)
    if (dimensions().width >= 120) loadRecent(entries()[next])
    if (cursor() && next >= entries().length - 10) void loadPage(generation, cursor())
  }

  function open() {
    const entry = selectedEntry()
    if (!entry) return
    if (!entry.available) {
      toast.show({ variant: "warning", message: `Directory is unavailable: ${entry.directory}` })
      setTimeout(() => searchTarget()?.focus(), 1)
      return
    }
    location.set({ directory: entry.directory })
    router.navigate({ type: "home", directory: entry.directory })
  }

  function deleteCopy() {
    const entry = selectedEntry()
    if (!entry?.strategy || entry.directory === currentDirectory()) return
    const key = rowKey(entry)
    if (armed() !== key) {
      setArmed(key)
      return
    }
    setArmed(undefined)
    void removeProjectCopy({
      client: client.api,
      dialog,
      toast,
      projectID: entry.projectID,
      location: currentDirectory(),
      directory: entry.directory,
      onForce: () => {},
    }).then((result) => {
      if (!result.removed) return
      removeEntry(entry)
    })
  }

  function forget() {
    const entry = selectedEntry()
    if (!entry || entry.directory === currentDirectory()) return
    WorkspaceForgetConfirmation.show(dialog, entry, async () => {
      try {
        await client.api.project.forget({ projectID: entry.projectID, directory: entry.directory })
        removeEntry(entry)
        toast.show({ variant: "success", message: "Workspace directory forgotten" })
      } catch {
        toast.show({ variant: "error", message: "Failed to forget workspace directory" })
      }
    })
  }

  function removeEntry(entry: WorkspaceEntry) {
    const index = entries().findIndex((item) => rowKey(item) === rowKey(entry))
    if (index < 0) return
    setEntries((current) => current.filter((item) => rowKey(item) !== rowKey(entry)))
    setSelected((current) => Math.min(current, Math.max(0, entries().length - 2)))
    setRecent(undefined)
  }

  const back = () =>
    router.navigate(route.sessionID ? { type: "session", sessionID: route.sessionID } : { type: "home" })
  const bindings = {
    back: Keymap.useShortcut("workspaces.back"),
    open: Keymap.useShortcut("workspaces.open"),
    previous: Keymap.useShortcut("workspaces.select.previous"),
    next: Keymap.useShortcut("workspaces.select.next"),
    delete: Keymap.useShortcut("workspaces.delete"),
    forget: Keymap.useShortcut("workspaces.forget"),
    refresh: Keymap.useShortcut("workspaces.refresh"),
  }

  Keymap.createLayer(() => ({
    mode: "base",
    commands: [
      { id: "workspaces.back", title: "Back from workspaces", group: "Workspaces", bind: "escape", run: back },
      { id: "workspaces.open", title: "Open workspace", group: "Workspaces", bind: "return", run: open },
      {
        id: "workspaces.select.previous",
        title: "Select previous workspace",
        group: "Workspaces",
        bind: "up",
        run: () => moveSelection(-1),
      },
      {
        id: "workspaces.select.next",
        title: "Select next workspace",
        group: "Workspaces",
        bind: "down",
        run: () => moveSelection(1),
      },
      {
        id: "workspaces.delete",
        title: "Delete project copy",
        group: "Workspaces",
        bind: "ctrl+d",
        enabled: () => !!selectedEntry()?.strategy && selectedEntry()?.directory !== currentDirectory(),
        run: deleteCopy,
      },
      {
        id: "workspaces.forget",
        title: "Forget workspace directory",
        group: "Workspaces",
        bind: "ctrl+x",
        enabled: () => !!selectedEntry() && selectedEntry()?.directory !== currentDirectory(),
        run: forget,
      },
      { id: "workspaces.refresh", title: "Refresh workspaces", group: "Workspaces", bind: "ctrl+r", run: reload },
    ],
    bindings: ["workspaces.back", "workspaces.open", "workspaces.delete", "workspaces.forget", "workspaces.refresh"],
  }))
  Keymap.createLayer(() => ({
    mode: "base",
    target: searchTarget,
    enabled: searchTarget() !== undefined,
    priority: 1,
    commands: [
      { id: "workspaces.input.back", title: "Back from workspaces", group: "Workspaces", bind: "escape", run: back },
      {
        id: "workspaces.input.delete",
        title: "Delete project copy",
        group: "Workspaces",
        bind: "ctrl+d",
        run: deleteCopy,
      },
      {
        id: "workspaces.input.forget",
        title: "Forget workspace directory",
        group: "Workspaces",
        bind: "ctrl+x",
        run: forget,
      },
      { id: "workspaces.input.refresh", title: "Refresh workspaces", group: "Workspaces", bind: "ctrl+r", run: reload },
    ],
  }))
  onMount(() => {
    reload()
  })
  onCleanup(() => {
    generation += 1
    recentGeneration += 1
    if (searchTimer) clearTimeout(searchTimer)
  })

  return (
    <WorkspacesScreenContent
      entries={entries}
      groups={entriesByGroup}
      selected={selected}
      loading={loading}
      loadingMore={loadingMore}
      error={error}
      cursor={cursor}
      currentDirectory={currentDirectory}
      search={search}
      setSearch={(value) => {
        setSearch(value)
        if (searchTimer) clearTimeout(searchTimer)
        const token = resetPages()
        searchTimer = setTimeout(() => void loadPage(token), 150)
      }}
      armed={armed}
      recent={recent}
      bindings={bindings}
      paths={paths}
      setSearchTarget={setSearchTarget}
      onBack={back}
      onSelect={moveSelection}
      onOpen={open}
    />
  )
}

function WorkspacesScreenContent(props: {
  entries: () => WorkspaceEntry[]
  groups: () => { key: string; title: string; worktree: string; entries: WorkspaceEntry[] }[]
  selected: () => number
  loading: () => boolean
  loadingMore: () => boolean
  error: () => boolean
  cursor: () => string | undefined
  currentDirectory: () => string
  search: () => string
  setSearch: (value: string) => void
  armed: () => string | undefined
  recent: () => { directory: string; sessions: SessionInfo[]; loading: boolean } | undefined
  bindings: Record<string, () => string | undefined>
  paths: { home: string }
  setSearchTarget: (input: InputRenderable) => void
  onBack: () => void
  onSelect: (delta: number) => void
  onOpen: () => void
}) {
  const dimensions = useTerminalDimensions()
  const { themeV2 } = useTheme()
  let input: InputRenderable | undefined
  onMount(() => setTimeout(() => input?.focus(), 1))
  const details = () => dimensions().width >= 120
  const current = () => props.entries()[props.selected()]
  const rowWidth = () => (details() ? Math.floor((dimensions().width - 7) * 0.66) : dimensions().width)
  const hint = (name: string, fallback: string) => props.bindings[name]?.()?.replaceAll("escape", "esc") ?? fallback
  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={themeV2.background.default}
    >
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={3} paddingRight={3}>
        <text attributes={TextAttributes.BOLD} fg={themeV2.text.default}>
          Workspaces
        </text>
        <text fg={themeV2.text.subdued}>
          {" "}
          · {props.entries().length} loaded{props.cursor() ? " · more available" : ""}
        </text>
        <Show when={props.loading()}>
          <text fg={themeV2.text.subdued}> · </text>
          <Spinner color={themeV2.text.subdued} />
        </Show>
        <box flexGrow={1} />
        <text fg={themeV2.text.subdued} onMouseUp={props.onBack}>
          {hint("back", "esc")}
        </text>
      </box>
      <box height={1} flexShrink={0} paddingLeft={3} paddingRight={3}>
        <input
          ref={(value: InputRenderable) => {
            input = value
            props.setSearchTarget(value)
          }}
          placeholder="Search workspaces"
          value={props.search()}
          onInput={props.setSearch}
          onKeyDown={(event) => {
            if (event.name === "up" || event.name === "down") {
              event.preventDefault()
              props.onSelect(event.name === "up" ? -1 : 1)
              setTimeout(() => input?.focus(), 1)
            }
            if (event.name === "escape") {
              event.preventDefault()
              props.onBack()
            }
            if (event.name === "return") {
              event.preventDefault()
              props.onOpen()
            }
          }}
          focusedBackgroundColor="transparent"
          cursorColor={themeV2.text.feedback.info.default}
          placeholderColor={themeV2.text.subdued}
        />
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="row" paddingTop={1}>
        <scrollbox
          width={details() ? rowWidth() : "100%"}
          flexGrow={details() ? 0 : 1}
          minWidth={0}
          flexShrink={1}
          paddingLeft={3}
          verticalScrollbarOptions={{
            trackOptions: { backgroundColor: themeV2.background.default, foregroundColor: themeV2.scrollbar.default },
          }}
        >
          <Show when={!props.loading() || props.entries().length > 0}>
            <Show
              when={props.error() && props.entries().length === 0}
              fallback={
                <Show
                  when={props.entries().length > 0}
                  fallback={
                    <box flexDirection="column">
                      <text attributes={TextAttributes.BOLD} fg={themeV2.text.feedback.info.default}>
                        No workspaces found
                      </text>
                      <text fg={themeV2.text.subdued}>Try another search or refresh the inventory.</text>
                    </box>
                  }
                >
                  <For each={props.groups()}>
                    {(group, groupIndex) => (
                      <box flexDirection="column">
                        <Show when={groupIndex() > 0}>
                          <text> </text>
                        </Show>
                        <box flexDirection="row" paddingLeft={3}>
                          <text attributes={TextAttributes.BOLD} fg={themeV2.text.feedback.info.default}>
                            {group.title}
                          </text>
                          <text fg={themeV2.text.subdued}> {group.worktree}</text>
                        </box>
                        <For each={group.entries}>
                          {(entry) => {
                            const index = () => props.entries().findIndex((item) => rowKey(item) === rowKey(entry))
                            const active = () => index() === props.selected()
                            const destructive = () => props.armed() === rowKey(entry)
                            const glyph = () =>
                              entry.directory === props.currentDirectory() ? "●" : entry.available ? "✓" : "○"
                            const kind = workspaceKind(entry)
                            const directory = abbreviateHome(entry.directory, props.paths.home)
                            const meta = `${entry.sessions} sess ${Locale.relativeTime(entry.timeActive, Date.now())}`
                            const pathWidth = Math.max(4, rowWidth() - meta.length - 30)
                            const label = `${glyph()} ${kind.padEnd(8)} ${Locale.truncateLeft(directory, pathWidth).padEnd(pathWidth)} ${meta}`
                            return (
                              <box
                                width={rowWidth()}
                                height={1}
                                flexDirection="row"
                                paddingLeft={1}
                                paddingRight={1}
                                backgroundColor={
                                  destructive()
                                    ? themeV2.background.action.destructive.default
                                    : active()
                                      ? themeV2.background.action.primary.focused
                                      : undefined
                                }
                                onMouseUp={() => {
                                  if (!active()) props.onSelect(index() - props.selected())
                                }}
                              >
                                <text
                                  wrapMode="none"
                                  truncate
                                  fg={
                                    active()
                                      ? themeV2.text.action.primary.focused
                                      : entry.available
                                        ? themeV2.text.default
                                        : themeV2.text.subdued
                                  }
                                >
                                  {destructive()
                                    ? `Press ${hint("delete", "ctrl+d")} again to delete copy ${directory}`
                                    : label}
                                </text>
                              </box>
                            )
                          }}
                        </For>
                      </box>
                    )}
                  </For>
                  <Show when={props.loadingMore()}>
                    <text fg={themeV2.text.subdued}>Loading more…</text>
                  </Show>
                  <Show when={props.error()}>
                    <text fg={themeV2.text.feedback.error.default}>Could not load more workspaces</text>
                    <text fg={themeV2.text.subdued}>Press {hint("refresh", "ctrl+r")} to retry</text>
                  </Show>
                </Show>
              }
            >
              <box flexDirection="column">
                <text fg={themeV2.text.feedback.error.default}>Could not load workspaces</text>
                <text fg={themeV2.text.subdued}>Press {hint("refresh", "ctrl+r")} to retry</text>
              </box>
            </Show>
          </Show>
          <Show when={props.loading() && props.entries().length === 0}>
            <Spinner color={themeV2.text.subdued}>Loading workspaces…</Spinner>
          </Show>
        </scrollbox>
        <Show when={details()}>
          <text fg={themeV2.border.default}>┃</text>
          <box flexGrow={1} minWidth={0} paddingLeft={2} paddingRight={3} flexDirection="column">
            <Show when={current()} fallback={<text fg={themeV2.text.subdued}>Select a workspace</text>}>
              {(entry) => (
                <>
                  <For
                    each={[
                      ["Directory", abbreviateHome(entry().directory, props.paths.home)],
                      ["Project", entry().projectName ?? path.basename(entry().projectWorktree)],
                      ["Kind", workspaceKind(entry())],
                      ["Sessions", String(entry().sessions)],
                      ["Last activity", Locale.relativeTime(entry().timeActive, Date.now())],
                    ]}
                  >
                    {(item) => (
                      <box flexDirection="row">
                        <text width={17} fg={themeV2.text.subdued}>
                          {item[0]}
                        </text>
                        <text flexGrow={1} minWidth={0} truncate>
                          {item[1]}
                        </text>
                      </box>
                    )}
                  </For>
                  <text paddingTop={1} attributes={TextAttributes.BOLD} fg={themeV2.text.feedback.info.default}>
                    Recent sessions
                  </text>
                  <Show
                    when={props.recent()?.directory === entry().directory}
                    fallback={<text fg={themeV2.text.subdued}>Loading sessions…</text>}
                  >
                    <Show
                      when={!props.recent()?.loading}
                      fallback={<text fg={themeV2.text.subdued}>Loading sessions…</text>}
                    >
                      <Show
                        when={(props.recent()?.sessions.length ?? 0) > 0}
                        fallback={<text fg={themeV2.text.subdued}>No recent sessions</text>}
                      >
                        <For each={props.recent()?.sessions.slice(0, 3)}>
                          {(session) => (
                            <text truncate fg={themeV2.text.subdued}>
                              {session.title}
                            </text>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </Show>
                </>
              )}
            </Show>
          </box>
        </Show>
      </box>
      <box height={1} flexShrink={0} paddingLeft={3} paddingRight={3} flexDirection="row" justifyContent="center">
        <text fg={themeV2.text.subdued}>
          {hint("previous", "↑")}
          {hint("next", "↓")} select · {hint("open", "enter")} open · {hint("delete", "ctrl+d")} delete copy ·{" "}
          {hint("forget", "ctrl+x")} forget · {hint("refresh", "ctrl+r")} refresh · {hint("back", "esc")} back
        </text>
      </box>
    </box>
  )
}

function WorkspaceForgetConfirmation(props: { entry: WorkspaceEntry; onConfirm: () => void }) {
  const dialog = useDialog()
  const { themeV2 } = useTheme().contextual("elevated")
  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        id: "workspaces.forget.confirm",
        title: "Confirm forgetting workspace",
        group: "Dialog",
        bind: "return",
        run: () => {
          props.onConfirm()
          dialog.clear()
        },
      },
      {
        id: "workspaces.forget.cancel",
        title: "Cancel forgetting workspace",
        group: "Dialog",
        bind: "escape",
        run: () => dialog.clear(),
      },
    ],
  }))
  return (
    <box paddingTop={1} paddingBottom={1} flexDirection="column" gap={1}>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={3} paddingRight={3}>
        <text attributes={TextAttributes.BOLD} fg={themeV2.text.default}>
          Forget workspace directory?
        </text>
        <text fg={themeV2.text.subdued} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingLeft={3} paddingRight={3}>
        <text fg={themeV2.text.subdued} wrapMode="word">
          Permanently deletes {props.entry.sessions} sessions in {props.entry.directory} and forgets the directory.
          Files stay on disk.
        </text>
      </box>
      <box paddingLeft={3} flexDirection="row" gap={3}>
        <text
          fg={themeV2.text.feedback.error.default}
          onMouseUp={() => {
            props.onConfirm()
            dialog.clear()
          }}
        >
          enter confirm
        </text>
        <text fg={themeV2.text.subdued} onMouseUp={() => dialog.clear()}>
          esc cancel
        </text>
      </box>
    </box>
  )
}

WorkspaceForgetConfirmation.show = (dialog: DialogContext, entry: WorkspaceEntry, onConfirm: () => void) =>
  dialog.replace(() => <WorkspaceForgetConfirmation entry={entry} onConfirm={onConfirm} />)

function workspaceKind(entry: WorkspaceEntry) {
  if (entry.strategy) return "copy"
  if (entry.directory === entry.projectWorktree) return "main"
  if (entry.projectID === "global") return "folder"
  const relative = path.relative(entry.projectWorktree, entry.directory)
  if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    return "subdir"
  return "checkout"
}

function rowKey(entry: WorkspaceEntry) {
  return JSON.stringify([entry.projectID, entry.directory])
}
