import { createContext, useContext, type Accessor, type JSX } from "solid-js"
import { createSignal, onCleanup } from "solid-js"
import { matchRoutes, parseLocation, type RouteParams } from "./route"

export type RouterValue = {
  readonly path: Accessor<string>
  readonly hash: Accessor<string>
  readonly navigate: (to: string, options?: { readonly replace?: boolean }) => void
}

const RouterContext = createContext<RouterValue>()

export function RouterProvider(props: { readonly children: JSX.Element }) {
  const initial = parseLocation(window.location.pathname + window.location.search + window.location.hash)
  const [path, setPath] = createSignal(initial.path)
  const [hash, setHash] = createSignal(initial.hash)

  const sync = () => {
    const next = parseLocation(window.location.pathname + window.location.search + window.location.hash)
    setPath(next.path)
    setHash(next.hash)
  }

  const navigate: RouterValue["navigate"] = (to, options) => {
    const target = parseLocation(to)
    const url = `${target.path}${target.hash.length > 0 ? `#${target.hash}` : ""}`
    if (options?.replace) window.history.replaceState(null, "", url)
    else window.history.pushState(null, "", url)
    sync()
  }

  window.addEventListener("popstate", sync)
  onCleanup(() => window.removeEventListener("popstate", sync))

  const value: RouterValue = { path, hash, navigate }
  return <RouterContext.Provider value={value}>{props.children}</RouterContext.Provider>
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext)
  if (!value) throw new Error("RouterProvider is missing")
  return value
}

/** Resolves the current location against a route table. */
export function useRoute<TRoute extends { readonly path: string }>(
  routes: readonly TRoute[],
): Accessor<{ readonly route: TRoute; readonly params: RouteParams } | undefined> {
  const router = useRouter()
  return () => matchRoutes(routes, router.path()) ?? undefined
}

export function Link(props: {
  readonly href: string
  readonly class?: string
  readonly children: JSX.Element
  readonly onClick?: () => void
  readonly ariaLabel?: string
  readonly ariaCurrent?: "page"
  readonly role?: string
  readonly title?: string
}) {
  const router = useRouter()
  const anchor: string = props.href
  const navigate = (event: MouseEvent | KeyboardEvent) => {
    if (anchor.startsWith("http") || anchor.startsWith("mailto:")) return
    event.preventDefault()
    props.onClick?.()
    router.navigate(anchor)
  }
  return (
    <a
      href={anchor}
      class={props.class}
      title={props.title}
      aria-label={props.ariaLabel}
      aria-current={props.ariaCurrent}
      onClick={navigate}
      onKeyDown={(event) => {
        if (event.key === "Enter") navigate(event)
      }}
    >
      {props.children}
    </a>
  )
}
