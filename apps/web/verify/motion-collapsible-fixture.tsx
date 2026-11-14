import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Collapsible } from "../src/ui/collapsible"
import "../src/styles/tokens.css"
import "../src/styles/base.css"

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light"
let mounts = 0
Object.defineProperty(window, "__mounts", { get: () => mounts })

function Body() {
  mounts += 1
  return (
    <div id="body" style={{ "block-size": "120px", background: "var(--yc-green-soft)", padding: "var(--yc-space-3)" }}>
      <button class="button" id="inside">Inside control</button>
    </div>
  )
}

const [open, setOpen] = createSignal(false)

render(() => (
  <main style={{ padding: "var(--yc-space-4)", "max-inline-size": "480px" }}>
    <button class="button" id="toggle" aria-expanded={open()} aria-controls="panel" onClick={() => setOpen(!open())}>Toggle</button>
    <Collapsible open={open()} id="panel">
      <Body />
    </Collapsible>
    <p id="below" class="motion-enter" style={{ margin: "0" }}>Content below the panel</p>
  </main>
), document.getElementById("app")!)
