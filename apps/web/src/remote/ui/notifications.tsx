import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Icon, type IconName } from "../../ui/icon"
import { useRemote } from "../context"
import { createPushHttp } from "../http"
import { browserPushPlatform, syncPushState } from "../push"
import type { RemoteNotificationView } from "../notifications"
import type { NotificationCategory } from "../preferences"
import "./notifications.css"

const kinds: Record<NotificationCategory, { readonly icon: IconName; readonly label: string }> = {
  "agent-completed": { icon: "check", label: "Work finished" },
  "approval-requested": { icon: "shield", label: "Needs your attention" },
  "machine-offline": { icon: "devices", label: "Machine offline" },
}

export function notificationAge(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : new Date(at).toLocaleDateString()
}

export function groupNotifications(entries: readonly RemoteNotificationView[], now: number) {
  const today = new Date(now).toDateString()
  const yesterday = new Date(new Date(now).setHours(0, 0, 0, 0) - 1).toDateString()
  return entries.reduce<{ readonly label: string; readonly items: readonly RemoteNotificationView[] }[]>((groups, entry) => {
    const date = new Date(entry.at)
    const day = date.toDateString()
    const label = day === today ? "Today" : day === yesterday ? "Yesterday" : date.toLocaleDateString()
    const previous = groups.at(-1)
    if (previous?.label === label) groups[groups.length - 1] = { label, items: [...previous.items, entry] }
    else groups.push({ label, items: [entry] })
    return groups
  }, [])
}

export function newlyAddedNotifications(seen: ReadonlySet<string>, entries: readonly RemoteNotificationView[]) {
  return entries.filter((entry) => !seen.has(entry.id))
}

export function enqueueToasts(current: readonly RemoteNotificationView[], added: readonly RemoteNotificationView[]) {
  const IDs = new Set(added.map((entry) => entry.id))
  return [...added, ...current.filter((entry) => !IDs.has(entry.id))].slice(0, 3)
}

export function NotificationCenter(props: { readonly onOpenSession: (sessionID: string) => void }): JSX.Element {
  const remote = useRemote()
  const [open, setOpen] = createSignal(false)
  const [leaving, setLeaving] = createSignal(false)
  const [newCount, setNewCount] = createSignal(0)
  const [clock, setClock] = createSignal(Date.now())
  onMount(() => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return
    void syncPushState(browserPushPlatform(), createPushHttp())
  })
  const notifications = () => remote.state().notifications
  const unread = () => notifications().filter((entry) => !entry.read).length
  const groups = createMemo(() => groupNotifications(notifications(), clock()))
  let root: HTMLDivElement | undefined
  let trigger: HTMLButtonElement | undefined
  const close = (restore: boolean) => {
    setOpen(false)
    if (restore || (root?.querySelector(".yc-notification-panel")?.contains(document.activeElement) ?? false)) trigger?.focus()
    setLeaving(!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  }
  const finish = (event: AnimationEvent) => {
    if (event.target === event.currentTarget && event.animationName === "yc-notification-out" && leaving()) setLeaving(false)
  }
  const toggle = () => {
    if (open()) return close(false)
    setLeaving(false)
    setNewCount(unread())
    setClock(Date.now())
    setOpen(true)
    remote.store.markNotificationsRead()
  }
  const pointer = (event: PointerEvent) => {
    if (open() && event.target instanceof Node && !root?.contains(event.target)) close(false)
  }
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape" && open()) {
      event.stopPropagation()
      close(true)
    }
  }
  document.addEventListener("pointerdown", pointer)
  document.addEventListener("keydown", key)
  onCleanup(() => {
    document.removeEventListener("pointerdown", pointer)
    document.removeEventListener("keydown", key)
  })
  createEffect(() => {
    if (!open()) return
    const timer = setInterval(() => setClock(Date.now()), 60_000)
    onCleanup(() => clearInterval(timer))
  })
  const dismiss = (id: string, event: MouseEvent) => {
    const focused = document.activeElement === event.currentTarget
    const index = notifications().findIndex((entry) => entry.id === id)
    remote.store.dismissNotification(id)
    if (focused) queueMicrotask(() => {
      const controls = root?.querySelectorAll<HTMLButtonElement>(".yc-notification__dismiss")
      controls?.[Math.min(index, controls.length - 1)]?.focus()
      if (!controls?.length) trigger?.focus()
    })
  }
  return (
    <div class="yc-notification-center" ref={root}>
      <button ref={trigger} type="button" class="yc-notification-center__trigger" aria-label={unread() ? `Notifications, ${unread()} unread` : "Notifications"} aria-expanded={open()} aria-controls="yc-notification-panel" onClick={toggle}>
        <Icon name="bell" size={20} />
        <Show when={unread() > 0}><span class="yc-notification-center__badge" aria-hidden="true">{unread() > 9 ? "9+" : unread()}</span></Show>
      </button>
      <Show when={open() || leaving()}>
        <section id="yc-notification-panel" class="yc-notification-panel" classList={{ "yc-notification-panel--leaving": leaving() }} role="region" aria-label="Notifications" aria-hidden={leaving() ? "true" : undefined} inert={leaving()} onAnimationEnd={finish} onAnimationCancel={finish}>
          <header class="yc-notification-panel__head">
            <h2>Notifications</h2>
            <Show when={newCount() > 0}><span class="yc-notification-panel__new">{newCount()} new</span></Show>
            <span class="yc-notification-panel__spacer" />
            <Show when={notifications().length > 0}>
              <button type="button" class="yc-notification-panel__action" disabled={unread() === 0} onClick={() => remote.store.markNotificationsRead()}>Mark all read</button>
              <button type="button" class="yc-notification-panel__action" onClick={() => { remote.store.clearNotifications(); trigger?.focus() }}>Clear all</button>
            </Show>
          </header>
          <Show when={notifications().length > 0} fallback={<div class="yc-notification-panel__empty"><Icon name="check" size={22} /><strong>You're all caught up</strong><span>New activity will appear here.</span></div>}>
            <div class="yc-notification-panel__scroll">
              <For each={groups().map((group) => group.label)}>{(label) => {
                const entries = () => groups().find((group) => group.label === label)?.items ?? []
                return <section class="yc-notification-group" aria-label={label}>
                  <h3>{label}</h3>
                  <ul><For each={entries().map((entry) => entry.id)}>{(id) => {
                    const entry = () => entries().find((item) => item.id === id)
                    return <Show when={entry()}>{(item) => (
                      <li class={`yc-notification yc-notification--${item().category}${item().read ? " yc-notification--read" : ""}`}>
                        <span class="yc-notification__unread" aria-hidden={item().read} aria-label={item().read ? undefined : "Unread"} />
                        <span class="yc-notification__icon" aria-hidden="true"><Icon name={kinds[item().category].icon} size={16} /></span>
                        <button type="button" class="yc-notification__open" disabled={!item().sessionID} onClick={() => {
                          const sessionID = item().sessionID
                          if (!sessionID) return
                          close(false)
                          props.onOpenSession(sessionID)
                        }}>
                          <strong>{kinds[item().category].label}</strong>
                          <span>{item().sessionTitle ?? item().body}</span>
                        </button>
                        <time datetime={new Date(item().at).toISOString()}>{notificationAge(item().at, clock())}</time>
                        <button type="button" class="yc-notification__dismiss" aria-label={`Dismiss ${kinds[item().category].label}`} onClick={(event) => dismiss(id, event)}><Icon name="close" size={14} /></button>
                      </li>
                    )}</Show>
                  }}</For></ul>
                </section>
              }}</For>
            </div>
            <p class="yc-notification-panel__foot"><Icon name="check" size={14} /> You're all caught up</p>
          </Show>
        </section>
      </Show>
    </div>
  )
}

