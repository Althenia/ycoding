import { readNotificationPreferences, type NotificationCategory, type NotificationPreferences } from "./preferences"

export type RemoteNotificationView = {
  readonly id: string
  readonly category: NotificationCategory
  readonly title: string
  readonly body: string
  readonly at: number
  readonly sessionID?: string
  readonly sessionTitle?: string
  readonly read: boolean
}

/**
 * Fixed copy per category. A desktop alert can surface on a locked screen, so it
 * never carries a session title, tool name, path, command, or error message.
 */
export const NOTIFICATION_TEXT: Record<NotificationCategory, { readonly title: string; readonly body: string }> = {
  "agent-completed": { title: "YCoding — work stopped", body: "A session stopped running." },
  "approval-requested": { title: "YCoding — approval needed", body: "A session is waiting for your decision." },
  "guardrail-blocked": { title: "YCoding — guardrail blocked", body: "A guardrail decision blocked an action." },
  error: { title: "YCoding — session failure", body: "A session step failed." },
  "device-disconnected": { title: "YCoding — device disconnected", body: "The connected machine stopped reporting." },
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
    case "session.execution.failed":
    case "session.step.failed":
      return "error"
    case "guardrail.decided":
      return isRecord(payload.data) && isBlockingDecision(payload.data.decision) ? "guardrail-blocked" : undefined
    default:
      return undefined
  }
}

export type DesktopAlert = { readonly title: string; readonly body: string; readonly tag: string; readonly sessionID?: string }

export type DesktopNotifier = {
  readonly show: (alert: DesktopAlert) => void
  readonly dispose: (retainMachineOffline?: boolean) => void
}

export type DesktopRegistration = {
  readonly showNotification: (title: string, options?: NotificationOptions) => Promise<void>
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
        body: alert.body, tag: alert.tag, icon: "/icons/icon-256.png", badge: "/icons/icon-256.png",
        ...(alert.sessionID === undefined ? {} : { data: { sessionID: alert.sessionID } }),
      })).catch(() => undefined)
    },
    dispose: (retainMachineOffline = false) => {
      const tags = new Set([...raised].filter((tag) => !retainMachineOffline || tag !== "ycoding-remote-device-disconnected"))
      for (const tag of tags) raised.delete(tag)
      if (tags.size === 0) return
      void registration().then((worker) => worker?.getNotifications()).then((open) => {
        for (const notification of open ?? []) if (tags.has(notification.tag)) notification.close()
      }).catch(() => undefined)
    },
  }
}

function workerRegistration(): Promise<DesktopRegistration | undefined> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(undefined)
  return navigator.serviceWorker.getRegistration()
}

export type NotificationDeliveryOptions = {
  readonly preferences?: () => NotificationPreferences
  readonly desktop?: DesktopNotifier
  readonly now?: () => number
}

export type NotificationDelivery = {
  readonly deliver: (category: NotificationCategory, context?: { readonly sessionID?: string; readonly sessionTitle?: string }) => void
  readonly entries: () => readonly RemoteNotificationView[]
  readonly dismiss: (id: string) => void
  readonly markRead: () => void
  readonly clear: () => void
  readonly dispose: (retainMachineOffline?: boolean) => void
}

export function createNotificationDelivery(options: NotificationDeliveryOptions = {}): NotificationDelivery {
  const preferences = options.preferences ?? (() => readNotificationPreferences())
  const desktop = options.desktop ?? createDesktopNotifier()
  const now = options.now ?? (() => Date.now())
  let entries: readonly RemoteNotificationView[] = []
  let nextID = 0

  return {
    deliver: (category, context) => {
      const preference = preferences()[category]
      if (preference.desktop) desktop.show({ ...NOTIFICATION_TEXT[category],
        ...(context?.sessionID === undefined
          ? { tag: `ycoding-remote-${category}` }
          : { tag: `ycoding-${context.sessionID}-${category}`, sessionID: context.sessionID }) })
      if (!preference["in-app"]) return
      const text = NOTIFICATION_TEXT[category]
      entries = [
        { id: `notice_${++nextID}`, category, title: text.title, body: text.body, at: now(), read: false,
          ...(context?.sessionID === undefined ? {} : { sessionID: context.sessionID }),
          ...(context?.sessionTitle === undefined ? {} : { sessionTitle: context.sessionTitle }) },
        ...entries,
      ].slice(0, 50)
    },
    entries: () => entries,
    dismiss: (id) => {
      entries = entries.filter((entry) => entry.id !== id)
    },
    markRead: () => { entries = entries.map((entry) => entry.read ? entry : { ...entry, read: true }) },
    clear: () => { entries = [] },
    dispose: (retainMachineOffline = false) => {
      desktop.dispose(retainMachineOffline)
      entries = retainMachineOffline ? entries.filter((entry) => entry.category === "device-disconnected") : []
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
