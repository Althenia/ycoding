import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { RemoteProvider, useRemote } from "../src/remote/context"
import type { RemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { ProviderConnect } from "../src/remote/ui/provider-connect"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"

const relay = new URL(new URLSearchParams(location.search).get("relay") ?? "")
if (relay.protocol !== "ws:" || relay.hostname !== "127.0.0.1") throw new Error("Fixture relay must be loopback")
const devices = [{ id: "dev_1", name: "Fixture", createdAt: 1, status: "active" as const, online: true }]
const http: RemoteHttp = {
  me: async () => ({ ok: true, value: { user: { id: "user_fixture" }, session: { expiresAt: Date.now() + 60_000 }, devices } }),
  devices: async () => ({ ok: true, value: devices }),
  createEnrollment: async () => ({ ok: false, status: 503, kind: "http", message: "Fixture only" }),
  revokeDevice: async () => ({ ok: true, value: undefined }),
  setDeviceAlias: async (deviceID, alias) => ({ ok: true, value: { deviceID, alias } }),
  removeRevokedDevices: async () => ({ ok: true, value: undefined }),
  logout: async () => ({ ok: true, value: undefined }),
}
const store = createRemoteStore({ http, createTransport: (_deviceID, handlers) => createRemoteTransport({ url: relay.href, handlers }) })
function Fixture() {
  const remote = useRemote()
  const [open, setOpen] = createSignal(false)
  let trigger!: HTMLButtonElement
  return <main><button ref={trigger} disabled={remote.scope() === undefined || remote.state().transport.kind !== "open"} onClick={() => setOpen(true)}>Connect provider</button><Show when={open()}><ProviderConnect target={{ sessionID: "ses_a" }} returnFocus={trigger} onClose={() => setOpen(false)} /></Show></main>
}
render(() => <RemoteProvider createStore={() => store}><Fixture /></RemoteProvider>, document.getElementById("app")!)