function Toast(props: { readonly notification: () => RemoteNotificationView; readonly onOpenSession: (id: string) => void; readonly onDismiss: (id: string) => void }): JSX.Element {
  const [paused, setPaused] = createSignal(false)
  const [leaving, setLeaving] = createSignal(false)
  let root: HTMLDivElement | undefined
  let remaining = 6_000
  let started = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let exitTimer: ReturnType<typeof setTimeout> | undefined
  const dismiss = () => {
    if (leaving()) return
    clearTimeout(timer)
    setLeaving(true)
    exitTimer = setTimeout(() => props.onDismiss(props.notification().id), 220)
  }
  const resume = () => {
    if (!paused() || leaving()) return
    setPaused(false)
    started = performance.now()
    timer = setTimeout(dismiss, Math.max(0, remaining))
  }
  const pause = () => {
    if (paused() || leaving()) return
    remaining -= performance.now() - started
    clearTimeout(timer)
    setPaused(true)
  }
  timer = setTimeout(dismiss, remaining)
  onCleanup(() => { clearTimeout(timer); clearTimeout(exitTimer) })
  return (
    <div ref={root} class={`yc-toast yc-toast--${props.notification().category}${paused() ? " yc-toast--paused" : ""}${leaving() ? " yc-toast--leaving" : ""}`} onMouseEnter={pause} onMouseLeave={() => { if (!root?.contains(document.activeElement)) resume() }} onFocusIn={pause} onFocusOut={(event) => { if (!(event.relatedTarget instanceof Node) || !root?.contains(event.relatedTarget)) resume() }}>
      <span class="yc-toast__icon" aria-hidden="true"><Icon name={kinds[props.notification().category].icon} size={18} /></span>
      <div class="yc-toast__body"><strong>{kinds[props.notification().category].label}</strong><span>{props.notification().sessionTitle ?? props.notification().body}</span></div>
      <Show when={props.notification().sessionID}><button type="button" class="yc-toast__open" onClick={() => { const sessionID = props.notification().sessionID; if (sessionID) props.onOpenSession(sessionID); dismiss() }}>Open</button></Show>
      <button type="button" class="yc-toast__close" aria-label={`Dismiss ${kinds[props.notification().category].label} toast`} onClick={dismiss}><Icon name="close" size={14} /></button>
      <span class="yc-toast__progress" aria-hidden="true" />
    </div>
  )
}

export function NotificationToasts(props: { readonly onOpenSession: (sessionID: string) => void }): JSX.Element {
  const remote = useRemote()
  const [queue, setQueue] = createSignal<readonly RemoteNotificationView[]>([])
  let seen = new Set(remote.state().notifications.map((entry) => entry.id))
  createEffect(() => {
    const entries = remote.state().notifications
    const added = newlyAddedNotifications(seen, entries)
    seen = new Set(entries.map((entry) => entry.id))
    setQueue((current) => {
      const next = added.length ? enqueueToasts(current, added) : current
      const updated = next.map((entry) => entries.find((item) => item.id === entry.id) ?? entry)
      return updated.every((entry, index) => entry === next[index]) ? next : updated
    })
  })
  return (
    <Show when={queue().length > 0}>
      <aside class="yc-toasts" role="status" aria-live="polite" aria-label="New notifications">
        <For each={queue().map((entry) => entry.id)}>{(id) => <Toast notification={() => remote.state().notifications.find((entry) => entry.id === id) ?? queue().find((entry) => entry.id === id)!} onOpenSession={props.onOpenSession} onDismiss={(dismissed) => setQueue((current) => current.filter((entry) => entry.id !== dismissed))} />}</For>
      </aside>
    </Show>
  )
}
