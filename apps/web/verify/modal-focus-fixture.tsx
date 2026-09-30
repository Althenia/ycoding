import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { CustomSelect } from "../src/ui/custom-select"
import { Icon } from "../src/ui/icon"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"
import "../src/remote/office/office.css"
import "../src/remote/ui/team-view.css"
import "../src/remote/ui/subagent-bar.css"
import "../src/remote/ui/transcript-nav.css"
import "../src/remote/ui/composer.css"

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "dark"

render(() => {
  const [value, setValue] = createSignal("one")
  return <main style={{ padding: "var(--yc-space-4)" }}>
    <span hidden data-neutral-focus style={{ color: "var(--yc-border-strong)" }} />
    <span hidden data-green-focus style={{ color: "var(--yc-focus)" }} />
    <span hidden data-green-border style={{ color: "var(--yc-green-strong)" }} />
    <section aria-label="Icon focus variants">
      <button type="button" class="button button--ghost button--icon" aria-label="Close fixture"><Icon name="close" /></button>
      <button type="button" class="button button--ghost app-header__team" aria-label="Open Team" aria-expanded="true"><Icon name="team" /><span>0</span></button>
      <div class="office-camera-controls"><button type="button" aria-label="Zoom in"><Icon name="plus" /></button></div>
      <div class="subagent-bar__navigation"><button type="button" aria-label="Main session"><Icon name="arrow-up" /></button></div>
      <div class="transcript-navigation__controls transcript-navigation__controls--visible"><button type="button" aria-label="Jump to latest"><Icon name="arrow-down" /></button></div>
      <div class="team-view"><button type="button" class="team-view__button team-view__button--primary" aria-label="Open task"><Icon name="arrow-up" />Open</button></div>
      <div class="team-view"><button type="button" class="team-view__answer" aria-label="Answer task"><Icon name="chat" />Answer</button></div>
      <button type="button" class="composer__mobile-trigger composer__mobile-trigger--pending" aria-label="Pending model"><span>Model choice</span><Icon name="chevron-down" /></button>
      <button type="button" class="mini-picker__trigger mini-picker__trigger--pending" aria-label="Pending agent"><Icon name="user" /><span>Agent choice</span><Icon name="chevron-down" /></button>
    </section>
    <CustomSelect label="Workspace" sheetTitle="Select workspace" sheetSubtitle="Repositories with sessions on this machine"
      value={value()} onChange={setValue} placeholder="Select a workspace"
      options={[{ value: "one", label: "Repository one" }, { value: "two", label: "Repository two" }]} />
  </main>
}, document.getElementById("root")!)
