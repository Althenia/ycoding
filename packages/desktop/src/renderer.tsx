import { createRootRoute, createRoute, createRouter, createHashHistory, Link, Outlet, RouterProvider, useLocation, useNavigate } from "@tanstack/solid-router"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import type { YCodingEvent } from "@ycoding-ai/client"
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import type { ConnectionState, FormAnswer, FormRequest, Messages, PendingRequests, PermissionRequest, RequestReply, SessionItem } from "./contract"
import { desktop as api } from "./bridge"
import { activeFields, appendPage, buildAnswer, chooseModel, chooseProfile, choiceFor, choiceProblem, initialValues, invalidIndexes, modelLabel, pagedItems, pagingFor, problemOf, profileLabel, railGroups, restoresFocus, sameSelection, samePaging, searchTerm, selectionFor, valueFor, variantsFor, visibleModels, withValue, type Activity, type Field, type FocusAt, type ModelChoice, type Paging, type Value } from "./form-rules"
import mark from "../../../assets/brand/ycoding-mark.svg"
import "../../../apps/web/src/styles/tokens.css"
import "./style.css"

type SessionRow = SessionItem
type PaletteAction = { readonly id: string; readonly group: "Session" | "Navigation" | "Settings"; readonly label: string; readonly detail?: string; readonly keywords: string; readonly run: () => void }

