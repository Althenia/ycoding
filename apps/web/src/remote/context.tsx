import { RemoteWebSocketPath } from "@ycoding-ai/remote"
import { createContext, createSignal, onCleanup, useContext, type Accessor, type JSX } from "solid-js"
import { createRemoteHttp, type SignInProvider } from "./http"
import { createRemoteStore, type RemoteStore, type RemoteStoreState } from "./store"
import { createRemoteTransport } from "./transport"

export type RemoteContextValue = {
  readonly store: RemoteStore
  readonly state: Accessor<RemoteStoreState>
  readonly signIn: (provider: SignInProvider) => void
  /** Set when the OAuth callback reported a failure. */
  readonly authError: string | undefined
}

const RemoteContext = createContext<RemoteContextValue>()

function webSocketURL(deviceID: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}${RemoteWebSocketPath.client}?device=${encodeURIComponent(deviceID)}`
}

export function RemoteProvider(props: { readonly children: JSX.Element; readonly createStore?: () => RemoteStore }) {
  const store =
    props.createStore?.() ??
    createRemoteStore({
      http: createRemoteHttp(),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: webSocketURL(deviceID), handlers }),
    })
  const [state, setState] = createSignal<RemoteStoreState>(store.state())
  const unsubscribe = store.subscribe(() => setState(store.state()))
  const authError =
    new URLSearchParams(window.location.search).get("auth") === "error"
      ? "Google sign-in did not complete. Try again, or check that this account is allowed for the workspace."
      : undefined

  onCleanup(() => {
    unsubscribe()
    store.dispose()
  })

  void store.load()

  const value: RemoteContextValue = {
    store,
    state,
    // Return to the route the reader opened, so signing in from Settings lands on Settings.
    signIn: (provider) => window.location.assign(store.signInURL(provider, window.location.pathname)),
    authError,
  }
  return <RemoteContext.Provider value={value}>{props.children}</RemoteContext.Provider>
}

export function useRemote(): RemoteContextValue {
  const value = useContext(RemoteContext)
  if (!value) throw new Error("RemoteProvider is missing")
  return value
}
