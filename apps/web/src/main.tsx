import { render } from "solid-js/web"
import { App } from "./app"
import { ThemeProvider } from "./theme/theme-store"
import { lockInstalledAppZoom } from "./pwa/installed"
import { registerServiceWorker } from "./pwa/register"
import { pwaInstall } from "./pwa/install"
import "./styles/tokens.css"
import "./styles/base.css"
import "./styles/site.css"
import "./styles/docs.css"
import "./styles/remote.css"

const root = document.getElementById("app")
if (!root) throw new Error("Missing application root")

lockInstalledAppZoom()
pwaInstall.start()

render(
  () => (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  ),
  root,
)

registerServiceWorker()