const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } })
const noActivity: Activity = { busy: new Set(), waiting: new Map() }
const [connection, setConnection] = createSignal<ConnectionState>({ generation: 0, status: "idle" })
const [activity, setActivity] = createSignal(noActivity)
const [paletteOpen, setPaletteOpen] = createSignal(false)
const [railOpen, setRailOpen] = createSignal(false)
const [railQuery, setRailQuery] = createSignal("")
const [newDirectory, setNewDirectory] = createSignal("")
const [newText, setNewText] = createSignal("")
const [newPending, setNewPending] = createSignal<{ directory: string; sessionID: string; promptID: string; text: string; created: boolean }>()
const [newUnconfirmed, setNewUnconfirmed] = createSignal(false)
const unconfirmed = new Set<string>()
const drafts = new Map<string, string>()
const pendings = new Map<string, { promptID: string; text: string }>()
const scope = () => [connection().generation, connection().revision ?? 0] as const
const live = () => connection().status === "connected" || connection().status === "reconnecting"
const reading = () => connection().status === "connected"
const failure = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : typeof cause === "string" ? cause : fallback
const sessionsQuery = (search = "") => ({ queryKey: ["sessions", ...scope(), search] as const, queryFn: () => api.sessions(search ? { search } : {}), enabled: reading() })
const refresh = (queryKey: readonly unknown[]) => void queries.invalidateQueries({ queryKey }, { cancelRefetch: false })
const mac = /Mac|iPhone|iPad/.test(navigator.platform)
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
const asked = new Set(["permission.asked", "question.asked", "guardrail.asked", "form.created"])
const settled = new Set(["permission.replied", "permission.cancelled", "question.replied", "question.rejected", "question.timed_out", "guardrail.replied", "guardrail.cancelled", "session.guardrail.decided", "form.replied", "form.cancelled", "form.timed_out"])
const requestEvents = /^(permission|form|question|guardrail)\.|^session\.(review|guardrail)\./
const stopped = new Set(["session.idle", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

function observe<T>(options: () => { queryKey: readonly unknown[]; queryFn: () => Promise<T>; enabled: boolean; refetchOnMount?: "always" }) {
  const observer = new QueryObserver<T>(queries, options())
  const [result, setResult] = createSignal(observer.getCurrentResult())
  const unsubscribe = observer.subscribe((value) => setResult(() => value))
  createEffect(() => observer.setOptions(options()))
  onCleanup(() => { unsubscribe(); observer.destroy() })
  return { result, refetch: () => void observer.refetch() }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

function word(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function payload(event: YCodingEvent): unknown {
  return "data" in event ? event.data : undefined
}

function eventSession(event: YCodingEvent) {
  const data = payload(event)
  return word(field(data, "sessionID")) ?? word(field(field(data, "form"), "sessionID"))
}

function eventRequest(event: YCodingEvent) {
  const data = payload(event)
  return word(field(data, "requestID")) ?? word(field(data, "id")) ?? word(field(field(data, "form"), "id"))
}

function withBusy(current: Activity, sessionID: string, busy: boolean): Activity {
  if (current.busy.has(sessionID) === busy) return current
  const next = new Set(current.busy)
  if (busy) next.add(sessionID); else next.delete(sessionID)
  return { ...current, busy: next }
}

function withRequest(current: Activity, sessionID: string, requestID: string, open: boolean): Activity {
  if (open) {
    if (current.waiting.get(sessionID)?.has(requestID)) return current
    return { ...current, waiting: new Map(current.waiting).set(sessionID, new Set(current.waiting.get(sessionID)).add(requestID)) }
  }
  if (![...current.waiting.values()].some((requests) => requests.has(requestID))) return current
  return { ...current, waiting: new Map([...current.waiting].flatMap(([id, requests]) => {
    const rest = new Set([...requests].filter((item) => item !== requestID))
    return rest.size ? [[id, rest] as const] : []
  })) }
}

function track(current: Activity, event: YCodingEvent): Activity {
  const type: string = event.type
  const sessionID = eventSession(event)
  if (!sessionID) return current
  if (type === "session.deleted") return withBusy({ ...current, waiting: new Map([...current.waiting].filter(([id]) => id !== sessionID)) }, sessionID, false)
  const status = word(field(field(payload(event), "status"), "type"))
  if (type === "session.execution.started" || (type === "session.status" && (status === "busy" || status === "retry"))) return withBusy(current, sessionID, true)
  if (stopped.has(type) || (type === "session.status" && status === "idle")) return withBusy(current, sessionID, false)
  const request = eventRequest(event)
  if (!request) return current
  if (asked.has(type)) return withRequest(current, sessionID, request, true)
  if (settled.has(type)) return withRequest(current, sessionID, request, false)
  return current
}

function descends(rows: ReadonlyMap<string, SessionRow>, row: SessionRow, ancestorID: string) {
  let current = row
  for (let hops = 0; current.parentID !== undefined && hops < 16; hops++) {
    if (current.parentID === ancestorID) return true
    const parent = rows.get(current.parentID)
    if (!parent) return false
    current = parent
  }
  return false
}

function typing(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
}

function focusHeading(heading: HTMLElement) {
  queueMicrotask(() => heading.focus({ preventScroll: true }))
}

function resetDrafts() {
  for (const [sessionID, pending] of pendings) {
    if (!drafts.has(sessionID)) drafts.set(sessionID, pending.text)
    unconfirmed.add(sessionID)
  }
  pendings.clear()
  if (newPending()) setNewUnconfirmed(true)
  setNewDirectory("")
  setNewPending(undefined)
}

function App() {
  const location = useLocation()
  const navigate = useNavigate()
  createEffect(() => {
    const path = location().pathname
    if (live() ? !path.startsWith("/sessions") : path !== "/") void navigate({ to: live() ? "/sessions" : "/" })
  })
  onMount(() => {
    const theme = window.matchMedia("(prefers-color-scheme: dark)")
    const paint = () => document.documentElement.dataset.theme = theme.matches ? "dark" : "light"
    paint()
    theme.addEventListener("change", paint)
    const apply = (state: ConnectionState) => {
      if (state.generation < connection().generation) return
      if (state.generation !== connection().generation) resetDrafts()
      if (state.generation !== connection().generation || state.revision !== connection().revision) { queries.clear(); setActivity(noActivity) }
      if (state.status !== "connected" && state.status !== "reconnecting") { setPaletteOpen(false); setRailOpen(false) }
      setConnection(state)
    }
    let observed = false
    const states = api.onState((state) => { observed = true; apply(state) })
    void api.state().then((state) => { if (!observed) apply(state) },
      (cause: unknown) => { if (!observed) apply({ generation: connection().generation, status: "error", error: failure(cause, "The native client state could not be read. Restart the app.") }) })
    const events = api.onEvent((event) => {
      setActivity((current) => track(current, event))
      const type: string = event.type
      if (type.startsWith("session.") && !/\.(delta|progress)$/.test(type)) refresh(["sessions"])
      const sessionID = eventSession(event)
      if (sessionID && type.startsWith("session.") && !/\.(delta|progress)$/.test(type)) refresh(["session", ...scope(), sessionID])
      if (sessionID) refresh(["messages", ...scope(), sessionID])
      if (sessionID && (requestEvents.test(type) || type === "session.idle")) refresh(["requests", ...scope(), sessionID])
    })
    const resync = api.onResync(() => { setActivity(noActivity); void queries.invalidateQueries(undefined, { cancelRefetch: false }) })
    const shortcut = (event: KeyboardEvent) => {
      if (!live() || event.altKey || event.isComposing) return
      const key = event.key.toLowerCase()
      const command = (event.metaKey || event.ctrlKey) && !event.shiftKey
      if (key === "k" && command) { event.preventDefault(); setPaletteOpen((open) => !open); return }
      if (key === "p" && event.ctrlKey && !event.metaKey && !event.shiftKey && !typing(event.target)) { event.preventDefault(); setPaletteOpen(true); return }
      if (paletteOpen()) return
      if (key === "n" && command) { event.preventDefault(); void navigate({ to: "/sessions" }); return }
      if (key === "escape" && railOpen()) setRailOpen(false)
    }
    window.addEventListener("keydown", shortcut)
    onCleanup(() => { theme.removeEventListener("change", paint); window.removeEventListener("keydown", shortcut); states(); events(); resync(); queries.clear() })
  })
  return <div class="desktop" classList={{ "desktop--workspace": live() }}>
    <header class="desktop__brand">
      <Show when={live()}><button type="button" class="desktop__rail-toggle" aria-expanded={railOpen()} aria-controls="session-rail" onClick={() => setRailOpen((open) => !open)}>Sessions</button></Show>
      <img src={mark} width="36" height="36" alt="" /><span class="desktop__name">YCoding <span class="desktop__muted">Desktop</span></span>
      <Show when={live()}><span class="desktop__tools">
        <span role="status" class="desktop__connection">{connection().status === "connected" ? "Connected" : "Reconnecting"} · {connection().mode === "own" ? "Private backend" : "Shared backend"}</span>
        <button type="button" class="desktop__palette" aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K" onClick={() => setPaletteOpen(true)}>Commands <kbd>{mac ? "⌘K" : "Ctrl K"}</kbd></button>
      </span></Show>
    </header>
    <Outlet />
    <Show when={live() && paletteOpen()}><Palette /></Show>
  </div>
}

function rank(action: PaletteAction, needle: string) {
  if (!needle) return 0
  const label = action.label.toLowerCase()
  if (label.startsWith(needle)) return 0
  if (label.split(/\s+/).some((part) => part.startsWith(needle))) return 1
  if (label.includes(needle)) return 2
  return `${action.detail ?? ""} ${action.keywords}`.toLowerCase().includes(needle) ? 3 : undefined
}

function Palette() {
  const navigate = useNavigate()
  const sessions = observe(sessionsQuery)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  let dialog: HTMLDialogElement | undefined
  let input: HTMLInputElement | undefined
  const actions = (): readonly PaletteAction[] => [
    { id: "new-chat", group: "Session", label: "New chat", detail: mac ? "⌘N" : "Ctrl N", keywords: "create start conversation", run: () => void navigate({ to: "/sessions" }) },
    { id: "refresh", group: "Session", label: "Refresh Sessions", keywords: "reload update list", run: () => refresh(["sessions"]) },
    ...railGroups(sessions.result().data?.items ?? [], activity()).groups.flatMap((group) => group.rows.map((row): PaletteAction => ({
      id: `open-${row.id}`, group: "Navigation", label: `Open ${row.title}`, detail: row.location.directory, keywords: `${row.id} ${group.label}`,
      run: () => void navigate({ to: "/sessions/$sessionID", params: { sessionID: row.id } }) }))),
    { id: "switch-backend", group: "Settings", label: "Switch backend", detail: connection().mode === "own" ? "Stops the private backend" : "Leaves the shared backend running", keywords: "disconnect connection mode", run: () => void api.disconnect() },
  ]
  const sections = createMemo(() => {
    const needle = query().trim().toLowerCase()
    const ranked = actions().flatMap((action) => { const score = rank(action, needle); return score === undefined ? [] : [{ action, score }] })
    if (needle) return [{ label: "Results", items: ranked.sort((a, b) => a.score - b.score).map((entry) => entry.action) }]
    return (["Session", "Navigation", "Settings"] as const).flatMap((label) => {
      const items = ranked.flatMap((entry) => entry.action.group === label ? [entry.action] : [])
      return items.length ? [{ label, items }] : []
    })
  })
  const flat = () => sections().flatMap((section) => section.items)
  const close = () => setPaletteOpen(false)
  const choose = (action: PaletteAction | undefined) => { if (!action) return; close(); action.run() }
  onMount(() => { dialog?.showModal(); input?.focus() })
  onCleanup(() => { if (dialog?.open) dialog.close(); if (opener?.isConnected) opener.focus() })
  createEffect(() => { void query(); setActive(0) })
  createEffect(() => document.getElementById(`palette-option-${active()}`)?.scrollIntoView({ block: "nearest" }))
  const move = (event: KeyboardEvent) => {
    const count = flat().length
    if (event.key === "Enter") { event.preventDefault(); choose(flat()[active()]); return }
    if (!count) return
    const target = event.key === "ArrowDown" ? (active() + 1) % count : event.key === "ArrowUp" ? (active() + count - 1) % count : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : undefined
    if (target === undefined) return
    event.preventDefault()
    setActive(target)
  }
  return <dialog ref={dialog} class="palette" aria-labelledby="palette-title" onCancel={(event) => { event.preventDefault(); close() }} onClick={(event) => { if (event.target === dialog) close() }}>
    <div class="palette__head"><h2 id="palette-title">Commands</h2><button type="button" onClick={close}>Close</button></div>
    <input ref={input} type="text" role="combobox" class="palette__input" aria-label="Search commands and Sessions" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-activedescendant={flat().length ? `palette-option-${active()}` : undefined}
      placeholder="Search commands and Sessions" autocomplete="off" spellcheck={false} value={query()} onInput={(event) => setQuery(event.currentTarget.value)} onKeyDown={move} />
    <ul id="palette-list" role="listbox" aria-label="Commands and Sessions" class="palette__list">
      <For each={sections()}>{(section) => <li role="presentation"><ul role="group" aria-label={section.label}>
        <li role="presentation" class="palette__group" aria-hidden="true">{section.label}</li>
        <For each={section.items}>{(action) => { const index = () => flat().indexOf(action)
          return <li id={`palette-option-${index()}`} role="option" class="palette__option" aria-selected={index() === active()} onPointerMove={() => setActive(index())} onClick={() => choose(action)}><span>{action.label}</span><Show when={action.detail}>{(detail) => <span class="desktop__metadata">{detail()}</span>}</Show></li> }}</For>
      </ul></li>}</For>
    </ul>
    <Show when={!flat().length}><p role="status" class="palette__empty">No matching commands or Sessions.</p></Show>
    <p class="desktop__muted palette__hint">Searches the most recent Sessions only; use the rail search for older ones. Arrow keys move, Enter selects, Escape closes.</p>
  </dialog>
}

function Connection() {
  const [mode, setMode] = createSignal<"own" | "shared">("own")
  const [server, setServer] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [notice, setNotice] = createSignal<string>()
  const busy = () => connection().status === "connecting"
  onMount(() => { void api.preferences().then((preferences) => {
    if (preferences.selection) setMode(preferences.selection.mode)
    setServer(preferences.sharedEndpoint ?? "")
    setNotice(preferences.error)
  }).catch(() => setNotice("Backend preferences could not be read. Choose a mode for this launch.")) })
  const start = async () => {
    setError(undefined)
    try { await api.connect(mode() === "own" ? { mode: "own" } : { mode: "shared", server: server() }) }
    catch (cause) { setError(failure(cause, "The backend could not connect. Retry.")) }
  }
  return <main><section aria-labelledby="connection-title"><h1 id="connection-title">Choose a backend</h1><p class="desktop__muted">Run a private backend for this window, or use one that is already running.</p>
    <form onSubmit={(event) => { event.preventDefault(); void start() }} aria-busy={busy()}>
      <fieldset disabled={busy()}><legend>Backend mode</legend>
        <label class="desktop__choice" data-selected={mode() === "own" ? "" : undefined}><input type="radio" name="backend-mode" value="own" checked={mode() === "own"} onChange={() => setMode("own")} /><span><strong>Start my own backend</strong><span class="desktop__muted">Uses the bundled runtime. Closing this window stops its private backend.</span></span></label>
        <label class="desktop__choice" data-selected={mode() === "shared" ? "" : undefined}><input type="radio" name="backend-mode" value="shared" checked={mode() === "shared"} onChange={() => setMode("shared")} /><span><strong>Connect to a shared backend</strong><span class="desktop__muted">Uses an existing endpoint. Closing this window leaves it running.</span></span></label>
        <Show when={mode() === "shared"}><label class="desktop__field">Shared endpoint<input type="url" value={server()} onInput={(event) => setServer(event.currentTarget.value)} placeholder="http://127.0.0.1:port" aria-describedby="shared-endpoint-hint" /></label><p id="shared-endpoint-hint" class="desktop__muted">Leave empty to discover the compatible managed local service. No service is started or replaced. Do not include credentials.</p></Show>
      </fieldset>
      <div class="desktop__feedback"><Show when={notice()}><p role="status">{notice()}</p></Show><Show when={error() ?? connection().error}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show><Show when={connection().status === "error" && connection().mode === "own"}><p role="status">The private backend is not running. Start it again to continue; unsent drafts are kept.</p></Show><Show when={busy()}><p role="status">Connecting to the native backend…</p></Show></div>
      <div class="desktop__actions"><button type="submit" class="desktop__primary" disabled={busy()}>{busy() ? "Connecting…" : mode() === "own" ? "Start my own backend" : "Connect to shared backend"}</button><Show when={busy()}><button type="button" onClick={() => void api.disconnect()}>Cancel connection</button></Show></div>
      <p class="desktop__muted">Your mode and a credential-free shared endpoint are remembered. Nothing connects automatically at startup.</p>
    </form>
  </section></main>
}

function Workspace() {
  const navigate = useNavigate()
  const location = useLocation()
  const term = () => searchTerm(railQuery())
  const [applied, setApplied] = createSignal(term().value)
  createEffect(() => {
    const next = term()
    if (next.error) return
    const timer = setTimeout(() => setApplied(next.value), 250)
    onCleanup(() => clearTimeout(timer))
  })
  const sessions = observe(() => sessionsQuery(applied()))
  const [paging, setPaging] = createSignal<Paging>()
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [pagingNote, setPagingNote] = createSignal<string>()
  const [pinning, setPinning] = createSignal<string>()
  const [pinNote, setPinNote] = createSignal<{ readonly text: string; readonly failed: boolean }>()
  createEffect(() => { void scope(); void applied(); setPaging(undefined); setPagingNote(undefined) })
  const selected = () => /^\/sessions\/([^/]+)$/.exec(location().pathname)?.[1]
  const state = () => { const first = sessions.result().data; return first ? pagingFor(first, applied(), paging()) : undefined }
  const items = createMemo(() => { const first = sessions.result().data; const current = state(); return first && current ? pagedItems(first, current) : [] })
  const grouped = createMemo(() => railGroups(items(), activity()))
  const loadMore = async () => {
    const current = state()
    const cursor = current?.next
    if (!current || cursor === undefined || loadingMore() || !reading()) return
    const generation = connection().generation
    setLoadingMore(true)
    setPagingNote(undefined)
    try {
      const page = await api.sessions({ revision: current.revision, cursor })
      if (connection().generation !== generation || !samePaging(state(), current)) return
      const merged = appendPage(current, page)
      if (merged) setPaging(merged)
      else { setPaging(undefined); setPagingNote("The Session list changed, so it was reloaded."); sessions.refetch() }
    } catch (cause) {
      if (connection().generation === generation && samePaging(state(), current)) { setPaging(undefined); setPagingNote(failure(cause, "More Sessions could not be read. The list was reloaded.")); sessions.refetch() }
    } finally { setLoadingMore(false) }
  }
  const togglePin = async (row: SessionRow) => {
    const first = sessions.result().data
    if (!first || pinning() !== undefined || !reading()) return
    const pinned = row.time.pinned === undefined
    const generation = connection().generation
    setPinning(row.id)
    setPinNote(undefined)
    try {
      await api.pin({ sessionID: row.id, revision: first.revision, pinned })
      if (connection().generation === generation) setPinNote({ text: `${pinned ? "Pinned" : "Unpinned"} ${row.title}.`, failed: false })
    } catch (cause) { if (connection().generation === generation) setPinNote({ text: failure(cause, "The pin change was not confirmed. Check the list."), failed: true }) }
    finally {
      setPinning(undefined)
      if (connection().generation === generation) { setPaging(undefined); refresh(["sessions"]) }
    }
  }
  const narrow = window.matchMedia("(max-width: 48rem)")
  const [drawer, setDrawer] = createSignal(narrow.matches)
  const sizing = () => setDrawer(narrow.matches)
  narrow.addEventListener("change", sizing)
  onCleanup(() => narrow.removeEventListener("change", sizing))
  let main: HTMLElement | undefined
  createEffect(() => main?.toggleAttribute("inert", railOpen() && drawer()))
  let opened = false
  createEffect(() => { void location().pathname; setRailOpen(false) })
  createEffect(() => {
    const rail = document.getElementById("session-rail")
    if (railOpen()) { opened = true; rail?.querySelector<HTMLElement>(".workspace__back")?.focus() }
    else if (opened && rail?.contains(document.activeElement)) document.querySelector<HTMLElement>(".desktop__rail-toggle")?.focus()
  })
  return <div class="workspace">
    <nav id="session-rail" class="workspace__rail" aria-label="Sessions" data-open={railOpen() ? "" : undefined}>
      <button type="button" class="workspace__back" onClick={() => setRailOpen(false)}>Back to chat</button>
      <button type="button" class="desktop__primary" aria-keyshortcuts="Meta+N Control+N" onClick={() => { setRailOpen(false); void navigate({ to: "/sessions" }) }}>New chat <kbd>{mac ? "⌘N" : "Ctrl N"}</kbd></button>
      <label class="workspace__search"><span class="workspace__search-label">Search Sessions</span><input type="search" value={railQuery()} placeholder="Search Sessions" aria-invalid={term().error ? "true" : undefined} aria-describedby={term().error ? "rail-search-error" : undefined} onInput={(event) => setRailQuery(event.currentTarget.value)} /></label>
      <Show when={term().error}>{(message) => <p id="rail-search-error" role="alert" class="desktop__error">{message()}</p>}</Show>
      <div class="workspace__list-head"><span class="desktop__muted"><Show when={state()} fallback="Recent Sessions">{(current) => <>{items().length} Sessions loaded{current().next === undefined ? "" : ", more available"}</>}</Show></span><button type="button" aria-label="Refresh Sessions" onClick={sessions.refetch} disabled={sessions.result().isFetching || !reading()}>Refresh</button></div>
      <Show when={!sessions.result().isPending} fallback={<p role="status">Loading Sessions…</p>}><Show when={!sessions.result().isError} fallback={<p role="alert" class="desktop__error">Sessions could not be read. Check the connection and refresh.</p>}>
        <Show when={items().length > 0} fallback={<p role="status">{applied() ? "No Sessions match your search." : "No Sessions in this backend."}</p>}>
          <Show when={grouped().groups.length} fallback={<p role="status">No Sessions to show.</p>}>
            <For each={grouped().groups}>{(group) => <section class="workspace__group" aria-labelledby={`rail-${group.key}`}>
              <h2 id={`rail-${group.key}`}>{group.label} <span class="desktop__metadata">{group.rows.length}</span></h2>
              <ul class="desktop__sessions"><For each={group.rows}>{(session) =>
                <li class="workspace__row"><Link to="/sessions/$sessionID" params={{ sessionID: session.id }} class="workspace__session" aria-current={selected() === session.id ? "page" : undefined}><strong>{session.title}</strong><span class="desktop__metadata">{session.location.directory}</span>
                  <Show when={group.key === "needs" || group.key === "running"}><span class="workspace__status" data-state={group.key}>{group.key === "needs" ? "Waiting for you" : "Running"}</span></Show></Link>
                  <button type="button" class="workspace__pin" disabled={!reading() || pinning() !== undefined} aria-label={`${session.time.pinned === undefined ? "Pin" : "Unpin"} ${session.title}`} onClick={() => void togglePin(session)}>{session.time.pinned === undefined ? "Pin" : "Unpin"}</button></li>}</For></ul>
            </section>}</For>
          </Show>
          <Show when={grouped().archived}><p class="desktop__muted">{grouped().archived} archived {grouped().archived === 1 ? "Session is" : "Sessions are"} hidden.</p></Show>
        </Show>
      </Show></Show>
      <Show when={state()?.next !== undefined}><button type="button" class="workspace__more" disabled={loadingMore() || !reading()} onClick={() => void loadMore()}>{loadingMore() ? "Loading…" : "Load more"}</button></Show>
      <Show when={pagingNote()}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show>
      <Show when={pinNote()}>{(result) => <p role={result().failed ? "alert" : "status"} class={result().failed ? "desktop__error" : "desktop__muted"}>{result().text}</p>}</Show>
      <p class="desktop__muted">Running and Needs action come from live events seen since this window connected. Earlier status is unavailable, so a Session can be running or waiting without appearing there.</p>
      <section class="workspace__backend" aria-labelledby="backend-title">
        <h2 id="backend-title">Backend</h2>
        <p class="desktop__metadata">Native API {connection().version} · process {connection().backendPID}</p>
        <Show when={connection().notice}>{(notice) => <p role="status">{notice()}</p>}</Show>
        <p class="desktop__muted">{connection().mode === "own" ? "Switching backend stops this private backend." : "Switching backend leaves the shared backend running."}</p>
        <button type="button" onClick={() => void api.disconnect()}>Switch backend</button>
      </section>
    </nav>
    <main class="workspace__main" ref={main}><Outlet /></main>
  </div>
}

function MessageField(props: { label: string; value: string; locked: boolean; onInput: (value: string) => void; onSubmit: () => void }) {
  return <label class="desktop__field">{props.label}<textarea rows={3} value={props.value} readOnly={props.locked} aria-describedby="message-hint" onInput={(event) => props.onInput(event.currentTarget.value)}
    onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); props.onSubmit() } }} />
    <span id="message-hint" class="desktop__muted">Enter sends. Shift+Enter adds a line. {mac ? "⌘K" : "Ctrl K"} opens commands.</span></label>
}

