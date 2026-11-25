import { createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js"
import path from "path"
import type { SessionInfo } from "@ycoding-ai/client"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useRoute } from "../context/route"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { Locale } from "../util/locale"
import { useTheme } from "../context/theme"
import { useClient } from "../context/client"
import { useLocal } from "../context/local"
import { useLocation } from "../context/location"
import { useEvent } from "../context/event"
import { createDebouncedSignal } from "../util/signal"
import { useToast } from "../ui/toast"
import { DialogSessionRename } from "./dialog-session-rename"
import { Spinner } from "./spinner"
import { errorMessage } from "../util/error"
import { readableForeground } from "../theme/component"
import { isBackgroundSession } from "../util/session"
import {
  canonicalDirectory,
  listScopedRecentSessions,
  matchesRecentSessionScope,
  recentSessionScopeKey,
  resolveRecentSessionScope,
  scopeHintDirectory,
} from "../util/session-scope"

const REFRESH_EVENTS = new RegExp(
  `^(${[
    String.raw`session\.(created|deleted|renamed|archived|unarchived|moved|pinned|unpinned|status)`,
    String.raw`session\.(task\.updated|execution\.|shell\.|review\.)`,
    String.raw`permission\.`,
    String.raw`guardrail\.`,
    String.raw`form\.`,
    String.raw`question\.`,
    String.raw`shell\.(created|exited|deleted)`,
  ].join("|")})`,
)
const ROOT_REFRESH_EVENTS = /^session\.moved$/
const REFRESH_DELAY_MS = 100

type GlobalState = {
  decisions: ReadonlySet<string>
  tasks: ReadonlySet<string>
  running: ReadonlySet<string>
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id))

