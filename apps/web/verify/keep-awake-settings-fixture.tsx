import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { RemoteProvider } from "../src/remote/context"
import type { RemoteHttp } from "../src/remote/http"
import type { KeepAwakeStatus } from "../src/remote/keep-awake"
import { createRemoteStore } from "../src/remote/store"
import type { RemoteRequestOutcome, RemoteTransportHandlers, RemoteTransportRequest } from "../src/remote/transport"
import { MachineSettings } from "../src/remote/ui/settings"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light"
const [visible, setVisible] = createSignal(true)
const calls: { readonly operation: string; readonly deviceID: string; readonly request?: RemoteTransportRequest }[] = []
const heldReads: ((outcome: RemoteRequestOutcome) => void)[] = []
const heldSets: ((outcome: RemoteRequestOutcome) => void)[] = []
let currentHandlers: RemoteTransportHandlers | undefined
let readMode = params.get("read") ?? "off"
let mutationMode = "held"
const status = (state: KeepAwakeStatus["state"], message?: string): RemoteRequestOutcome => ({
  status: "ok",
  value: { data: { state, ...(message === undefined ? {} : { message }) } },
})
const answer = (mode: string): RemoteRequestOutcome => {
  if (mode === "old") return { status: "failed", error: { code: "unknown_operation", message: "Unknown operation" } }
  if (mode === "silent")
    return { status: "unknown", error: { code: "outcome_unknown", message: "The machine did not answer." } }
  if (mode === "failed")
    return { status: "failed", error: { code: "internal_error", message: "Machine request failed" } }
  if (mode === "unsupported") return status("unsupported", "Keep machine awake is supported only on macOS.")
  if (mode === "error") return status("error", "The idle-sleep assertion ended unexpectedly.")
  return status(mode === "on" ? "on" : "off")
}
const devices = [
  { id: "dev_mac", name: "Studio Mac", createdAt: 1, status: "active" as const, online: true },
  { id: "dev_laptop", name: "Laptop", createdAt: 2, status: "active" as const, online: true },
]
const http: RemoteHttp = {
  me: async () => ({
    ok: true,
    value: { user: { id: "user_fixture" }, session: { expiresAt: Date.now() + 60_000 }, devices },
  }),
  devices: async () => ({ ok: true, value: devices }),
  createEnrollment: async () => ({ ok: false, status: 503, message: "Not available in this fixture", kind: "http" }),
  revokeDevice: async () => ({ ok: true, value: undefined }),
  removeRevokedDevices: async () => ({ ok: true, value: undefined }),
  logout: async () => ({ ok: true, value: undefined }),
}
const store = createRemoteStore({
  http,
  createTransport: (deviceID, handlers) => {
    currentHandlers = handlers
    return {
      connect: () => handlers.onStatus?.({ kind: "open" }),
      close: () => {},
      setPriority: () => {},
      status: () => ({ kind: "open" }),
      request: async (operation, request) => {
        calls.push({ operation, deviceID, request })
        if (operation === "machine.keepAwake.get")
          return readMode === "held"
            ? new Promise<RemoteRequestOutcome>((resolve) => heldReads.push(resolve))
            : answer(readMode)
        if (operation === "machine.keepAwake.set")
          return mutationMode === "held"
            ? new Promise<RemoteRequestOutcome>((resolve) => heldSets.push(resolve))
            : answer(mutationMode)
        return { status: "ok", value: { data: [] } }
      },
    }
  },
})

Object.assign(window, {
  keepAwakeFixture: {
    calls,
    store,
    show: (value: boolean) => setVisible(value),
    read: (mode: string) => {
      readMode = mode
    },
    mutation: (mode: string) => {
      mutationMode = mode
    },
    releaseRead: (mode: string) => heldReads.shift()?.(answer(mode)),
    releaseSet: (mode: string) => heldSets.shift()?.(answer(mode)),
    drop: () => {
      for (const settle of [...heldReads.splice(0), ...heldSets.splice(0)]) settle(answer("silent"))
      currentHandlers?.onStatus?.({ kind: "closed", code: 1006, reason: "Fixture connection lost", retryable: true })
    },
    reconnect: () => currentHandlers?.onStatus?.({ kind: "open" }),
  },
})

store.connect("dev_mac")
const root = document.getElementById("app")
if (!root) throw new Error("Missing keep awake fixture root")
render(
  () => (
    <RemoteProvider createStore={() => store}>
      <main class="pane settings">
        <Show when={visible()}>
          <MachineSettings />
        </Show>
        <p id="following-settings">Following settings remain in place.</p>
      </main>
    </RemoteProvider>
  ),
  root,
)
