import { RemoteWebSocketPath } from "@ycoding-ai/remote"
import { QueryClientProvider } from "@tanstack/solid-query"
import { useStore } from "@tanstack/solid-store"
import { createContext, createSignal, onCleanup, useContext, type Accessor, type JSX } from "solid-js"
import type { RemoteDeviceInfo } from "@ycoding-ai/remote"
import { displayDeviceName, readDeviceAliases, setDeviceAlias, type DeviceAliases } from "./device-alias"
import { createRemoteHttp, type SignInProvider } from "./http"
import { createRemoteQueries, createRemoteQueryClient, type QueryScope, type RemoteQueries } from "./queries"
import { createRemoteStore, type RemoteStore, type RemoteStoreState } from "./store"
import { createRemoteTransport } from "./transport"

export type RemoteContextValue = {
  readonly store: RemoteStore
  readonly state: Accessor<RemoteStoreState>
  /** Subscribes to one slice of the store; the accessor changes only when the compared slice does. */
  readonly select: <T>(selector: (state: RemoteStoreState) => T, compare?: (a: T, b: T) => boolean) => Accessor<T>
  /** Device and generation that key connection-scoped read resources. */
  readonly scope: Accessor<QueryScope | undefined>
  readonly deviceAliases: Accessor<DeviceAliases>
  readonly deviceName: (device: Pick<RemoteDeviceInfo, "id" | "name">) => string
  readonly setDeviceAlias: (deviceID: string, alias: string) => void
  readonly queries: RemoteQueries
  readonly signIn: (provider: SignInProvider) => void
  /** Set when the OAuth callback reported a failure. */
  readonly authError: string | undefined
}

const RemoteContext = createContext<RemoteContextValue>()

function webSocketURL(deviceID: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}${RemoteWebSocketPath.client}?device=${encodeURIComponent(deviceID)}`
}

/** One remote workspace lifetime: the store and the read options its routes and panels share. */
export type RemoteSession = { readonly store: RemoteStore; readonly queries: RemoteQueries }

export function createRemoteSession(createStore?: () => RemoteStore): RemoteSession {
  const store =
    createStore?.() ??
    createRemoteStore({
      http: createRemoteHttp(),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: webSocketURL(deviceID), handlers }),
      queryClient: createRemoteQueryClient(),
    })
  return { store, queries: createRemoteQueries(store.link, store.queryClient) }
}

/** Owns the session it is given, or one it creates, until it unmounts. */
export function RemoteProvider(props: { readonly children: JSX.Element; readonly createStore?: () => RemoteStore; readonly session?: RemoteSession }) {
  const session = props.session ?? createRemoteSession(props.createStore)
  const store = session.store
  const state = useStore(store.container)
  const scope = useStore(
    store.container,
    (current): QueryScope | undefined =>
      current.activeDeviceID === undefined ? undefined : { deviceID: current.activeDeviceID, generation: current.generation },
    (a, b) => a?.deviceID === b?.deviceID && a?.generation === b?.generation,
  )
  const [deviceAliases, setDeviceAliases] = createSignal(readDeviceAliases())
  const authError =
    new URLSearchParams(window.location.search).get("auth") === "error"
      ? "Google sign-in did not complete. Try again, or check that this account is allowed for the workspace."
      : undefined

  onCleanup(() => store.dispose())

  void store.load()

  const value: RemoteContextValue = {
    store,
    state,
    select: (selector, compare) => useStore(store.container, selector, compare),
    scope,
    deviceAliases,
    deviceName: (device) => displayDeviceName(device, deviceAliases()),
    setDeviceAlias: (deviceID, alias) => setDeviceAliases(setDeviceAlias(deviceID, alias)),
    queries: session.queries,
    // Return to the route the reader opened, so signing in from Settings lands on Settings.
    signIn: (provider) => window.location.assign(store.signInURL(provider, window.location.pathname + window.location.search)),
    authError,
  }
  return (
    <QueryClientProvider client={store.queryClient}>
      <RemoteContext.Provider value={value}>{props.children}</RemoteContext.Provider>
    </QueryClientProvider>
  )
}

export function useRemote(): RemoteContextValue {
  const value = useContext(RemoteContext)
  if (!value) throw new Error("RemoteProvider is missing")
  return value
}