export function DialogSessionList(
  props: {
    pinned?: readonly string[]
    messageCounts?: Readonly<Record<string, number>>
    now?: number
  } = {},
) {
  const dialog = useDialog()
  const route = useRoute()
  const data = useData()
  const { theme, mode } = useTheme()
  const client = useClient()
  const local = useLocal()
  const location = useLocation()
  const event = useEvent()
  const toast = useToast()
  const [filter, setFilter] = createSignal("")
  const shortcuts = Keymap.useShortcuts()
  const [search, setSearch] = createDebouncedSignal("", 150)
  const [toDelete, setToDelete] = createSignal<string>()
  const [global, setGlobal] = createSignal<GlobalState>({
    decisions: new Set<string>(),
    tasks: new Set<string>(),
    running: new Set<string>(),
  })
  const scopeCache = new Map<string, string | null>()
  const waitingRoots = createMemo(() => new Set([...global().decisions, ...global().tasks]))
  const activeLocation = createMemo(() => location.current ?? data.location.info())
  const activeScope = createMemo(() => {
    const current = activeLocation()
    return current ? resolveRecentSessionScope(current, scopeCache) : undefined
  })
  const activeScopeKey = createMemo(() => recentSessionScopeKey(activeScope()))
  let releaseRetained: (() => void) | undefined
  let disposed = false
  let refreshing = false
  let refreshDirty = false
  let refreshRoots = false
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let refreshGeneration = 0
  const rootCache = new Map<string, string | null>()
  const runningGutter = () => <Spinner />

  async function rootOf(sessionID: string, stale: () => boolean) {
    const walked: string[] = []
    let current: string | undefined = sessionID
    let root: string | null | undefined
    while (current && walked.length < 16 && !walked.includes(current)) {
      if (stale()) return undefined
      const cached = rootCache.get(current)
      if (cached !== undefined) {
        root = cached
        break
      }
      walked.push(current)
      const info: SessionInfo | undefined =
        data.session.get(current) ?? (await client.api.session.get({ sessionID: current }).catch(() => undefined))
      if (!info) return undefined
      if (isBackgroundSession(info)) {
        root = null
        break
      }
      if (!info.parentID) {
        root = info.id
        break
      }
      current = info.parentID
    }
    if (root === undefined) return undefined
    walked.forEach((id) => rootCache.set(id, root))
    return root ?? undefined
  }

  function forgetRoot(sessionID: string) {
    rootCache.delete(sessionID)
    for (const [id, root] of rootCache) if (root === sessionID) rootCache.delete(id)
  }

  async function rootsOf(sessionIDs: Iterable<string>, stale: () => boolean) {
    const roots = await Promise.all([...new Set(sessionIDs)].map((sessionID) => rootOf(sessionID, stale)))
    return new Set(roots.filter((root): root is string => root !== undefined))
  }

  async function loadGlobal(generation: number, discoverRoots: boolean) {
    const stale = () => disposed || generation !== refreshGeneration
    if (discoverRoots) await data.session.syncRoots(activeLocation()).catch(() => undefined)
    if (stale()) return
    const [decisions, outstanding] = await Promise.allSettled([
      client.api.decision.list(),
      client.api.session.outstanding(),
    ])
    if (stale()) return
    const previous = global()
    const [decisionRoots, taskRoots, runningRoots] = await Promise.all([
      decisions.status === "fulfilled"
        ? rootsOf(
            decisions.value.map((item) => item.sessionID),
            stale,
          )
        : previous.decisions,
      outstanding.status === "fulfilled" ? rootsOf(outstanding.value.waiting ?? [], stale) : previous.tasks,
      outstanding.status === "fulfilled" ? rootsOf(outstanding.value.running ?? [], stale) : previous.running,
    ])
    if (stale()) return
    const release = data.session.retain(new Set([...decisionRoots, ...taskRoots, ...runningRoots]))
    releaseRetained?.()
    releaseRetained = release
    await Promise.all(
      [...decisionRoots, ...taskRoots, ...runningRoots]
        .filter((sessionID) => !data.session.get(sessionID))
        .map((sessionID) => data.session.sync(sessionID).catch(() => undefined)),
    )
    if (stale()) return
    setGlobal((current) =>
      sameSet(current.decisions, decisionRoots) && sameSet(current.tasks, taskRoots) && sameSet(current.running, runningRoots)
        ? current
        : { decisions: decisionRoots, tasks: taskRoots, running: runningRoots },
    )
  }

  function refreshGlobal(discoverRoots = false) {
    if (disposed) return
    refreshDirty = true
    refreshRoots ||= discoverRoots
    if (refreshing || refreshTimer !== undefined) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      if (disposed) return
      const roots = refreshRoots
      refreshDirty = false
      refreshRoots = false
      refreshing = true
      void loadGlobal(refreshGeneration, roots).finally(() => {
        refreshing = false
        if (refreshDirty) refreshGlobal(refreshRoots)
      })
    }, REFRESH_DELAY_MS)
  }

  onCleanup(() => {
    disposed = true
    refreshGeneration++
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    releaseRetained?.()
  })
  onCleanup(
    event.subscribe((item) => {
      if (!REFRESH_EVENTS.test(item.type)) return
      if (item.type === "session.deleted") forgetRoot(item.data.sessionID)
      if (item.type === "session.task.updated" && item.data.change.type === "progressed") return
      refreshGlobal(ROOT_REFRESH_EVENTS.test(item.type))
    }),
  )
  createEffect(
    on(
      activeScopeKey,
      () => {
        refreshGeneration++
        refreshGlobal(true)
      },
      { defer: true },
    ),
  )

  function ensureResident(sessionID: string) {
    if (data.session.get(sessionID)) return Promise.resolve()
    return data.session.sync(sessionID).catch(() => undefined)
  }

  const searchSource = createMemo(() => {
    const query = search()
    if (!query) return undefined
    return { query, scopeKey: activeScopeKey() }
  })

  const [searchResults] = createResource(searchSource, async ({ query }) => {
    try {
      const current = activeLocation() ?? (await data.location.sync().then(() => data.location.info()))
      if (!current) throw new Error("Location unavailable")
      const scope = resolveRecentSessionScope(current, scopeCache)
      const found = await listScopedRecentSessions({
        list: client.api.session.list,
        scope,
        search: query,
        limit: 50,
        cache: scopeCache,
      })
      return { query, scopeKey: recentSessionScopeKey(scope), sessions: found, error: undefined }
    } catch (error) {
      return { query, scopeKey: activeScopeKey(), sessions: [] as SessionInfo[], error }
    }
  })

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const localSessions = createMemo(() => {
    const query = filter().trim().toLowerCase()
    const sessions = data.session.list().filter((session) => !isBackgroundSession(session))
    if (!query) return sessions
    return sessions.filter((session) => !session.parentID && session.title.toLowerCase().includes(query))
  })
  const sessions = createMemo(() => {
    const query = filter()
    const local = localSessions()
    if (!query) return local
    if (query !== search() || searchResults.loading) return local
    const result = searchResults()
    if (result?.query !== query || result.scopeKey !== activeScopeKey() || result.error) return local
    return result.sessions
  })
  const searchState = createMemo(() => {
    const query = filter()
    if (!query) return { message: "No sessions available", error: false }
    if (query !== search() || searchResults.loading) return { message: "Searching sessions…", error: false }
    const result = searchResults()
    if (result?.query === query && result.error)
      return { message: "Could not search sessions. Change the search to try again.", error: true }
    return { message: "No sessions found", error: false }
  })

  const quickSwitchHint = createMemo(() => {
    const first = shortcuts.get("session.quick_switch.1")
    const last = shortcuts.get("session.quick_switch.9")
    if (!first || !last) return
    return quickSwitchRange(first, last)
  })
  const quickSwitchFooterHints = createMemo(() => {
    const hint = quickSwitchHint()
    return hint && local.session.slots().length > 0 ? [{ title: "switch", label: hint }] : []
  })

  const options = createMemo(() => {
    const scope = activeScope()
    const hintBase = scope ? canonicalDirectory(scopeHintDirectory(scope)) : undefined
    const byID = new Map<string, SessionInfo>()
    for (const session of data.session.list()) {
      if (!session.parentID && !isBackgroundSession(session)) byID.set(session.id, session)
    }
    for (const session of sessions()) {
      if (!session.parentID && !byID.has(session.id)) byID.set(session.id, session)
    }
    const isWaiting = (session: SessionInfo) =>
      !session.time.archived &&
      (data.session.activity(session.id) === "waiting" ||
        waitingRoots().has(session.id) ||
        (data.session.subagent.summary(session.id)?.waiting ?? 0) > 0)
    const isRunning = (session: SessionInfo) =>
      !session.time.archived &&
      (data.session.activity(session.id) === "running" || global().running.has(session.id))
    const pinnedSessions = props.pinned
      ? props.pinned.flatMap((sessionID) => {
          const session = byID.get(sessionID)
          return session ? [session] : []
        })
      : [...byID.values()]
          .filter((session) => session.time.pinned !== undefined)
          .toSorted((a, b) => a.time.pinned! - b.time.pinned! || a.id.localeCompare(b.id))
    const pinnedSet = new Set(pinnedSessions.map((session) => session.id))
    const waitingSessions: SessionInfo[] = []
    const runningSessions: SessionInfo[] = []
    for (const session of [...byID.values()].toSorted((a, b) => b.time.updated - a.time.updated)) {
      if (pinnedSet.has(session.id)) continue
      if (isWaiting(session)) {
        waitingSessions.push(session)
        continue
      }
      if (isRunning(session)) runningSessions.push(session)
    }
    const slotByID = new Map(local.session.slots().map((sessionID, index) => [sessionID, index + 1]))

    const option = (session: SessionInfo, category: string) => {
      const directory = session.location.directory
      const messageCount = props.messageCounts?.[session.id]
      const footer =
        messageCount === undefined
          ? hintBase === undefined || canonicalDirectory(directory) !== hintBase
            ? Locale.truncate(path.basename(directory), 20)
            : ""
          : `${messageCount.toLocaleString("en-US")} msgs`
      const slot = slotByID.get(session.id)
      const deleting = toDelete() === session.id
      return {
        title: deleting ? `Press ${shortcuts.get("session.delete")} again to confirm` : session.title,
        description: session.time.archived
          ? `Archived · ${Locale.relativeTime(session.time.updated, props.now ?? Date.now())}`
          : Locale.relativeTime(session.time.updated, props.now ?? Date.now()),
        value: session.id,
        category,
        footer,
        bg: deleting ? theme.background.action.destructive.default : undefined,
        fg: deleting
          ? readableForeground(theme.text.action.destructive.default, theme.background.action.destructive.default)
          : undefined,
        state: isWaiting(session) ? ("awaitingInput" as const) : undefined,
        gutter: isWaiting(session)
          ? undefined
          : isRunning(session)
            ? runningGutter
            : slot === undefined
              ? undefined
              : () => <text fg={theme.hue.accent[mode() === "light" ? 800 : 200]}>{slot}</text>,
      }
    }

    const query = filter().trim().toLowerCase()
    const matches = (session: SessionInfo) => !query || session.title.toLowerCase().includes(query)
    const shown = new Set<string>()
    const take = (list: readonly SessionInfo[], category: string, filterByQuery = true) =>
      list.flatMap((session) => {
        if (shown.has(session.id) || (filterByQuery && !matches(session))) return []
        shown.add(session.id)
        return [option(session, category)]
      })

    const recentSessions = scope
      ? sessions()
          .filter(
            (session) =>
              !session.parentID &&
              !isBackgroundSession(session) &&
              matchesRecentSessionScope(scope, session, scopeCache),
          )
          .slice(0, 50)
      : []

    return [
      ...take(pinnedSessions, "Pinned"),
      ...take(waitingSessions, "Waiting for action"),
      ...take(runningSessions, "Running"),
      ...take(recentSessions, "Recent", false),
    ]
  })

  onMount(() => {
    dialog.setSize("large")
    refreshGlobal(true)
  })

  function archive(sessionID: string) {
    void client.api.session.archive({ sessionID }).catch((error) => {
      toast.show({
        message: `Failed to archive session: ${errorMessage(error)}`,
        variant: "error",
        duration: 5000,
      })
    })
  }

  function unarchive(sessionID: string) {
    void client.api.session.unarchive({ sessionID }).catch((error) => {
      toast.show({
        message: `Failed to unarchive session: ${errorMessage(error)}`,
        variant: "error",
        duration: 5000,
      })
    })
  }

  function toggleArchive(sessionID: string) {
    const session = data.session.get(sessionID)
    if (session?.time.archived) {
      void ensureResident(sessionID).then(() => unarchive(sessionID))
      return
    }
    let open = true
    const reopen = () => {
      if (!open) return
      open = false
      dialog.replace(() => <DialogSessionList {...props} />)
    }
    dialog.replace(
      () => (
        <ArchiveConfirmation
          sessionID={sessionID}
          title={session?.title}
          onCancel={reopen}
          onConfirm={() => {
            reopen()
            void ensureResident(sessionID).then(() => archive(sessionID))
          }}
        />
      ),
      () => {
        if (!open) return
        open = false
        setTimeout(() => dialog.replace(() => <DialogSessionList {...props} />), 0)
      },
    )
  }

  return (
    <DialogSelect
      title="Switch session"
      options={options()}
      skipFilter={true}
      current={currentSessionID()}
      onFilter={(query) => {
        setFilter(query)
        setSearch(query)
      }}
      emptyView={
        <box paddingLeft={4} paddingRight={4} paddingTop={1}>
          <text fg={theme.text.subdued}>No sessions available</text>
        </box>
      }
      noMatchView={
        <box paddingLeft={4} paddingRight={4} paddingTop={1}>
          <text fg={searchState().error ? theme.text.feedback.error.default : theme.text.subdued}>
            {searchState().message}
          </text>
        </box>
      }
      onMove={() => setToDelete(undefined)}
      onSelect={(option) => {
        route.navigate({ type: "session", sessionID: option.value })
        dialog.clear()
      }}
      actions={[
        {
          command: "session.archive",
          title: "archive/unarchive",
          onTrigger: (option: { value: string }) => toggleArchive(option.value),
        },
        {
          command: "session.pin.toggle",
          title: "pin/unpin",
          onTrigger: (option: { value: string }) =>
            void ensureResident(option.value).then(() => local.session.togglePin(option.value)),
        },
        {
          command: "session.delete",
          title: "delete",
          onTrigger: (option: { value: string }) => {
            if (toDelete() !== option.value) {
              setToDelete(option.value)
              return
            }
            void client.api.session.remove({ sessionID: option.value }).catch((error) => {
              setToDelete(undefined)
              toast.show({
                message: `Failed to delete session: ${errorMessage(error)}`,
                variant: "error",
                duration: 5000,
              })
            })
          },
        },
        {
          command: "session.rename",
          title: "rename",
          onTrigger: (option: { value: string }) =>
            DialogSessionRename.show(dialog, option.value, data.session.get(option.value)?.title),
        },
      ]}
      footer={<text>⌃f pin</text>}
      footerHints={quickSwitchFooterHints()}
    />
  )
}

