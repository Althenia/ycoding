import { noticeSequence, type RemoteNoticePresentation } from "@ycoding-ai/remote"
import { alertCopy, type AlertNotice } from "./alert"
import { readNotificationPreferences, type NotificationCategory, type NotificationPreferences } from "./preferences"

export type RemoteNotificationView = {
  readonly id: string
  readonly category: NotificationCategory
  readonly title: string
  readonly body: string
  readonly at: number
  readonly sessionID?: string
  readonly sessionTitle?: string
  readonly synced: boolean
  readonly live: boolean
}

export const NOTICE_WINDOW = 200
const LOCAL_LIMIT = 50

export type SyncedNotice = {
  readonly id: string
  readonly category: NotificationCategory
  readonly at: number
  readonly sessionID: string
  readonly sessionTitle?: string
}

/**
 * Fixed in-app copy per category. System alerts for relay notices use `alertCopy`,
 * which adds the Session title and what the Session needs.
 */
export const NOTIFICATION_TEXT: Record<NotificationCategory, { readonly title: string; readonly body: string }> = {
  "agent-completed": { title: "YCoding — work finished", body: "A session finished all its work." },
  "approval-requested": { title: "YCoding — needs your attention", body: "A session is waiting for you." },
  "machine-offline": { title: "YCoding — machine offline", body: "The connected machine stopped reporting." },
}

/**
 * Category of one live event payload, or `undefined` when it is not worth an
 * alert. Durable and ephemeral payloads are read the same way, because the relay
 * forwards both.
 */
export function notificationCategory(payload: unknown): NotificationCategory | undefined {
  if (!isRecord(payload) || !isRecord(payload.data)) return undefined
  const type = stringField(payload.type)
  if (type === undefined) return undefined
  switch (type) {
    case "guardrail.decided":
      return isBlockingDecision(payload.data.decision) ? "approval-requested" : undefined
    default:
      return undefined
  }
}

export type DesktopAlert = { readonly title: string; readonly body: string; readonly tag: string; readonly sessionID?: string; readonly notice?: AlertNotice; readonly renotify?: true }

export type DesktopNotifier = {
  readonly show: (alert: DesktopAlert) => void
  readonly dispose: (retainMachineOffline?: boolean) => void
}

export type DesktopRegistration = {
  readonly showNotification: (title: string, options?: NotificationOptions & { readonly renotify?: boolean }) => Promise<void>
  readonly getNotifications: () => Promise<readonly { readonly tag: string; close: () => void }[]>
}

/**
 * Shows alerts through the service worker registration, the notification path that
 * installed phone apps support too, so the worker's click handler opens the Session.
 * It never requests permission: the settings page asks explicitly, and an ungranted
 * browser or a page without a registered worker stays silent.
 */
export function createDesktopNotifier(registration: () => Promise<DesktopRegistration | undefined> = workerRegistration): DesktopNotifier {
  const raised = new Set<string>()
  return {
    show: (alert) => {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return
      raised.add(alert.tag)
      void registration().then((worker) => worker?.showNotification(alert.title, {
        body: alert.body, tag: alert.tag, ...(alert.renotify ? { renotify: true } : {}), icon: "/icons/icon-256.png", badge: "/icons/icon-256.png",
        ...(alert.sessionID === undefined ? {} : { data: { sessionID: alert.sessionID, ...alert.notice } }),
      })).catch(() => undefined)
    },
    dispose: (retainMachineOffline = false) => {
      const tags = new Set([...raised].filter((tag) => !retainMachineOffline || !/-offline-\d+$/.test(tag)))
      for (const tag of tags) raised.delete(tag)
      if (tags.size === 0) return
      void registration().then((worker) => worker?.getNotifications()).then((open) => {
        for (const notification of open ?? []) if (tags.has(notification.tag)) notification.close()
      }).catch(() => undefined)
    },
  }
}

async function workerRegistration(): Promise<DesktopRegistration | undefined> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined
  const registration = await navigator.serviceWorker.getRegistration()
  if (registration?.active) return registration
  if (!registration) await navigator.serviceWorker.register("/sw.js", { type: "module" })
  return navigator.serviceWorker.ready
}

export type NotificationDeliveryOptions = {
  readonly preferences?: () => NotificationPreferences
  readonly desktop?: DesktopNotifier
  readonly now?: () => number
}

export type NotificationDelivery = {
  readonly deliver: (category: NotificationCategory, context?: { readonly sessionID?: string; readonly sessionTitle?: string }) => void
  readonly receive: (notice: SyncedNotice, deviceID: string) => void
  readonly offline: (deviceID: string, at: number) => void
  readonly present: (items: readonly RemoteNoticePresentation[], deviceID: string) => void
  readonly replaceSynced: (notices: readonly SyncedNotice[]) => void
  readonly appendSynced: (notices: readonly SyncedNotice[]) => void
  readonly entries: () => readonly RemoteNotificationView[]
  readonly syncedLoaded: () => number
  readonly syncedHidden: () => number
  readonly oldestSynced: () => string | undefined
  readonly setSessionTitle: (sessionID: string, title: string) => boolean
  readonly remove: (ids: readonly string[]) => void
  readonly clearSynced: () => void
  readonly dispose: (retainMachineOffline?: boolean, closeSystemAlerts?: boolean) => void
}

