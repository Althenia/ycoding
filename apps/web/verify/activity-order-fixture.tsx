import { render } from "solid-js/web"
import { RouterProvider, useRouter } from "../src/router/router"
import { ThemeProvider } from "../src/theme/theme-store"
import { RemoteProvider } from "../src/remote/context"
import type { RemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { RemoteShell } from "../src/remote/ui/shell"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"

const relay = new URL(new URLSearchParams(location.search).get("relay") ?? "")
if (relay.protocol !== "ws:" || relay.hostname !== "127.0.0.1") throw new Error("Activity fixture requires a loopback relay")
const devices = [{ id: "dev_1", name: "Activity fixture", createdAt: 1, status: "active" as const, online: true }]
const http: RemoteHttp = {
  me: async () => ({ ok: true, value: { user: { id: "user_fixture" }, session: { expiresAt: Date.now() + 60_000 }, devices } }),
  devices: async () => ({ ok: true, value: devices }),
  createEnrollment: async () => ({ ok: false, status: 503, kind: "http", message: "Fixture only" }),
  revokeDevice: async () => ({ ok: true, value: undefined }),
  removeRevokedDevices: async () => ({ ok: true, value: undefined }),
  logout: async () => ({ ok: true, value: undefined }),
}
const store = createRemoteStore({ http, createTransport: (_id, handlers) => createRemoteTransport({ url: relay.href, handlers }), batchMs: 1 })
Object.assign(window, { activityStore: store })
function Fixture() {
  const router = useRouter()
  router.navigate("/remote/sessions", { replace: true })
  Object.assign(window, { activityOpen: (id: string) => router.navigate(`/remote#session=${id}`) })
  return <RemoteShell path={router.path} />
}
render(() => <RouterProvider><ThemeProvider><RemoteProvider createStore={() => store}><Fixture /></RemoteProvider></ThemeProvider></RouterProvider>, document.getElementById("root")!)
await store.load()
