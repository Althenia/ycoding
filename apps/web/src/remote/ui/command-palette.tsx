import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "../../ui/icon"
import { Modal } from "../../ui/modal"
import { useTheme } from "../../theme/theme-store"
import { catalogKey, type CatalogTarget } from "../catalog"
import { useRemote } from "../context"
import { workspaceLabels } from "../view-model"
import {
  filterPaletteActions,
  paletteActions,
  paletteSections,
  type PaletteAction,
  type PaletteContext,
  type PaletteIntent,
} from "./command-palette-model"
import { noticeCenterView } from "./notifications"
import { connectionStripView, type RemoteView } from "./shell-model"
import "./command-palette.css"

const sessionLimit = 25
const maxFocusFrames = 30

export type PaletteHandlers = {
  readonly go: (view: "new" | "sessions" | "session" | "usage" | "settings") => void
  readonly openSession: (sessionID: string) => void
  readonly openTeam: () => void
  readonly draft: (text: string) => void
  readonly selectModel: () => void
  readonly connectProvider: (target: CatalogTarget, returnFocus: HTMLElement) => void
}

/**
 * The header control and modal that list every action available in the current view.
 * Ctrl or Cmd+K opens it anywhere; Ctrl+P opens it outside text fields, where macOS binds it
 * to cursor movement. Cmd+P stays the browser's print shortcut. Actions that
 * need text (a goal, a configured command's arguments) fill the composer draft and focus
 * it instead of asking for the text inside the palette.
 */
