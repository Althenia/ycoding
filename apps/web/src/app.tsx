import { Outlet, RouterProvider, createRootRoute, createRoute, createRouter, useChildMatches, useLocation, useParams, type RouterHistory } from "@tanstack/solid-router"
import { Show, createEffect, onCleanup, type JSX } from "solid-js"
import { useRouteMetadata } from "./seo/metadata"
import { LandingPage, MarketingLayout, NotFoundPage } from "./ui/site"
import { DocsIndexPage, DocsPage, useDocAnchor } from "./ui/docs"
import { ChangelogPage } from "./ui/changelog"
import { RemoteProvider, createRemoteSession, type RemoteSession } from "./remote/context"
import { preloadKeepAwake, preloadUsage, preloadWorkspaces } from "./remote/preload"
import type { RemoteStore } from "./remote/store"
import { RemoteShell } from "./remote/ui/shell"
import { InvitePage } from "./remote/ui/invite"
import { REMOTE_INVITE_PATH, REMOTE_VIEWS } from "./routes"

const remoteUnknownPath = "/remote/$"

export function createAppRouter(options: { readonly createRemoteStore?: () => RemoteStore; readonly history?: RouterHistory } = {}) {
  const rootRoute = createRootRoute({
    component: RootShell,
    notFoundComponent: () => (
      <MarketingLayout>
        <NotFoundPage />
      </MarketingLayout>
    ),
  })
  const marketingRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_marketing",
    component: () => (
      <MarketingLayout>
        <Outlet />
      </MarketingLayout>
    ),
  })
  const docsRoute = createRoute({ getParentRoute: () => marketingRoute, path: "/docs" })
  // The remote session lives while the remote tree is mounted; a preload from outside it never creates one.
  let session: RemoteSession | undefined
  const remoteRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/remote",
    beforeLoad: ({ preload }) => {
      if (session === undefined && !preload) session = createRemoteSession(options.createRemoteStore)
      return { remote: session }
    },
    component: () => {
      const pathname = useLocation({ select: (location) => location.pathname })
      const unknown = useChildMatches({ select: (matches) => matches.some((match) => match.fullPath === remoteUnknownPath) })
      if (session === undefined) session = createRemoteSession(options.createRemoteStore)
      const owned = session
      onCleanup(() => {
        if (session === owned) session = undefined
      })
      return (
        <RemoteProvider session={owned}>
          <Show when={!unknown()} fallback={<NotFoundPage />}>
            <RemoteShell path={pathname} />
          </Show>
        </RemoteProvider>
      )
    },
  })
  const preloads = { usage: preloadUsage, settings: preloadKeepAwake, sessions: undefined }
  return createRouter({
    history: options.history,
    caseSensitive: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    rewrite: {
      input: ({ url }) => {
        url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1")
        return url
      },
    },
    routeTree: rootRoute.addChildren([
      marketingRoute.addChildren([
        createRoute({ getParentRoute: () => marketingRoute, path: "/", component: LandingPage }),
        docsRoute.addChildren([
          createRoute({ getParentRoute: () => docsRoute, path: "/", component: DocsIndexPage }),
          createRoute({
            getParentRoute: () => docsRoute,
            path: "$",
            component: () => {
              const params = useParams({ strict: false })
              return <DocsPage slug={params()._splat ?? ""} />
            },
          }),
        ]),
        createRoute({ getParentRoute: () => marketingRoute, path: "/changelog", component: ChangelogPage }),
      ]),
      remoteRoute.addChildren([
        createRoute({ getParentRoute: () => remoteRoute, path: "/", loader: ({ context }) => preloadWorkspaces(context.remote) }),
        ...REMOTE_VIEWS.map((path) => createRoute({ getParentRoute: () => remoteRoute, path, loader: ({ context }) => preloads[path]?.(context.remote) })),
        createRoute({ getParentRoute: () => remoteRoute, path: "$" }),
      ]),
      createRoute({ getParentRoute: () => rootRoute, path: REMOTE_INVITE_PATH, component: InvitePage }),
    ]),
  })
}

/** Applies route head metadata, resets scroll on public navigation, honours documentation anchors, and gates entrance motion. */
function RootShell(): JSX.Element {
  const pathname = useLocation({ select: (location) => location.pathname })
  const hash = useLocation({ select: (location) => location.hash })
  useRouteMetadata(pathname)
  useDocAnchor(hash)
  createEffect(() => {
    if (hash().length === 0 && !pathname().startsWith("/remote")) window.scrollTo({ top: 0 })
  })
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
  let previousPath = pathname()
  createEffect(() => {
    const path = pathname()
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
  return <Outlet />
}

export function App(props: { readonly createRemoteStore?: () => RemoteStore }): JSX.Element {
  return <RouterProvider router={createAppRouter({ createRemoteStore: props.createRemoteStore })} />
}