function NewChat() {
  const navigate = useNavigate()
  const workspaces = observe(() => ({ queryKey: ["workspaces", ...scope()] as const, queryFn: () => api.workspaces(), enabled: reading() }))
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const available = () => workspaces.result().data ?? []
  const ready = () => !!newPending() || (available().some((item) => item.directory === newDirectory()) && !!newText().trim())
  const start = async () => {
    if (busy() || !reading() || !ready()) return
    const draft = newPending() ?? { directory: newDirectory(), sessionID: `ses_${crypto.randomUUID()}`, promptID: `msg_${crypto.randomUUID()}`, text: newText(), created: false }
    const generation = connection().generation
    setNewPending(draft)
    setNewUnconfirmed(false)
    setBusy(true)
    setError(undefined)
    try {
      if (!draft.created) {
        await api.createSession({ directory: draft.directory, sessionID: draft.sessionID })
        if (connection().generation !== generation) return
        setNewPending({ ...draft, created: true })
        refresh(["sessions"])
      }
      await api.prompt({ sessionID: draft.sessionID, promptID: draft.promptID, text: draft.text })
      if (connection().generation !== generation) return
      setNewPending(undefined)
      setNewText("")
      await navigate({ to: "/sessions/$sessionID", params: { sessionID: draft.sessionID } })
    } catch (cause) { if (connection().generation === generation) setError(failure(cause, "The chat was not confirmed. Check Recent Sessions, then retry.")) }
    finally { setBusy(false) }
  }
  return <section class="page" aria-labelledby="new-chat-title"><h1 id="new-chat-title" tabindex="-1" ref={focusHeading}>New chat</h1>
    <p class="desktop__muted">Sending requires a repository. Choose one this backend has opened before; the chat is bound to it and nothing is created until you send.</p>
    <form onSubmit={(event) => { event.preventDefault(); void start() }} aria-busy={busy()}>
      <label class="desktop__field">Repository<select value={newDirectory()} disabled={!!newPending() || workspaces.result().isPending} onChange={(event) => setNewDirectory(event.currentTarget.value)}>
        <option value="">Choose repository</option><For each={available()}>{(item) => <option value={item.directory}>{item.name ? `${item.name} — ${item.directory}` : item.directory}</option>}</For></select></label>
      <Show when={newUnconfirmed()}><p role="status">The previous attempt was not confirmed before the connection changed. Check Sessions before sending again.</p></Show>
      <div class="desktop__feedback">
        <Show when={workspaces.result().isPending && reading()}><p role="status">Loading previously opened repositories…</p></Show>
        <Show when={workspaces.result().isError}><p role="alert" class="desktop__error">Previously opened repositories could not be read. Refresh to retry.</p></Show>
        <Show when={workspaces.result().isSuccess && !available().length}><p role="status">No previously opened repositories are available. Open a repository with YCoding on this machine once, then refresh.</p></Show>
      </div>
      <div class="desktop__actions"><button type="button" onClick={workspaces.refetch} disabled={workspaces.result().isFetching || !reading()}>Refresh repositories</button></div>
      <MessageField label="First message" value={newPending()?.text ?? newText()} locked={!!newPending()} onInput={setNewText} onSubmit={() => void start()} />
      <div class="desktop__feedback"><Show when={error()}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show><Show when={busy()}><p role="status">Starting the chat…</p></Show></div>
      <div class="desktop__actions"><button type="submit" class="desktop__primary" aria-label={busy() ? "Starting the chat" : newPending() ? "Retry starting the chat" : "Send prompt"} disabled={busy() || !reading() || !ready()}>{busy() ? "Starting…" : newPending() ? "Retry" : "Send"}</button>
        <Show when={newPending() && !busy()}><button type="button" onClick={() => { setNewText(newPending()?.text ?? ""); setNewPending(undefined); setError(undefined) }}>Edit draft</button></Show></div>
    </form>
  </section>
}

