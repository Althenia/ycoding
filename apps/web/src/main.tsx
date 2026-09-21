import { render } from "solid-js/web"
import { App } from "./app"
import { RouterProvider } from "./router/router"
import { ThemeProvider } from "./theme/theme-store"
import { registerServiceWorker } from "./pwa/register"
import "./styles/tokens.css"
import "./styles/base.css"
import "./styles/site.css"
import "./styles/docs.css"
import "./styles/remote.css"

const root = document.getElementById("app")
if (!root) throw new Error("Missing application root")

render(
  () => (
    <RouterProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </RouterProvider>
  ),
  root,
)

registerServiceWorker()
