import { batch, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { RunningSessions } from "../src/remote/ui/running-sessions"
import type { SessionInfoView } from "../src/remote/store"
import "../src/styles/tokens.css"
import "../src/styles/base.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light"
const requestedCount = params.get("count")
const mixed = params.has("mixed")
const entries: readonly (SessionInfoView & { readonly workspaceName: string })[] = [
  { id: "ses_alpha", title: "Review test coverage", projectID: "prj_a", directory: "/work/alpha", workspaceName: "Alpha", updatedAt: 2, archived: false, running: true },
  { id: "ses_beta", title: "Debug remote response", projectID: "prj_b", directory: "/work/beta", workspaceName: "Beta", updatedAt: 1, ...(mixed && !params.has("missing") ? { activeAt: Date.now() - 3_600_000 } : {}), archived: false, running: !mixed },
  ...Array.from({ length: 5 }, (_, index) => ({ id: `ses_more_${index}`, title: index === 4 ? `Investigate ${"long-running deployment incident ".repeat(12)}` : `Session ${index + 3}`, projectID: "prj_c", directory: "/work/other", workspaceName: "Other", updatedAt: index, archived: false, running: true })),
].slice(0, requestedCount !== null && [0, 1, 2, 7].includes(Number(requestedCount)) ? Number(requestedCount) : 2)
const selected: string[] = []
const [current, setCurrent] = createSignal(params.has("dynamic") ? [] : entries)
const [loading, setLoading] = createSignal(params.has("dynamic"))
Object.assign(window, { runningSelected: () => selected.slice(), runningSetCount: (count: number) => batch(() => { setCurrent(entries.slice(0, count)); setLoading(false) }), runningLoading: () => loading(), runningFinish: (activeAt: number) => setCurrent(current().map((entry) => entry.id === "ses_alpha" ? { ...entry, running: false, activeAt } : entry)) })
const root = document.getElementById("app")
if (!root) throw new Error("Missing running Sessions fixture root")
render(() => <main data-running-fixture style={{ "max-width": "70rem", margin: "0 auto", padding: "var(--yc-space-5) var(--yc-gutter)" }}>
  <RunningSessions sessions={current()} loading={loading()} onSelectSession={(sessionID) => selected.push(sessionID)} />
</main>, root)
