import { render } from "solid-js/web"
import { NotificationSettings } from "../src/remote/ui/settings"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"

const root = document.getElementById("app")
if (!root) throw new Error("Missing push settings fixture root")
render(() => <main class="settings"><NotificationSettings /></main>, root)