function turn(message: Messages[number]) {
  switch (message.type) {
    case "user": return { id: message.id, kind: "user", speaker: "You", text: message.text, notes: [] as string[] }
    case "assistant": {
      const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n\n")
      const notes = message.content.flatMap((part) => part.type === "tool" ? [`${part.name} · ${part.state.status}`] : [])
      if (!text && message.content.some((part) => part.type === "reasoning")) notes.push("Reasoning is not shown in the desktop app.")
      if (message.finish === "error") notes.push("The response ended with an error.")
      return { id: message.id, kind: "assistant", speaker: message.agent, text: text || (message.time.completed ? "" : "Working…"), notes }
    }
    case "system": case "synthetic": return { id: message.id, kind: "system", speaker: "System", text: message.text, notes: [] as string[] }
    case "shell": return { id: message.id, kind: "shell", speaker: "Shell", text: `$ ${message.command}`, notes: [message.status] }
    default: return { id: message.id, kind: "other", speaker: "Notice", text: "", notes: [`${message.type} entry is not shown in the desktop app.`] }
  }
}

function usage(session: SessionRow) {
  const input = session.tokens.input + session.tokens.cache.read + session.tokens.cache.write
  const output = session.tokens.output + session.tokens.reasoning
  return `${compact.format(input)} in · ${compact.format(output)} out${session.cost > 0 ? ` · $${session.cost.toFixed(2)}` : ""}`
}