export function CommandPalette(props: {
  readonly view: RemoteView
  readonly canCreateSession: boolean
  readonly sessionSelected: boolean
  readonly managedChild: boolean
  readonly hasTeam: boolean
  readonly workspaceID?: string
  readonly handlers: PaletteHandlers
}): JSX.Element {
  const remote = useRemote()
  const theme = useTheme()
  const [open, setOpen] = createSignal(false)
  const [closing, setClosing] = createSignal(false)
  const [generation, setGeneration] = createSignal(1)
  let trigger: HTMLButtonElement | undefined
  let opener: HTMLElement | undefined
  let requestClose: (() => void) | undefined

  const target = (): CatalogTarget | undefined => props.view === "/remote"
    ? props.workspaceID === undefined ? undefined : { workspaceID: props.workspaceID }
    : props.sessionSelected && remote.state().activeSessionID !== undefined ? { sessionID: remote.state().activeSessionID! } : undefined

  const context = createMemo((): PaletteContext => {
    const state = remote.state()
    const connected = state.connection.kind === "connected" && state.transport.kind === "open"
    const sessionID = props.sessionSelected ? state.activeSessionID : undefined
    const catalog = sessionID === undefined ? undefined : state.catalogs[catalogKey({ sessionID })]
    const ready = catalog?.status === "ready" ? catalog : undefined
    const labels = workspaceLabels(state.sessionGroups)
    return {
      view: props.view,
      connected,
      canCreateSession: props.canCreateSession,
      canSelectModel: target() !== undefined && state.catalogs[catalogKey(target()!)]?.status === "ready" && (props.view === "/remote" || props.view === "/remote/session"),
      canConnectProvider: target() !== undefined,
      session: sessionID === undefined ? undefined : {
        id: sessionID,
        running: state.view?.id === sessionID && state.view.status === "running",
        managedChild: props.managedChild,
        yolo: state.view?.id === sessionID ? state.view.autonomy?.yolo ?? 0 : 0,
        goalActive: state.view?.id === sessionID && state.view.autonomy?.goal?.status === "active",
      },
      commands: ready?.commands ?? [],
      skills: ready?.skills.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description })) ?? [],
      sessions: state.sessions
        .filter((session) => session.parentID === undefined)
        .slice(0, sessionLimit)
        .map((session) => ({ id: session.id, title: session.title, running: session.running, archived: session.archived })),
      devices: state.devices
        .filter((device) => device.status === "active")
        .map((device) => ({ id: device.id, name: device.name, online: device.online, active: device.id === state.activeDeviceID })),
      activeDeviceID: state.activeDeviceID,
      workspaces: state.sessionGroups.map((group) => ({ id: group.id, label: labels.get(group.id) ?? group.name ?? group.directory })),
      selectedWorkspaceID: state.selectedWorkspaceID,
      theme: theme.preference(),
      scheme: theme.scheme(),
      unreadNotifications: noticeCenterView(state.noticeSync, state.notifications).unread,
      canReconnect: connectionStripView({
        connection: state.connection,
        transportKind: state.transport.kind,
        activeDeviceID: state.activeDeviceID,
        advertised: state.advertised.length,
        lastRelayDrop: state.lastRelayDrop,
      })?.showReconnect === true,
      hasTeam: props.hasTeam,
      signedIn: state.owner !== undefined,
    }
  })
  const actions = createMemo(() => paletteActions(context()))

  const openPalette = () => {
    const active = document.activeElement
    opener = active instanceof HTMLElement && active !== document.body && active.isConnected ? active : trigger
    if (closing()) setGeneration((current) => current + 1)
    setOpen(true)
    setClosing(false)
  }

  const ownsShortcut = () => document.querySelector("dialog[open]") === null
  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    const key = event.key.toLowerCase()
    const plain = !event.altKey && !event.shiftKey
    const opens = (key === "k" && (event.metaKey || event.ctrlKey) && plain) ||
      (key === "p" && event.ctrlKey && !event.metaKey && plain && !typingTarget(event.target))
    if (!opens) return
    if (open()) {
      event.preventDefault()
      requestClose?.()
      return
    }
    if (!ownsShortcut()) return
    event.preventDefault()
    openPalette()
  }
  window.addEventListener("keydown", keydown)
  onCleanup(() => window.removeEventListener("keydown", keydown))

  const run = (intent: PaletteIntent) => {
    switch (intent.type) {
      case "compact": void remote.store.compactSession(); return
      case "interrupt": void remote.store.interrupt(); return
      case "stopGoal": void remote.store.stopGoal(); return
      case "yolo": void remote.store.setYolo(intent.level); return
      case "skill": void remote.store.activateSkill(intent.skill); return
      case "draft": props.handlers.draft(intent.text); return
      case "go": props.handlers.go(intent.view); return
      case "openSession": props.handlers.openSession(intent.sessionID); return
      case "team": props.handlers.openTeam(); return
      case "device": remote.store.connect(intent.deviceID); return
      case "workspace": remote.store.selectWorkspace(intent.workspaceID); return
      case "theme": theme.setPreference(intent.preference); return
      case "scheme": theme.setScheme(intent.scheme); return
      case "readNotifications": void remote.store.readAllNotifications(); return
      case "model": props.handlers.selectModel(); return
      case "connectProvider": {
        const current = target()
        if (current && trigger) props.handlers.connectProvider(current, trigger)
        return
      }
      case "reconnect": {
        const deviceID = remote.state().activeDeviceID
        if (deviceID !== undefined) remote.store.connect(deviceID)
        return
      }
      case "signOut": void remote.store.logout(); return
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="button button--ghost button--icon app-header__palette"
        aria-label="Open command palette"
        title="Command palette (Ctrl+K)"
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-keyshortcuts="Control+K Meta+K Control+P"
        onClick={openPalette}
      >
        <Icon name="search" />
      </button>
      <Show when={open() || closing()}>
        <Show when={generation()} keyed>{(current) => (
          <Portal>
          <Modal
            class="overlay--dialog overlay--command-palette"
            label="Command palette"
            returnFocus={opener ?? trigger!}
            requestClose={(close) => { requestClose = close }}
            onDismiss={() => { setClosing(true); setOpen(false) }}
            onClose={() => { if (generation() === current) setClosing(false) }}
          >
            <PaletteBody view={props.view} actions={actions()} onRun={(action) => { requestClose?.(); run(action.intent) }} />
          </Modal>
          </Portal>
        )}</Show>
      </Show>
    </>
  )
}