function ArchiveConfirmation(props: {
  sessionID: string
  title?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const { theme } = useTheme()
  const [confirm, setConfirm] = createSignal(true)

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "return",
        title: "Confirm archive",
        group: "Dialog",
        run: () => (confirm() ? props.onConfirm() : props.onCancel()),
      },
      {
        bind: "left",
        title: "Select cancel",
        group: "Dialog",
        run: () => setConfirm(false),
      },
      {
        bind: "right",
        title: "Select archive",
        group: "Dialog",
        run: () => setConfirm(true),
      },
      {
        bind: "escape",
        title: "Cancel archive",
        group: "Dialog",
        run: props.onCancel,
      },
    ],
  }))

  return (
    <box paddingTop={1}>
      <box paddingLeft={3}>
        <text fg={theme.text.default}>Archive session</text>
      </box>
      <box paddingLeft={3} paddingRight={4} paddingTop={3}>
        <text fg={theme.text.subdued} wrapMode="word">
          Archive “{props.title ?? props.sessionID}”? This is reversible: you can unarchive the session later. Archiving
          does not automatically delete its history.
        </text>
      </box>
      <box paddingTop={2}>
        <box
          paddingLeft={6}
          backgroundColor={!confirm() ? theme.background.action.primary.focused : undefined}
          onMouseUp={props.onCancel}
        >
          <text fg={!confirm() ? theme.text.action.primary.focused : theme.text.subdued}>Cancel</text>
        </box>
        <box
          paddingLeft={6}
          backgroundColor={confirm() ? theme.background.action.primary.focused : undefined}
          onMouseUp={props.onConfirm}
        >
          <text fg={confirm() ? theme.text.action.primary.focused : theme.text.subdued}>Archive</text>
        </box>
      </box>
    </box>
  )
}

function quickSwitchRange(first: string, last: string) {
  const prefix = first.slice(0, -1)
  if (first.endsWith("1") && last === `${prefix}9`) return `${prefix}1-9`
  return `${first} through ${last}`
}