export function createNotificationDelivery(options: NotificationDeliveryOptions = {}): NotificationDelivery {
  const preferences = options.preferences ?? (() => readNotificationPreferences())
  const desktop = options.desktop ?? createDesktopNotifier()
  const now = options.now ?? (() => Date.now())
  let entries: readonly RemoteNotificationView[] = []
  let hidden = new Set<string>()
  let nextID = 0

  const alert = (category: NotificationCategory, sessionID?: string, tag = sessionID === undefined ? `ycoding-remote-${category}` : `ycoding-${sessionID}-${category}`) => {
    if (!preferences()[category].desktop) return
    desktop.show({ ...NOTIFICATION_TEXT[category], tag, ...(sessionID === undefined ? {} : { sessionID }) })
  }
  const view = (notice: { readonly id: string; readonly category: NotificationCategory; readonly at: number; readonly sessionID?: string; readonly sessionTitle?: string }, synced: boolean, live: boolean): RemoteNotificationView => ({
    id: notice.id, category: notice.category, ...NOTIFICATION_TEXT[notice.category], at: notice.at, synced, live,
    ...(notice.sessionID === undefined ? {} : { sessionID: notice.sessionID }),
    ...(notice.sessionTitle === undefined ? {} : { sessionTitle: notice.sessionTitle }),
  })
  const listed = (category: NotificationCategory) => preferences()[category]["in-app"]
  const sequence = (id: string) => noticeSequence(id) ?? 0
  const newestFirst = (left: RemoteNotificationView, right: RemoteNotificationView) =>
    right.at - left.at || (left.synced && right.synced ? sequence(right.id) - sequence(left.id) : 0)
  const known = (id: string) => hidden.has(id) || entries.some((entry) => entry.id === id)
  const bounded = (next: readonly RemoteNotificationView[]) => {
    const ordered = [...next].sort(newestFirst)
    const local = ordered.filter((entry) => !entry.synced).slice(0, LOCAL_LIMIT)
    const synced = [...ordered.filter((entry) => entry.synced).map((entry) => entry.id), ...hidden].sort((left, right) => sequence(right) - sequence(left))
    const kept = new Set(synced.slice(0, NOTICE_WINDOW))
    hidden = new Set([...hidden].filter((id) => kept.has(id)))
    entries = [...local, ...ordered.filter((entry) => entry.synced && kept.has(entry.id))].sort(newestFirst)
  }
  const admit = (notice: SyncedNotice, live: boolean) => {
    if (known(notice.id)) return undefined
    if (!listed(notice.category)) {
      hidden.add(notice.id)
      return undefined
    }
    return view(notice, true, live)
  }

  return {
    deliver: (category, context) => {
      if (context?.sessionID !== undefined && entries.some((entry) => entry.synced && entry.sessionID === context.sessionID && entry.category === category)) return
      if (listed(category)) bounded([...entries, view({ id: `notice_${++nextID}`, category, at: now(), ...context }, false, true)])
    },
    offline: (deviceID, at) => {
      const id = `offline_${deviceID}_${at}`
      if (known(id)) return
      if (listed("machine-offline")) bounded([...entries, view({ id, category: "machine-offline", at }, false, true)])
    },
    present: (items, deviceID) => {
      for (const item of items) {
        if (item.kind === "offline") alert("machine-offline", undefined, `ycoding-${deviceID}-offline-${item.at}`)
        else if (preferences()[item.notice.category].desktop)
          desktop.show({ ...alertCopy(item.notice.category, item.detail), tag: `ycoding-${deviceID}-${item.notice.id}`,
            sessionID: item.notice.sessionID, notice: { deviceID, noticeID: item.notice.id }, ...(item.detail?.repeat ? { renotify: true } : {}) })
      }
    },
    receive: (notice, deviceID) => {
      if (known(notice.id)) return
      const entry = admit(notice, true)
      const local = entries.filter((item) => item.synced || item.sessionID !== notice.sessionID || item.category !== notice.category)
      bounded(entry === undefined ? local : [...local, entry])
    },
    replaceSynced: (notices) => {
      hidden = new Set()
      entries = entries.filter((entry) => !entry.synced)
      const admitted = notices.flatMap((notice) => admit(notice, false) ?? [])
      bounded([...entries, ...admitted])
    },
    appendSynced: (notices) => {
      const admitted = notices.flatMap((notice) => admit(notice, false) ?? [])
      bounded([...entries, ...admitted])
    },
    entries: () => entries,
    syncedLoaded: () => entries.filter((entry) => entry.synced).length + hidden.size,
    syncedHidden: () => hidden.size,
    oldestSynced: () => [...entries.filter((entry) => entry.synced).map((entry) => entry.id), ...hidden]
      .reduce<string | undefined>((oldest, id) => (oldest === undefined || sequence(id) < sequence(oldest) ? id : oldest), undefined),
    setSessionTitle: (sessionID, title) => {
      if (!entries.some((entry) => entry.sessionID === sessionID && entry.sessionTitle === undefined)) return false
      entries = entries.map((entry) => entry.sessionID === sessionID && entry.sessionTitle === undefined ? { ...entry, sessionTitle: title } : entry)
      return true
    },
    remove: (ids) => {
      entries = entries.filter((entry) => !ids.includes(entry.id))
      hidden = new Set([...hidden].filter((id) => !ids.includes(id)))
    },
    clearSynced: () => {
      entries = entries.filter((entry) => !entry.synced)
      hidden = new Set()
    },
    dispose: (retainMachineOffline = false, closeSystemAlerts = true) => {
      if (closeSystemAlerts) desktop.dispose(retainMachineOffline)
      entries = retainMachineOffline ? entries.filter((entry) => entry.category === "machine-offline") : []
      hidden = new Set()
    },
  }
}

function isBlockingDecision(value: unknown): boolean {
  return value === "deny" || value === "cap_exceeded"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