function PaletteBody(props: {
  readonly view: RemoteView
  readonly actions: readonly PaletteAction[]
  readonly onRun: (action: PaletteAction) => void
}): JSX.Element {
  const [query, setQuery] = createSignal("")
  const [activeID, setActiveID] = createSignal<string>()
  const ranked = () => query().trim().length > 0
  const results = createMemo(() => filterPaletteActions(props.actions, query()))
  const sections = createMemo(() => paletteSections(results(), props.view, ranked()))
  const flat = createMemo(() => sections().flatMap((section) => section.actions))
  const optionId = (action: PaletteAction) => `command-palette-option-${action.id}`
  const activeAction = () => flat().find((action) => action.id === activeID())
  const activePosition = () => Math.max(flat().findIndex((action) => action.id === activeID()), 0)
  let previousActions = props.actions
  let scrollAnchor: { readonly id: string; readonly top: number } | undefined
  let list: HTMLDivElement | undefined

  const rememberScrollAnchor = () => {
    if (!list) return
    const top = list.getBoundingClientRect().top
    const anchor = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find((row) => row.getBoundingClientRect().bottom > top)
    if (anchor) scrollAnchor = { id: anchor.id, top: anchor.getBoundingClientRect().top }
  }

  onMount(rememberScrollAnchor)

  createEffect(() => {
    if (!flat().some((action) => action.id === activeID())) setActiveID(flat()[0]?.id)
  })

  onMount(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    const sync = () => {
      root.style.setProperty("--command-palette-top", `${viewport.offsetTop}px`)
      root.style.setProperty("--command-palette-height", `${viewport.height}px`)
    }
    sync()
    viewport.addEventListener("resize", sync)
    viewport.addEventListener("scroll", sync)
    onCleanup(() => {
      viewport.removeEventListener("resize", sync)
      viewport.removeEventListener("scroll", sync)
      root.style.removeProperty("--command-palette-top")
      root.style.removeProperty("--command-palette-height")
    })
  })

  createEffect(() => {
    const actions = props.actions
    if (actions === previousActions) return
    previousActions = actions
    const previousAnchor = scrollAnchor
    const anchor = previousAnchor && document.getElementById(previousAnchor.id)
    if (list && previousAnchor && anchor) list.scrollTop += anchor.getBoundingClientRect().top - previousAnchor.top
    rememberScrollAnchor()
  })

  const move = (next: number) => {
    const action = flat()[Math.max(0, Math.min(next, flat().length - 1))]
    if (!action) return
    setActiveID(action.id)
    list?.querySelector<HTMLElement>(`[id="${optionId(action)}"]`)?.scrollIntoView({ block: "nearest" })
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); move(activePosition() + 1); return }
    if (event.key === "ArrowUp") { event.preventDefault(); move(activePosition() - 1); return }
    if (event.key === "Home") { event.preventDefault(); move(0); return }
    if (event.key === "End") { event.preventDefault(); move(flat().length - 1); return }
    if (event.key !== "Enter" || event.isComposing) return
    const action = activeAction()
    if (!action) return
    event.preventDefault()
    props.onRun(action)
  }

  return (
    <div class="command-palette">
      <label class="command-palette__search" for="command-palette-input">
        <span class="visually-hidden">Search actions</span>
        <Icon name="search" size={16} />
        <input
          id="command-palette-input"
          class="command-palette__input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-controls="command-palette-list"
          aria-activedescendant={activeAction() ? optionId(activeAction()!) : undefined}
          placeholder="Search actions or type a /command"
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
          enterkeyhint="go"
          autofocus
          value={query()}
          onInput={(event) => { setQuery(event.currentTarget.value); setActiveID(results()[0]?.id); if (list) list.scrollTop = 0 }}
          onKeyDown={keydown}
        />
      </label>
      <p class="visually-hidden" role="status">{flat().length === 0 ? "No matching action" : `${flat().length} ${flat().length === 1 ? "action" : "actions"}`}</p>
      <div ref={list} id="command-palette-list" class="command-palette__list" role="listbox" aria-label="Actions" tabindex="-1" onScroll={rememberScrollAnchor}>
        <Show when={flat().length > 0} fallback={<p class="command-palette__empty">{props.actions.length === 0 ? "No actions are available." : "No matching action."}</p>}>
          <For each={sections().map((section) => section.group ?? "Results")}>{(group) => {
            const section = () => sections().find((item) => (item.group ?? "Results") === group)
            return (
            <div class="command-palette__group" role="group" aria-labelledby={group === "Results" ? undefined : `command-palette-group-${group}`} aria-label={group === "Results" ? "Results" : undefined}>
              <Show when={group !== "Results"}><div id={`command-palette-group-${group}`} class="command-palette__heading">{group}</div></Show>
              <For each={section()?.actions.map((action) => action.id) ?? []}>{(id) => {
                const action = () => flat().find((item) => item.id === id)
                return (
                <div
                  id={`command-palette-option-${id}`}
                  role="option"
                  aria-selected={activeID() === id}
                  class="command-palette__option"
                  data-active={activeID() === id ? "" : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerMove={() => { if (activeID() !== id) setActiveID(id) }}
                  onClick={() => { const current = action(); if (current) props.onRun(current) }}
                >
                  <span class="command-palette__title">{action()?.title}</span>
                  <Show when={action()?.description}>{(description) => <span class="command-palette__description">{description()}</span>}</Show>
                  <Show when={section()?.group === undefined}><span class="command-palette__group-tag">{action()?.group}</span></Show>
                </div>
                )
              }}</For>
            </div>
            )
          }}</For>
        </Show>
      </div>
    </div>
  )
}

function typingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
}

/**
 * Focuses the composer field once its route panel is interactive. Navigation to the
 * conversation mounts the panel a frame or two later, so the lookup retries briefly.
 */
export function focusComposerField(frame = 0): void {
  const field = document.querySelector<HTMLTextAreaElement>(".composer-resident:not([inert]) .composer__input")
  if (field && !field.disabled) {
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
    return
  }
  if (frame < maxFocusFrames) requestAnimationFrame(() => focusComposerField(frame + 1))
}