const percent = (part: number, whole: number) => whole > 0 ? Math.round(part / whole * 100) : 0
const breakdownLabels = [["system", "System"], ["tools", "Tools"], ["user", "User"], ["assistant", "Assistant"], ["reasoning", "Reasoning"], ["toolCalls", "Tool calls"], ["other", "Other"]] as const

type ModelId = { readonly id: string; readonly providerID: string }

function contextOf(list: Messages, current?: ModelId) {
  const later: Messages = []
  for (const message of list.toReversed()) {
    const limit = message.type === "assistant" ? message.diagnostics?.contextLimit : undefined
    if (message.type === "assistant" && message.tokens && limit && limit > 0) {
      const used = message.tokens.input + message.tokens.output + message.tokens.reasoning + message.tokens.cache.read + message.tokens.cache.write
      if (used > 0) {
        const differs = (model: ModelId) => model.id !== message.model.id || model.providerID !== message.model.providerID
        const stale = later.some((entry) => entry.type === "compaction") ? "the conversation was compacted after"
          : later.some((entry) => entry.type === "assistant" && differs(entry.model)) || (current !== undefined && differs(current)) ? "the model changed after"
          : undefined
        return { used, limit, stale, breakdown: message.diagnostics?.contextBreakdown }
      }
    }
    later.push(message)
  }
  return undefined
}

function responding(list: Messages) {
  const last = list.findLast((message) => message.type === "assistant")
  return last?.type === "assistant" && last.time.completed === undefined
}

function Context(props: { messages: Messages; model?: ModelId }) {
  const context = () => contextOf(props.messages, props.model)
  return <Show when={context()} fallback={<span class="conversation__chip" title="The backend has not reported context usage for this Session yet.">Context unknown</span>}>{(value) => {
    const total = () => { const breakdown = value().breakdown; return breakdown ? breakdownLabels.reduce((sum, [key]) => sum + breakdown[key], 0) : 0 }
    return <Show when={value().stale} fallback={
      <details class="context"><summary>Context {compact.format(value().used)} / {compact.format(value().limit)} · {percent(value().used, value().limit)}% used · latest response</summary>
        <p class="context__figures"><span class="context__used">{compact.format(value().used)}</span><span class="context__capacity">/ {compact.format(value().limit)} tokens</span></p>
        <meter min={0} max={value().limit} value={Math.min(value().used, value().limit)} aria-label="Context used" />
        <p class="desktop__muted">Tokens reported for the latest response against that response's context limit. They may not reflect a model changed since.</p>
        <Show when={total() > 0 ? value().breakdown : undefined}>{(breakdown) => <>
          <p class="desktop__muted">Estimated input breakdown: a request estimate, separate from the reported tokens above.</p>
          <ul class="context__breakdown"><For each={breakdownLabels}>{([key, label]) => <li><span>{label}</span><span class="desktop__metadata">{compact.format(breakdown()[key])} · {percent(breakdown()[key], total())}%</span></li>}</For></ul>
        </>}</Show>
      </details>}>{(reason) => <span class="conversation__chip" title="The last reported context figures are out of date until the next response reports them.">Context unknown: {reason()} the last report</span>}</Show>
  }}</Show>
}

function is<T extends Field["type"]>(item: Field, type: T): item is Extract<Field, { type: T }> {
  return item.type === type
}

const errorId = (scope: string, index: number) => `${scope}-${index}-error`

function FieldInput(props: { scope: string; index: number; field: Field; value: Value | undefined; invalid: boolean; onChange: (value: Value) => void }) {
  const text = () => typeof props.value === "string" ? props.value : ""
  const picks = () => Array.isArray(props.value) ? props.value : []
  const label = () => props.field.title ?? props.field.key
  const described = () => props.invalid ? errorId(props.scope, props.index) : undefined
  const [extra, setExtra] = createSignal("")
  return <>
    <Show when={is(props.field, "string") ? props.field : undefined}>{(item) => <Show when={item().options} fallback={<input type={item().format === "email" ? "email" : item().format === "uri" ? "url" : item().format === "date" ? "date" : "text"} aria-label={label()} aria-invalid={props.invalid} aria-describedby={described()} value={text()} placeholder={item().placeholder} onInput={(event) => props.onChange(event.currentTarget.value)} />}>{(options) => <>
      <For each={options()}>{(option) => <label class="request__choice"><input type="radio" name={`${props.scope}-${props.index}`} aria-invalid={props.invalid} aria-describedby={described()} checked={text() === option.value} onChange={() => props.onChange(option.value)} /><span><strong>{option.label}</strong><Show when={option.description}> — {option.description}</Show></span></label>}</For>
      <Show when={item().custom}><label class="request__choice">Other<input type="text" aria-label={`Other: ${label()}`} aria-invalid={props.invalid} aria-describedby={described()} value={options().some((option) => option.value === text()) ? "" : text()} onInput={(event) => props.onChange(event.currentTarget.value)} /></label></Show>
    </>}</Show>}</Show>
    <Show when={is(props.field, "number") || is(props.field, "integer") ? props.field : undefined}>{(item) => <input type="number" aria-label={label()} aria-invalid={props.invalid} aria-describedby={described()} inputmode="decimal" step={item().type === "integer" ? 1 : "any"} min={item().minimum} max={item().maximum} value={text()} onInput={(event) => props.onChange(event.currentTarget.value)} />}</Show>
    <Show when={is(props.field, "boolean")}><label class="request__choice"><input type="checkbox" checked={props.value === true} onChange={(event) => props.onChange(event.currentTarget.checked)} /><span>Yes</span></label></Show>
    <Show when={is(props.field, "multiselect") ? props.field : undefined}>{(item) => <>
      <For each={item().options}>{(option) => <label class="request__choice"><input type="checkbox" aria-invalid={props.invalid} aria-describedby={described()} checked={picks().includes(option.value)} onChange={(event) => props.onChange(event.currentTarget.checked ? [...picks(), option.value] : picks().filter((entry) => entry !== option.value))} /><span><strong>{option.label}</strong><Show when={option.description}> — {option.description}</Show></span></label>}</For>
      <Show when={picks().filter((entry) => !item().options.some((option) => option.value === entry)).length}><p class="desktop__metadata">Added: {picks().filter((entry) => !item().options.some((option) => option.value === entry)).join(", ")}</p></Show>
      <Show when={item().custom}><span class="request__add"><input type="text" aria-label={`Another choice: ${label()}`} aria-invalid={props.invalid} aria-describedby={described()} value={extra()} onInput={(event) => setExtra(event.currentTarget.value)} /><button type="button" disabled={!extra().trim() || picks().includes(extra().trim())} onClick={() => { props.onChange([...picks(), extra().trim()]); setExtra("") }}>Add choice</button></span></Show>
    </>}</Show>
    <Show when={is(props.field, "external") ? props.field : undefined}>{(item) => <><p class="desktop__metadata">{item().url}</p><p class="desktop__muted">Open this link in your browser; the desktop app does not open links. Then confirm below.</p>
      <label class="request__choice"><input type="checkbox" aria-invalid={props.invalid} aria-describedby={described()} checked={props.value === true} onChange={(event) => props.onChange(event.currentTarget.checked)} /><span>I have completed this step</span></label></>}</Show>
  </>
}

