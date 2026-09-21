import { Show, createEffect, onCleanup, type JSX } from "solid-js"
import { useRouter } from "./router/router"
import { matchRoutes } from "./router/route"
import { useRouteMetadata } from "./seo/metadata"
import { LandingPage, MarketingLayout, NotFoundPage } from "./ui/site"
import { DocsIndexPage, DocsPage, useDocAnchor } from "./ui/docs"
import { ChangelogPage } from "./ui/changelog"
import { RemoteProvider } from "./remote/context"
import { RemoteShell } from "./remote/ui/shell"

const routes = [
  { path: "/", render: (_params: Readonly<Record<string, string>>) => <LandingPage /> },
  { path: "/docs", render: (_params: Readonly<Record<string, string>>) => <DocsIndexPage /> },
  { path: "/docs/*slug", render: (params: Readonly<Record<string, string>>) => <DocsPage slug={params.slug ?? ""} /> },
  { path: "/changelog", render: (_params: Readonly<Record<string, string>>) => <ChangelogPage /> },
  { path: "/remote", render: (_params: Readonly<Record<string, string>>) => <RemoteShell path="/remote" /> },
  {
    path: "/remote/sessions",
    render: (_params: Readonly<Record<string, string>>) => <RemoteShell path="/remote/sessions" />,
  },
  {
    path: "/remote/activity",
    render: (_params: Readonly<Record<string, string>>) => <RemoteShell path="/remote/activity" />,
  },
  {
    path: "/remote/settings",
    render: (_params: Readonly<Record<string, string>>) => <RemoteShell path="/remote/settings" />,
  },
] as const

/** Renders the matched route, applies its head metadata, resets scroll on navigation, and honours documentation anchors. */
function Outlet(): JSX.Element {
  const router = useRouter()
  useRouteMetadata(() => router.path())
  useDocAnchor(() => router.hash())

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

export function App(): JSX.Element {
  const router = useRouter()
  // Content entrance is bound to `data-hydrated`, which is set two frames after mount:
  // the pre-hydration paint and a no-script render both show the final state, so no
  // reader ever sees content hidden pending an animation.
  let second = 0
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(() => {
      document.documentElement.dataset.hydrated = "true"
    })
  })
  onCleanup(() => {
    cancelAnimationFrame(first)
    cancelAnimationFrame(second)
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
      <RemoteProvider>
        <Outlet />
      </RemoteProvider>
    </Show>
  )
}
