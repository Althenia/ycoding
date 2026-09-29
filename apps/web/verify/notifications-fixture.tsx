import { render } from "solid-js/web"
import { createRemoteHttp } from "../src/remote/http"
import { RemoteProvider } from "../src/remote/context"
import { createRemoteStore, type RemoteStore, type RemoteStoreState } from "../src/remote/store"
import type { RemoteNotificationView } from "../src/remote/notifications"
import { NotificationCenter, ToastLayer } from "../src/remote/ui/notifications"
import "../src/styles/tokens.css"
import "../src/styles/base.css"

const parameters = new URLSearchParams(location.search)
document.documentElement.dataset.theme = parameters.get("theme") === "dark" ? "dark" : "light"

const baseline = (id: string, category: RemoteNotificationView["category"], at: number, sessionID: string, titled = true): RemoteNotificationView => ({
  id, category, at, sessionID, ...(titled ? { sessionTitle: sessionID === "ses_alpha" ? "Alpha Session" : "Beta Session" } : {}), read: false,
  title: "YCoding notice", body: "An action needs attention.",
})
const initial = parameters.get("initial") === "empty" ? [] : [
  baseline("notice_initial_2", "approval-requested", Date.now(), "ses_beta"),
  baseline("notice_initial_1", "agent-completed", Date.now() - 120_000, "ses_alpha"),
]
const base = createRemoteStore({ http: createRemoteHttp(), createTransport: () => { throw new Error("Fixture does not connect") } })
let state: RemoteStoreState = { ...base.state(), notifications: initial }
let serial = 0
const opened: string[] = []
const subscribers = new Set<() => void>()
const publish = (notifications: readonly RemoteNotificationView[]) => {
  state = { ...state, notifications }
  for (const subscriber of subscribers) subscriber()
}
const store: RemoteStore = {
  ...base,
  state: () => state,
  subscribe: (listener) => { subscribers.add(listener); return () => subscribers.delete(listener) },
  load: async () => {},
  markNotificationsRead: () => publish(state.notifications.map((entry) => ({ ...entry, read: true }))),
  clearNotifications: () => publish([]),
  dismissNotification: (id) => publish(state.notifications.filter((entry) => entry.id !== id)),
}
Object.assign(window, {
  remoteNotify: (category: RemoteNotificationView["category"] = "approval-requested", sessionID = "ses_alpha", titled = true) => {
    const entry = baseline(`notice_live_${++serial}`, category, Date.now(), sessionID, titled)
    publish([entry, ...state.notifications].slice(0, 50))
  },
  remoteResolveTitle: (sessionID: string, title: string) => publish(state.notifications.map((entry) => entry.sessionID === sessionID ? { ...entry, sessionTitle: title } : entry)),
  remoteOpened: () => opened.slice(),
})
const root = document.getElementById("app")
if (!root) throw new Error("Missing notifications fixture root")
render(() => <RemoteProvider createStore={() => store}>
  <main style={{ "min-height": "100dvh", background: "var(--yc-bg)", color: "var(--yc-text)" }}>
    <header data-toast-clearance style={{ display: "flex", "align-items": "center", "justify-content": "space-between", height: "var(--yc-header-h)", padding: "0 var(--yc-gutter)", "border-bottom": "1px solid var(--yc-border)", background: "var(--yc-surface-raised)" }}>
      <strong>YCoding</strong>
      <NotificationCenter onOpenSession={(id) => opened.push(id)} />
    </header>
    <p style={{ padding: "var(--yc-space-6) var(--yc-gutter)" }}>Conversation workspace</p>
    <ToastLayer sessionID={undefined} onOpenSession={(id) => opened.push(id)} />
  </main>
</RemoteProvider>, root)
