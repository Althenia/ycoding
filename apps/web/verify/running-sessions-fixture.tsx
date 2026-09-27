import { render } from "solid-js/web"
import { RunningSessions } from "../src/remote/ui/running-sessions"
import type { SessionInfoView } from "../src/remote/store"
import "../src/styles/tokens.css"
import "../src/styles/base.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light"
const entries: readonly (SessionInfoView & { readonly workspaceName: string })[] = params.has("empty") ? [] : [
  { id: "ses_alpha", title: "Review test coverage", projectID: "prj_a", directory: "/work/alpha", workspaceName: "Alpha", updatedAt: 2, archived: false, running: true },
  { id: "ses_beta", title: "Debug remote response", projectID: "prj_b", directory: "/work/beta", workspaceName: "Beta", updatedAt: 1, archived: false, running: true },
]
const selected: string[] = []
Object.assign(window, { runningSelected: () => selected.slice() })
const root = document.getElementById("app")
if (!root) throw new Error("Missing running Sessions fixture root")
render(() => <main data-running-fixture style={{ "max-width": "70rem", margin: "0 auto", padding: "var(--yc-space-5) var(--yc-gutter)" }}>
  <RunningSessions sessions={entries} onSelectSession={(sessionID) => selected.push(sessionID)} />
</main>, root)
