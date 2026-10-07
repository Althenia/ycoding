import { RouterProvider, createMemoryHistory } from "@tanstack/solid-router"
import { render } from "solid-js/web"
import { createAppRouter } from "../src/app"
import { ThemeProvider } from "../src/theme/theme-store"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/site.css"
import "../src/styles/docs.css"
import "../src/styles/remote.css"

async function open(url: string) {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [url] }) })
  await router.load()
  return router
}

async function probe(url: string) {
  const router = await open(url)
  const location = router.state.location
  return {
    pathname: location.pathname,
    hash: location.hash,
    search: location.search,
    routes: router.matchRoutes(location.pathname).map((match) => match.routeId),
    params: router.state.matches.flatMap((match) => Object.entries(match.params)),
  }
}

async function rendered(url: string) {
  const router = await open(url)
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <ThemeProvider><RouterProvider router={router} /></ThemeProvider>, host)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const result = {
    notFound: host.querySelector(".not-found") !== null,
    marketing: host.querySelector(".marketing") !== null,
    docs: host.querySelector(".docs:not(.docs--index)") !== null,
    docsIndex: host.querySelector(".docs--index") !== null,
    title: document.title,
  }
  dispose()
  host.remove()
  return result
}

async function browserHistory() {
  const router = createAppRouter()
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <ThemeProvider><RouterProvider router={router} /></ThemeProvider>, host)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200))
  await settle()
  const start = window.history.length
  const at = () => ({ added: window.history.length - start, pathname: window.location.pathname, search: Object.fromEntries(new URLSearchParams(window.location.search)), view: router.state.location.pathname })
  await router.navigate({ to: "/docs" })
  const pushed = at()
  await router.navigate({ to: "/remote", search: { workspace_id: "workspace_fixture", source: "sidebar", device_id: "dev_studio" } })
  const landing = at()
  await router.navigate({ to: "/remote/session", search: { session_id: "ses_1", device_id: "dev_studio" } })
  const selected = at()
  await router.navigate({ to: "/remote/sessions", replace: true })
  const replaced = at()
  window.history.back()
  await settle()
  const back = at()
  dispose()
  host.remove()
  return { pushed, landing, selected, replaced, back }
}

async function build(to: string, hash?: string) {
  const router = await open("/")
  return router.buildLocation({ to, hash }).href
}

async function buildSession(sessionID: string, deviceID: string) {
  const router = await open("/")
  return router.buildLocation({ to: "/remote/session", search: { session_id: sessionID, device_id: deviceID } }).href
}

Object.assign(window, { routerProbe: { probe, rendered, browserHistory, build, buildSession } })
