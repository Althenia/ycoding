import { render } from "solid-js/web"
import { Show, createSignal } from "solid-js"
import { RemoteProvider, useRemote } from "../src/remote/context"
import type { RemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { Composer, MiniComposer } from "../src/remote/ui/composer"
import { ToastLayer } from "../src/remote/ui/notifications"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"

const relay = new URL(new URLSearchParams(location.search).get("relay") ?? "")
if (relay.protocol !== "ws:" || relay.hostname !== "127.0.0.1") throw new Error("Model fixture relay must be loopback")
const devices = [{ id: "dev_1", name: "Model fixture", createdAt: 1, status: "active" as const, online: true }]
const http: RemoteHttp = {
  me: async () => ({ ok: true, value: { user: { id: "user_fixture" }, session: { expiresAt: Date.now() + 60_000 }, devices } }),
  devices: async () => ({ ok: true, value: devices }),
  createEnrollment: async () => ({ ok: false, status: 503, kind: "http", message: "Fixture only" }),
  revokeDevice: async () => ({ ok: true, value: undefined }),
  removeRevokedDevices: async () => ({ ok: true, value: undefined }),
  logout: async () => ({ ok: true, value: undefined }),
}
const store = createRemoteStore({ http, createTransport: (_deviceID, handlers) => createRemoteTransport({ url: relay.href, handlers }) })
Object.assign(window, { modelReplayStore: store })
function Fixture() {
  const remote = useRemote()
  const [workspace, setWorkspace] = createSignal(false)
  Object.assign(window, { modelReplayShowWorkspace: () => setWorkspace(true) })
  return <main style={{ padding: "16px", "max-width": "900px", margin: "auto" }}>
    <Show when={workspace()} fallback={<Composer sessionID={remote.state().activeSessionID} running={false} canSend={remote.state().transport.kind === "open"} />}>
      <MiniComposer target={{ workspaceID: "work_fixture" }} text="" onText={() => {}} allowEmpty onSubmit={() => {}} />
    </Show>
    <ToastLayer sessionID={remote.state().activeSessionID} onOpenSession={() => {}} />
  </main>
}
render(() => <RemoteProvider createStore={() => store}><Fixture /></RemoteProvider>, document.getElementById("app")!)
