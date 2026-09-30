import { For } from "solid-js"
import { render } from "solid-js/web"
import { RemoteProvider, useRemote } from "../src/remote/context"
import type { RemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { RequestCard } from "../src/remote/ui/conversation"
import { TranscriptNavigation } from "../src/remote/ui/transcript-nav"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"
import "../src/remote/ui/transcript.css"

const params = new URLSearchParams(location.search)
const relay = new URL(params.get("relay") ?? "")
const httpURL = new URL(params.get("http") ?? "")
if (relay.protocol !== "ws:" || relay.hostname !== "127.0.0.1" || httpURL.protocol !== "http:" || httpURL.hostname !== "127.0.0.1") throw new Error("Guardrail fixture requires loopback endpoints")
const devices = [{ id: "dev_1", name: "Guardrail fixture", createdAt: 1, status: "active" as const, online: true }]
const http: RemoteHttp = {
  me: async () => ({ ok: true, value: { user: { id: "user_fixture" }, session: { expiresAt: Date.now() + 60_000 }, devices } }),
  devices: async () => ({ ok: true, value: devices }),
  createEnrollment: async () => ({ ok: false, status: 503, kind: "http", message: "Fixture only" }),
  revokeDevice: async () => ({ ok: true, value: undefined }),
  removeRevokedDevices: async () => ({ ok: true, value: undefined }),
  logout: async () => ({ ok: true, value: undefined }),
}
const store = createRemoteStore({ http, createTransport: (_id, handlers) => createRemoteTransport({ url: relay.href, handlers }) })
Object.assign(window, { guardrailStore: store })
function Fixture() {
  const remote = useRemote()
  const keys = () => remote.state().view?.requests.map((request) => request.id) ?? []
  const request = (id: string) => remote.state().view!.requests.find((item) => item.id === id)!
  return <div class="app app--conversation app--selected" style={{ height: "100dvh", "grid-template-rows": "minmax(0, 1fr)" }}>
    <main class="workspace__main" style={{ "grid-template-rows": "minmax(0, 1fr) auto auto", "min-height": "0" }}>
      <div class="workspace__scroll"><div class="conversation-pane"><TranscriptNavigation messages={() => remote.state().view?.messages ?? []} /><div class="requests"><For each={keys()}>{(id) => <RequestCard request={() => request(id)} activeSessionID={remote.state().activeSessionID} />}</For></div></div></div>
      <div class="conversation-jump-slot" />
      <div class="composer-resident" style={{ height: "100px" }} />
    </main>
  </div>
}
render(() => <RemoteProvider createStore={() => store}><Fixture /></RemoteProvider>, document.getElementById("root")!)
await store.load()
for (let attempt = 0; attempt < 100 && store.state().sessions.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 20))
await store.selectSession("ses_a")
