import { render } from "solid-js/web"
import { Show, createSignal } from "solid-js"
import { TodoPanel } from "../src/remote/ui/todo-panel"
import type { TodoView } from "../src/remote/store"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light"
const [todos, updateTodos] = createSignal<readonly TodoView[]>([
  ...Array.from({ length: 3 }, (_, index) => ({ content: `Finished ${index}`, status: "completed", priority: "medium" }) as const),
  { content: "Current work", status: "in_progress", priority: "high" },
  ...Array.from({ length: 3 }, (_, index) => ({ content: `Pending ${index}`, status: "pending", priority: "low" }) as const),
  { content: "Skipped work", status: "cancelled", priority: "low" },
])
Object.assign(window, { updateTodos })
const withoutPanel = new URLSearchParams(location.search).get("panel") === "off"
render(() => <div class="app app--conversation app--selected"><header class="app-header">Conversation</header><div class="workspace"><main class="workspace__main" style={withoutPanel ? { "grid-template-rows": "minmax(0, 1fr) auto" } : undefined}><div class="workspace__scroll" data-testid="transcript"><div style={{ height: "1200px" }}>Transcript messages</div></div><Show when={!withoutPanel}><TodoPanel todos={todos()} /></Show><div class="composer"><div class="composer__row">Composer</div></div></main></div></div>, document.getElementById("app")!)