function unlockFocus(locked: () => boolean, card: () => HTMLElement | undefined, heading: () => HTMLElement | undefined) {
  let was = locked()
  createEffect(() => {
    const now = locked()
    const active = document.activeElement
    const at: FocusAt = !active || active === document.body ? "body" : active === card() ? "card" : card()?.contains(active) ? "control" : "elsewhere"
    if (restoresFocus(was, now, at)) heading()?.focus({ preventScroll: true })
    was = now
  })
}

function FormCard(props: { form: FormRequest; locked: boolean; notice?: string; onSubmit: (answer: FormAnswer) => void; onCancel: () => void }) {
  const [values, setValues] = createSignal(initialValues(props.form.fields))
  const visible = () => activeFields(props.form.fields, values())
  const issues = () => visible().flatMap((item) => problemOf(item, valueFor(values(), item.key)) ?? [])
  const [touched, setTouched] = createSignal<ReadonlySet<number>>(new Set())
  const touch = (index: number) => setTouched((current) => current.has(index) ? current : new Set(current).add(index))
  const shownProblem = (item: Field) => touched().has(props.form.fields.indexOf(item)) ? problemOf(item, valueFor(values(), item.key)) : undefined
  let card: HTMLElement | undefined
  let heading: HTMLHeadingElement | undefined
  let form: HTMLFormElement | undefined
  unlockFocus(() => props.locked, () => card, () => heading)
  const submit = () => {
    if (props.locked) return
    if (invalidIndexes(props.form.fields, values()).length) {
      setTouched((current) => new Set([...current, ...visible().map((item) => props.form.fields.indexOf(item))]))
      queueMicrotask(() => form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
    props.onSubmit(buildAnswer(props.form.fields, values()))
  }
  return <article class="request" ref={card} aria-labelledby={`form-${props.form.id}`}>
    <h2 id={`form-${props.form.id}`} tabindex="-1" ref={heading}>{props.form.title}</h2>
    <p class="desktop__muted">This Session asks for your answer. Nothing is sent until you choose Send answer.</p>
    <form ref={form} onSubmit={(event) => { event.preventDefault(); submit() }}>
      <For each={visible()}>{(item) => <fieldset class="request__field" onFocusOut={(event) => { const next = event.relatedTarget; if (!(next instanceof Node) || !event.currentTarget.contains(next)) touch(props.form.fields.indexOf(item)) }}><legend>{item.title ?? item.key}{item.type === "external" || item.required ? " (required)" : ""}</legend>
        <Show when={item.description}><p class="desktop__muted">{item.description}</p></Show>
        <FieldInput scope={props.form.id} index={props.form.fields.indexOf(item)} field={item} value={valueFor(values(), item.key)} invalid={!!shownProblem(item)} onChange={(value) => { touch(props.form.fields.indexOf(item)); setValues((current) => withValue(current, item.key, value)) }} />
        <Show when={shownProblem(item)}>{(text) => <p id={errorId(props.form.id, props.form.fields.indexOf(item))} role="alert" class="desktop__error">{text()}</p>}</Show></fieldset>}</For>
      <Show when={issues().length}><p class="desktop__muted">{issues().length === 1 ? "One field needs attention" : `${issues().length} fields need attention`} before the answer can be sent. Choose Send answer to see what to fix.</p></Show>
      <Show when={props.notice}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show>
      <div class="desktop__actions"><button type="submit" class="desktop__primary" disabled={props.locked}>Send answer</button>
        <button type="button" disabled={props.locked} onClick={props.onCancel}>Cancel form</button></div>
    </form>
  </article>
}

function PermissionCard(props: { request: PermissionRequest; locked: boolean; notice?: string; onReply: (reply: "once" | "always" | "reject", message?: string) => void }) {
  const [reason, setReason] = createSignal("")
  let card: HTMLElement | undefined
  let heading: HTMLHeadingElement | undefined
  unlockFocus(() => props.locked, () => card, () => heading)
  return <article class="request" ref={card} aria-labelledby={`permission-${props.request.id}`}>
    <h2 id={`permission-${props.request.id}`} tabindex="-1" ref={heading}>Permission requested: {props.request.action}</h2>
    <ul class="request__resources"><For each={props.request.resources}>{(resource) => <li class="desktop__metadata">{resource}</li>}</For></ul>
    <Show when={props.request.save?.length} fallback={<p class="desktop__muted">This request has no rule to save, so only Allow once and Reject are offered.</p>}><p class="desktop__muted">Always allow saves a permission rule for: {props.request.save?.join(", ")}.</p></Show>
    <label class="desktop__field">Reason (optional, sent with Reject)<input type="text" maxlength="4096" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} /></label>
    <Show when={props.notice}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show>
    <div class="desktop__actions">
      <button type="button" disabled={props.locked} onClick={() => props.onReply("reject", reason().trim() || undefined)}>Reject</button>
      <button type="button" disabled={props.locked} onClick={() => props.onReply("once")}>Allow once</button>
      <Show when={props.request.save?.length}><button type="button" disabled={props.locked} onClick={() => props.onReply("always")}>Always allow</button></Show>
    </div>
  </article>
}

function Requests(props: { data: PendingRequests; updatedAt: number; refetch: () => void }) {
  const [working, setWorking] = createSignal(false)
  const [held, setHeld] = createSignal<ReadonlyMap<string, { readonly message?: string; readonly at: number }>>(new Map())
  const [lost, setLost] = createSignal<string>()
  let answered: string | undefined
  const waiting = (id: string) => props.updatedAt <= (held().get(id)?.at ?? -1)
  const locked = (id: string) => working() || waiting(id)
  const notice = (id: string) => {
    const message = held().get(id)?.message
    return message === undefined ? undefined : waiting(id) ? `${message} Refreshing requests…` : `${message} The request is still pending. Review your answer and try again.`
  }
  createEffect(() => {
    const pending = new Set([...props.data.permissions, ...props.data.forms].map((item) => item.id))
    const id = answered
    if (id === undefined || pending.has(id)) return
    answered = undefined
    if (held().get(id)?.message !== undefined) setLost("A reply was not confirmed and that request is no longer pending. Check the transcript to see whether it was applied.")
    setHeld((current) => new Map([...current].filter(([key]) => key !== id)))
    queueMicrotask(() => document.getElementById("conversation-title")?.focus({ preventScroll: true }))
  })
  const answer = async (id: string, input: RequestReply) => {
    if (working()) return
    const generation = connection().generation
    answered = id
    setLost(undefined)
    setHeld((current) => new Map([...current].filter(([key]) => key !== id)))
    setWorking(true)
    let message: string | undefined
    try { await api.reply(input) }
    catch (cause) { message = failure(cause, "The answer was not confirmed.") }
    finally {
      setWorking(false)
      if (connection().generation === generation) {
        setHeld((current) => new Map(current).set(id, message === undefined ? { at: Date.now() } : { message, at: Date.now() }))
        props.refetch()
      }
    }
  }
  return <section class="requests" aria-label="Requests waiting for you">
    <Show when={lost()}>{(message) => <p role="status" class="desktop__error">{message()}</p>}</Show>
    <For each={props.data.permissions}>{(request) => <PermissionCard request={request} locked={locked(request.id)} notice={notice(request.id)}
      onReply={(reply, message) => void answer(request.id, { kind: "permission", sessionID: props.data.sessionID, revision: props.data.revision, requestID: request.id, reply, ...(message === undefined ? {} : { message }) })} />}</For>
    <For each={props.data.forms}>{(form) => <FormCard form={form} locked={locked(form.id)} notice={notice(form.id)}
      onSubmit={(value) => void answer(form.id, { kind: "form", sessionID: props.data.sessionID, revision: props.data.revision, formID: form.id, answer: value })}
      onCancel={() => void answer(form.id, { kind: "form-cancel", sessionID: props.data.sessionID, revision: props.data.revision, formID: form.id })} />}</For>
  </section>
}

function ModelPicker(props: { sessionID: string; model?: ModelId; running: boolean }) {
  const catalog = observe(() => ({ queryKey: ["models", ...scope(), props.sessionID] as const, queryFn: () => api.models(props.sessionID), enabled: reading(), refetchOnMount: "always" as const }))
  const data = () => { const found = catalog.result().isError ? undefined : catalog.result().data; return found && "current" in found && found.source.sessionID === props.sessionID && found.revision === connection().revision ? found : undefined }
  const [chosen, setChosen] = createSignal<ModelChoice>()
  const [switching, setSwitching] = createSignal(false)
  const [outcome, setOutcome] = createSignal<{ readonly text: string; readonly failed: boolean }>()
  const list = createMemo(() => visibleModels(data()?.models ?? [], data()?.current))
  const choice = () => chosen() ?? choiceFor(list(), data()?.current)
  const picked = () => data() ? selectionFor(list(), choice()) : undefined
  const blocked = () => props.running || data()?.running === true
  const selected = () => list()[choice().model]
  const switchTo = async () => {
    const found = data()
    const model = picked()
    if (!found || !model || switching() || blocked() || !reading()) return
    const generation = connection().generation
    setSwitching(true)
    setOutcome(undefined)
    try {
      await api.switchModel({ sessionID: props.sessionID, revision: found.revision, model })
      if (connection().generation === generation) setOutcome({ text: "Model switched.", failed: false })
    } catch (cause) { if (connection().generation === generation) setOutcome({ text: failure(cause, "The model switch was not confirmed. Refresh models to see whether it changed."), failed: true }) }
    finally {
      setSwitching(false)
      if (connection().generation === generation) { setChosen(undefined); catalog.refetch(); refresh(["sessions"]); refresh(["session", ...scope(), props.sessionID]) }
    }
  }
  const label = () => props.model ? `Model ${props.model.id}` : "Model not set"
  return <div class="model-picker">
    <Show when={data()} fallback={<span class="conversation__chip">{label()}</span>}>{(found) =>
      <details class="model-picker__panel"><summary>{label()}</summary>
        <form class="model-picker__form" aria-busy={switching()} onSubmit={(event) => { event.preventDefault(); void switchTo() }}>
          <label class="desktop__field">Model<select disabled={blocked() || switching()} onChange={(event) => setChosen(chooseModel(list(), Number(event.currentTarget.value)))}>
            <Show when={choice().model < 0}><option value="-1" selected disabled>Choose a model</option></Show>
            <Index each={list()}>{(item, index) => <option value={index} selected={choice().model === index}>{modelLabel(item())}</option>}</Index></select></label>
          <Show when={selected()?.profiles.length || choice().profile !== ""}><label class="desktop__field">Profile<select disabled={blocked() || switching()} onChange={(event) => setChosen(chooseProfile(list(), choice(), event.currentTarget.value))}>
            <option value="" selected={choice().profile === ""} disabled={!selected()?.enabled}>No profile</option>
            <For each={selected()?.profiles}>{(item) => <option value={item.name} selected={choice().profile === item.name}>{profileLabel(item)}</option>}</For></select></label></Show>
          <Show when={variantsFor(selected(), choice().profile).length || choice().variant !== ""}><label class="desktop__field">Variant<select disabled={blocked() || switching()} onChange={(event) => setChosen({ ...choice(), variant: event.currentTarget.value })}>
            <option value="" selected={choice().variant === ""}>Default variant</option>
            <For each={variantsFor(selected(), choice().profile)}>{(item) => <option value={item} selected={choice().variant === item}>{item}</option>}</For></select></label></Show>
          <Show when={!blocked() ? choiceProblem(list(), choice()) : undefined}>{(problem) => <p role="status" class="desktop__muted">{problem()}</p>}</Show>
          <div class="desktop__actions"><button type="submit" disabled={switching() || blocked() || !reading() || !picked() || sameSelection(picked(), found().current)}>{switching() ? "Switching…" : "Switch model"}</button>
            <button type="button" disabled={switching() || catalog.result().isFetching || !reading()} onClick={catalog.refetch}>Refresh models</button></div>
        </form></details>}</Show>
    <Show when={data() && blocked()}><span role="status" class="desktop__muted">Stop the running chat before switching models.</span></Show>
    <Show when={catalog.result().isPending && reading()}><span role="status" class="desktop__muted">Loading models…</span></Show>
    <Show when={catalog.result().data && !catalog.result().isError && !data()}><span role="status" class="desktop__muted">Refreshing models after a connection change…</span></Show>
    <Show when={catalog.result().isError}><div role="alert" class="desktop__error"><p>{failure(catalog.result().error, "Models could not be read. Refresh to retry.")}</p><button type="button" onClick={catalog.refetch} disabled={!reading()}>Refresh models</button></div></Show>
    <Show when={outcome()}>{(result) => <p role={result().failed ? "alert" : "status"} class={result().failed ? "desktop__error" : "desktop__muted"}>{result().text}</p>}</Show>
  </div>
}

function Conversation(props: { sessionID: string }) {
  const sessions = observe(sessionsQuery)
  const sessionRead = observe(() => ({ queryKey: ["session", ...scope(), props.sessionID] as const, queryFn: () => api.session({ sessionID: props.sessionID }), enabled: reading() }))
  const messages = observe(() => ({ queryKey: ["messages", ...scope(), props.sessionID] as const, queryFn: () => api.messages(props.sessionID), enabled: reading(), refetchOnMount: "always" as const }))
  const requests = observe(() => ({ queryKey: ["requests", ...scope(), props.sessionID] as const, queryFn: () => api.requests(props.sessionID), enabled: reading() }))
  const pendingRequests = () => { const data = requests.result().data; return data?.sessionID === props.sessionID && data.revision === connection().revision ? data : undefined }
  const requestCount = () => (pendingRequests()?.permissions.length ?? 0) + (pendingRequests()?.forms.length ?? 0)
  const unanswerable = () => {
    const known = new Set([...(pendingRequests()?.permissions ?? []), ...(pendingRequests()?.forms ?? [])].map((item) => item.id))
    return !!pendingRequests() && [...(activity().waiting.get(props.sessionID) ?? [])].some((id) => !known.has(id))
  }
  const subagentsWaiting = () => {
    const rows = sessions.result().data?.items ?? []
    const byID = new Map(rows.map((row) => [row.id, row] as const))
    return rows.filter((row) => (activity().waiting.get(row.id)?.size ?? 0) > 0 && descends(byID, row, props.sessionID))
  }
  const [stopping, setStopping] = createSignal(false)
  const [stopNote, setStopNote] = createSignal<string>()
  const session = () => { const data = sessionRead.result().data; return data && data.revision === connection().revision && data.item.id === props.sessionID ? data.item : undefined }
  const turns = () => (messages.result().data ?? []).map(turn)
  const [announcement, setAnnouncement] = createSignal<{ readonly id: string; readonly text: string }>()
  let baselined = false
  let announced: string | undefined
  createEffect(() => {
    const result = messages.result()
    if (!result.isSuccess || !result.isFetchedAfterMount) return
    const finished = result.data.findLast((message) => message.type === "assistant" && message.time.completed)
    if (!baselined) { baselined = true; announced = finished?.id; return }
    if (finished?.type === "assistant" && finished.id !== announced) { announced = finished.id; setAnnouncement({ id: finished.id, text: `${finished.agent} finished a response.` }) }
  })
  const running = () => activity().busy.has(props.sessionID) || responding(messages.result().data ?? [])
  const stop = async () => {
    if (stopping() || !reading()) return
    const generation = connection().generation
    setStopping(true)
    setStopNote(undefined)
    try {
      await api.interrupt(props.sessionID)
      if (connection().generation === generation) { setStopNote("Stop requested. Check the transcript to confirm the response ended."); refresh(["messages", ...scope(), props.sessionID]) }
    } catch (cause) { if (connection().generation === generation) setStopNote(failure(cause, "Stopping was not confirmed. Check the Session before retrying.")) }
    finally { setStopping(false) }
  }
  const [text, setText] = createSignal(drafts.get(props.sessionID) ?? "")
  const [pending, setPending] = createSignal(pendings.get(props.sessionID))
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [following, setFollowing] = createSignal(true)
  const [unsure, setUnsure] = createSignal(unconfirmed.has(props.sessionID))
  let scroller: HTMLDivElement | undefined
  const toEnd = () => { if (scroller) scroller.scrollTop = scroller.scrollHeight }
  const update = (value: string) => { setText(value); if (value) drafts.set(props.sessionID, value); else drafts.delete(props.sessionID) }
  const hold = (value: { promptID: string; text: string } | undefined) => { setPending(value); if (value) pendings.set(props.sessionID, value); else pendings.delete(props.sessionID) }
  createEffect(() => { void turns(); void requestCount(); if (following()) toEnd() })
  const send = async () => {
    if (sending() || !reading()) return
    const draft = pending() ?? (text().trim() ? { promptID: `msg_${crypto.randomUUID()}`, text: text() } : undefined)
    if (!draft) return
    const generation = connection().generation
    hold(draft)
    setSending(true)
    setError(undefined)
    setUnsure(false)
    unconfirmed.delete(props.sessionID)
    try {
      await api.prompt({ sessionID: props.sessionID, ...draft })
      if (connection().generation !== generation) return
      hold(undefined)
      update("")
      setFollowing(true)
      refresh(["messages", ...scope(), props.sessionID])
    } catch (cause) { if (connection().generation === generation) setError(failure(cause, "The message was not confirmed. Check the Session, then retry.")) }
    finally { setSending(false) }
  }
  return <section class="conversation" aria-labelledby="conversation-title">
    <header class="conversation__head">
      <h1 id="conversation-title" tabindex="-1" ref={focusHeading}>{session()?.title ?? "Session"}</h1>
      <Show when={sessionRead.result().isError}><div role="alert" class="desktop__error"><p>{failure(sessionRead.result().error, "The Session could not be read. Refresh to retry.")}</p><button type="button" onClick={sessionRead.refetch} disabled={!reading()}>Refresh Session</button></div></Show>
      <Show when={session()}>{(item) => <>
        <p class="desktop__metadata">{item().location.directory} · {props.sessionID}</p>
        <div class="conversation__meta"><Show when={item().agent}>{(agent) => <span class="conversation__chip">Agent {agent()}</span>}</Show><ModelPicker sessionID={props.sessionID} model={item().model} running={running()} /><span class="conversation__chip" title="Cumulative tokens across the whole Session, not the context window.">Session tokens {usage(item())}</span><Context messages={messages.result().data ?? []} model={item().model} /></div>
      </>}</Show>
      <Show when={unsure()}><p role="status" class="conversation__notice">A send was not confirmed before the connection changed. Check the transcript before sending again.</p></Show>
      <Show when={requestCount() > 0}><p role="status" class="conversation__notice" data-state="needs">This Session is waiting for you: {requestCount()} {requestCount() === 1 ? "request is" : "requests are"} below the transcript.</p></Show>
      <Show when={unanswerable()}><p role="status" class="conversation__notice" data-state="needs">This Session also has a guardrail review or question that the desktop app cannot answer yet. Answer it in the terminal or the web app.</p></Show>
      <Show when={subagentsWaiting().length}><p role="status" class="conversation__notice" data-state="needs">A subagent Session of this chat is waiting for you. Its request belongs to that Session and is answered there:{" "}
        <For each={subagentsWaiting()}>{(row) => <Link to="/sessions/$sessionID" params={{ sessionID: row.id }} class="conversation__link">{row.title}</Link>}</For></p></Show>
    </header>
    <p class="desktop__sr" role="status"><Show when={announcement()} keyed>{(entry) => <span>{entry.text}</span>}</Show></p>
    <div class="conversation__scroll" ref={scroller} onScroll={() => setFollowing(!scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48)}>
      <Show when={!messages.result().isPending} fallback={<p role="status">Loading the transcript…</p>}><Show when={!messages.result().isError} fallback={<div role="alert" class="desktop__error"><p>The transcript could not be read. Check the connection and refresh.</p><button type="button" onClick={messages.refetch} disabled={!reading()}>Refresh transcript</button></div>}>
        <Show when={turns().length} fallback={<p>No messages in this Session yet.</p>}><ol class="transcript" aria-label="Transcript"><Index each={turns()}>{(item) =>
          <li class="transcript__turn" data-speaker={item().kind}><span class="transcript__speaker">{item().speaker}</span><Show when={item().text}><p class="transcript__text">{item().text}</p></Show>
            <Show when={item().notes.length}><ul class="transcript__notes"><For each={item().notes}>{(note) => <li class="desktop__metadata">{note}</li>}</For></ul></Show></li>}</Index></ol></Show>
      </Show></Show>
      <Show when={requests.result().isError}><div role="alert" class="desktop__error"><p>Pending requests could not be read. Refresh to retry.</p><button type="button" onClick={requests.refetch} disabled={!reading()}>Refresh requests</button></div></Show>
      <Show when={requests.result().data && !pendingRequests()}><p role="status">Refreshing requests after a connection change…</p></Show>
      <Show when={pendingRequests()}>{(data) => <Requests data={data()} updatedAt={requests.result().dataUpdatedAt} refetch={requests.refetch} />}</Show>
      <Show when={!following()}><button type="button" class="conversation__jump" onClick={() => { toEnd(); setFollowing(true) }}>Jump to latest</button></Show>
    </div>
    <form class="composer" onSubmit={(event) => { event.preventDefault(); void send() }} aria-busy={sending()}>
      <MessageField label="Message" value={pending()?.text ?? text()} locked={!!pending()} onInput={update} onSubmit={() => void send()} />
      <div class="desktop__feedback"><Show when={error()}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show><Show when={sending()}><p role="status">Sending…</p></Show><Show when={!reading()}><p role="status">Reconnecting. Sending resumes when the backend is connected.</p></Show></div>
      <div class="desktop__actions"><button type="submit" class="desktop__primary" aria-label={sending() ? "Sending" : pending() ? "Retry sending" : "Send prompt"} disabled={sending() || !reading() || (!pending() && !text().trim())}>{sending() ? "Sending…" : pending() ? "Retry" : "Send"}</button>
        <Show when={pending() && !sending()}><button type="button" onClick={() => { update(pending()?.text ?? ""); hold(undefined); setError(undefined) }}>Edit as a new message</button></Show>
        <Show when={running()}><button type="button" disabled={stopping() || !reading()} onClick={() => void stop()}>{stopping() ? "Stopping…" : "Stop"}</button></Show>
        <Show when={stopNote()}>{(note) => <span role="status" class="desktop__muted">{note()}</span>}</Show></div>
    </form>
  </section>
}

const root = createRootRoute({ component: App })
const connectionRoute = createRoute({ getParentRoute: () => root, path: "/", component: Connection })
const sessionsRoute = createRoute({ getParentRoute: () => root, path: "/sessions", component: Workspace })
const newChatRoute = createRoute({ getParentRoute: () => sessionsRoute, path: "/", component: NewChat })
const conversationRoute = createRoute({ getParentRoute: () => sessionsRoute, path: "$sessionID", component: () => {
  const params = conversationRoute.useParams()
  return <Show when={params().sessionID} keyed>{(sessionID) => <Conversation sessionID={sessionID} />}</Show>
} })
const router = createRouter({ routeTree: root.addChildren([connectionRoute, sessionsRoute.addChildren([newChatRoute, conversationRoute])]), history: createHashHistory() })
const element = document.getElementById("app")
if (!element) throw new Error("Missing desktop application root")
render(() => <RouterProvider router={router} />, element)
