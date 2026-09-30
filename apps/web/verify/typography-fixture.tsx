import { render } from "solid-js/web"
import { BrandMark } from "../src/ui/site"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/site.css"

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light"
render(() => <main style={{ padding: "var(--yc-space-4)", "max-width": "var(--yc-content-max)", margin: "auto" }}>
  <div class="brand"><BrandMark /></div>
  <h1>Durable work on your machine</h1>
  <p data-sans>Approve the exact operation, keep reading, and review the result.</p>
  <code data-mono>const result = await run("YCoding", 2026)</code>
  <p data-sans-italic style={{ "font-style": "italic" }}>Readable emphasis in the selected interface family.</p>
  <pre data-mono-italic style={{ "font-family": "var(--yc-font-mono)", "font-style": "italic", "white-space": "pre-wrap" }}>const emphasized = "Geist Mono"</pre>
  <button class="button button--secondary" type="button">Review details</button>
</main>, document.getElementById("root")!)
