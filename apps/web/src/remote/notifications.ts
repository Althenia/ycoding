import { readNotificationPreferences, type NotificationCategory, type NotificationPreferences } from "./preferences"

/**
 * In-app and desktop alerts for live remote events.
 *
 * Alerts are derived from the events the relay forwards while a session is
 * subscribed. Snapshots, history reads, and reconnect reloads never raise one, so
 * reopening a workspace cannot replay alerts for work that already happened.
 */

export type RemoteNotificationView = {
  readonly id: string
  readonly category: NotificationCategory
  readonly title: string
  readonly body: string
  readonly at: number
}

/**
 * Fixed copy per category. A desktop alert can surface on a locked screen, so it
 * never carries a session title, tool name, path, command, or error message.
 */
export const NOTIFICATION_TEXT: Record<NotificationCategory, { readonly title: string; readonly body: string }> = {
  "agent-completed": { title: "YCoding — work finished", body: "The active session finished its work." },
  "approval-requested": { title: "YCoding — approval needed", body: "A session is waiting for your decision." },
  "guardrail-blocked": { title: "YCoding — guardrail review", body: "A guardrail review or denial stopped an action." },
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
    case "session.execution.succeeded":
      return "agent-completed"
    case "session.execution.failed":
    case "session.step.failed":
      return "error"
    case "permission.v2.asked":
    case "form.created":
      return "approval-requested"
    case "guardrail.asked":
      return "guardrail-blocked"
    case "guardrail.decided":
      return isRecord(payload.data) && isBlockingDecision(payload.data.decision) ? "guardrail-blocked" : undefined
    default:
      return undefined
  }
}

export type DesktopAlert = { readonly title: string; readonly body: string; readonly tag: string }

export type DesktopNotifier = {
  readonly show: (alert: DesktopAlert) => void
  readonly dispose: () => void
}

/**
 * Wraps the browser notification API. It never requests permission: the settings
 * page asks explicitly, and an ungranted or unavailable browser stays silent.
 */
export function createDesktopNotifier(): DesktopNotifier {
  const open = new Map<string, Notification>()
  const release = (tag: string, notification: Notification) => {
    if (open.get(tag) === notification) open.delete(tag)
    notification.onclose = null
    notification.onerror = null
  }
  return {
    show: (alert) => {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return
      // One alert per category: the same tag replaces the previous one on screen.
      const previous = open.get(alert.tag)
      if (previous !== undefined) previous.close()
      try {
        const notification = new Notification(alert.title, { body: alert.body, tag: alert.tag })
        open.set(alert.tag, notification)
        notification.onclose = () => release(alert.tag, notification)
        notification.onerror = () => release(alert.tag, notification)
      } catch {
        // A browser that refuses to construct an alert must not break the event stream.
      }
    },
    dispose: () => {
      const closing = [...open]
      open.clear()
      for (const [, notification] of closing) {
        notification.onclose = null
        notification.onerror = null
        notification.close()
      }
    },
  }
}

export type NotificationDeliveryOptions = {
  readonly preferences?: () => NotificationPreferences
  readonly desktop?: DesktopNotifier
  readonly now?: () => number
}

export type NotificationDelivery = {
  readonly deliver: (category: NotificationCategory) => void
  readonly entries: () => readonly RemoteNotificationView[]
  readonly dismiss: (id: string) => void
  readonly dispose: () => void
}

export function createNotificationDelivery(options: NotificationDeliveryOptions = {}): NotificationDelivery {
  const preferences = options.preferences ?? (() => readNotificationPreferences())
  const desktop = options.desktop ?? createDesktopNotifier()
  const now = options.now ?? (() => Date.now())
  let entries: readonly RemoteNotificationView[] = []

  return {
    deliver: (category) => {
      const preference = preferences()[category]
      if (preference.desktop) desktop.show({ ...NOTIFICATION_TEXT[category], tag: `ycoding-remote-${category}` })
      if (!preference["in-app"]) return
      const text = NOTIFICATION_TEXT[category]
      // One notice per category bounds the in-app list at the configured categories.
      entries = [
        ...entries.filter((entry) => entry.category !== category),
        { id: category, category, title: text.title, body: text.body, at: now() },
      ]
    },
    entries: () => entries,
    dismiss: (id) => {
      entries = entries.filter((entry) => entry.id !== id)
    },
    dispose: () => {
      desktop.dispose()
      entries = []
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
