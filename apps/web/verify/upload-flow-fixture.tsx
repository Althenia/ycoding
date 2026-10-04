import { For } from "solid-js"
import { RemoteWebSocketPath } from "@ycoding-ai/remote"
import { render } from "solid-js/web"
import { RemoteProvider, useRemote } from "../src/remote/context"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteTransport } from "../src/remote/transport"
import { Composer } from "../src/remote/ui/composer"
import { MessageRow } from "../src/remote/ui/conversation"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"

const relay = new URLSearchParams(location.search).get("relay")!
const store = createRemoteStore({ http: createRemoteHttp(), createTransport: (deviceID, handlers) => createRemoteTransport({ url: `${relay.replace(/^http/, "ws")}${RemoteWebSocketPath.client}?device=${deviceID}`, handlers }), batchMs: 0 })
await store.load()
await store.selectSession("ses_a")
Object.assign(window, { uploadFlowState: store.state, uploadFlowSelect: store.selectSession })

function View() {
  const remote = useRemote()
  return <><section class="conversation-pane"><For each={remote.state().view?.messages.map((message) => message.id) ?? []}>{(id) => <MessageRow message={() => remote.state().view!.messages.find((message) => message.id === id)!} />}</For></section><Composer sessionID={remote.state().activeSessionID} running={false} canSend={remote.state().transport.kind === "open"} /></>
}

render(() => <RemoteProvider createStore={() => store}><View /></RemoteProvider>, document.getElementById("app")!)
