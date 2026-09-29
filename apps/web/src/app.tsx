import { Show, createEffect, onCleanup, type JSX } from "solid-js"
import { useRouter } from "./router/router"
import { matchRoutes } from "./router/route"
import { useRouteMetadata } from "./seo/metadata"
import { LandingPage, MarketingLayout, NotFoundPage } from "./ui/site"
import { DocsIndexPage, DocsPage, useDocAnchor } from "./ui/docs"
import { ChangelogPage } from "./ui/changelog"
import { RemoteProvider } from "./remote/context"
import type { RemoteStore } from "./remote/store"
import { RemoteShell } from "./remote/ui/shell"
import { InvitePage } from "./remote/ui/invite"

const routes = [
  { path: "/", render: (_params: Readonly<Record<string, string>>) => <LandingPage /> },
  { path: "/docs", render: (_params: Readonly<Record<string, string>>) => <DocsIndexPage /> },
  { path: "/docs/*slug", render: (params: Readonly<Record<string, string>>) => <DocsPage slug={params.slug ?? ""} /> },
  { path: "/changelog", render: (_params: Readonly<Record<string, string>>) => <ChangelogPage /> },
] as const
const remoteRoutes = ["/remote", "/remote/sessions", "/remote/activity", "/remote/usage", "/remote/settings"] as const

/** Renders the matched route, applies its head metadata, resets scroll on navigation, and honours documentation anchors. */
function Outlet(): JSX.Element {
  const router = useRouter()

  createEffect(() => {
    const path = router.path()
    const hash = router.hash()
    if (hash.length === 0 && !path.startsWith("/remote")) window.scrollTo({ top: 0 })
  })

  const matched = () => matchRoutes(routes, router.path())
  return (
    <Show when={matched()} fallback={<NotFoundPage />}>
      {(match) => <>{match().route.render(match().params)}</>}
    </Show>
  )
}

export function App(props: { readonly createRemoteStore?: () => RemoteStore }): JSX.Element {
  const router = useRouter()
  useRouteMetadata(() => router.path())
  useDocAnchor(() => router.hash())
  const preference = window.matchMedia("(prefers-reduced-motion: no-preference)")
  let second = 0
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(() => {
      if (preference.matches) document.documentElement.dataset.motion = "on"
    })
  })
  const updateMotion = () => {
    if (preference.matches) document.documentElement.dataset.motion = "on"
    else delete document.documentElement.dataset.motion
  }
  preference.addEventListener("change", updateMotion)
  let previousPath = router.path()
  createEffect(() => {
    const path = router.path()
    if (path === previousPath) return
    previousPath = path
    updateMotion()
  })
  onCleanup(() => {
    cancelAnimationFrame(first)
    cancelAnimationFrame(second)
    preference.removeEventListener("change", updateMotion)
    delete document.documentElement.dataset.motion
  })
  return (
    <Show
      when={router.path().startsWith("/remote")}
      fallback={
        <MarketingLayout>
          <Outlet />
        </MarketingLayout>
      }
    >
      <Show when={router.path() === "/remote/invite"} fallback={
        <RemoteProvider createStore={props.createRemoteStore}>
          <Show when={remoteRoutes.some((route) => route === router.path())} fallback={<NotFoundPage />}>
            <RemoteShell path={() => router.path()} />
          </Show>
        </RemoteProvider>
      }>
        <InvitePage />
      </Show>
    </Show>
  )
}
