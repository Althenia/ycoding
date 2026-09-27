import { For, Show, createMemo, createSignal } from "solid-js"
import { render } from "solid-js/web"
import "../src/styles/tokens.css"
import { OfficeCanvas } from "../src/remote/office/OfficeCanvas"
import { OfficeWorkspace } from "../src/remote/office/OfficeWorkspace"
import { projectOffice } from "../src/remote/office/model"
import { defaultOfficePreferences } from "../src/remote/office/preferences"
import { scenario } from "../src/remote/office/scenarios.test-helper"

function Fixture() {
  const query = new URLSearchParams(location.search)
  const [state, setState] = createSignal(query.get("state") ?? "idle")
  const [revision, setRevision] = createSignal(0)
  const [mounted, setMounted] = createSignal(query.get("mounted") !== "0")
  const [normal, setNormal] = createSignal(false)
  const [selected, setSelected] = createSignal("session-a")
  const [preferences, setPreferences] = createSignal({ ...defaultOfficePreferences, followSelected: !query.has("freeCamera") })
  const [zeroSize, setZeroSize] = createSignal(false)
  const [showTeamCue, setShowTeamCue] = createSignal(query.get("cue") !== "0")
  const [extraSession, setExtraSession] = createSignal(false)
  const [taskState, setTaskState] = createSignal(((["starting", "running", "waiting", "cancelling", "cancelled", "completed", "failed", "lost"] as const)
    .find((value) => value === query.get("taskState")) ?? "running"))
  const snapshot = createMemo(() => {
    const current = scenario(state())
    const pulse = revision()
    return projectOffice({
    ...current,
    ...(query.has("activity") && current.selected ? { selected: { ...current.selected, activity: (["research", "implement", "coordinate", "verify"] as const).find((value) => value === query.get("activity")) } }
      : query.has("snapshots") && current.selected ? { selected: { ...current.selected, activeTool: undefined, thinking: pulse % 2 === 1 } } : {}),
    sessions: [
      ...current.sessions.map((session) => query.has("staleIdle") && session.id === "session-a" ? { ...session, running: true } : session),
      ...(extraSession() ? [{ id: "session-new", parentID: "session-a", title: "New research task", agent: "Researcher", archived: false, running: true }] : []),
    ],
    activeSessionID: selected(),
    ...(query.has("team") || query.has("arrival") ? { team: {
      rootID: "session-a", status: "ready" as const,
      members: [
        ...(query.has("team") ? [{ sessionID: "session-b", parentID: "session-a", description: "Review implementation", agent: "Reviewer", state: taskState() }] : []),
        ...(query.get("team") === "multi" ? [{ sessionID: "session-d", parentID: "session-a", description: "Investigate model behavior", agent: "Researcher", state: "running" as const }] : []),
        ...(extraSession() ? [{ sessionID: "session-new", parentID: "session-a", description: "New research task", agent: "Researcher", state: "running" as const }] : []),
      ],
      cues: showTeamCue() ? [query.get("cueKind") === "report"
        ? { id: "observed-report", kind: "reported" as const, childID: "session-b", outcome: "completed" as const }
        : { id: "observed-delegation", kind: "delegated" as const, childID: "session-b" },
        ...(query.get("team") === "multi" ? [{ id: "observed-delegation-two", kind: "delegated" as const, childID: "session-d" }] : [])] : [],
      more: false,
    } } : {}),
  }, preferences())
  })
  return <main style={{ "font-family": "system-ui", margin: "0 auto", padding: "16px", "max-width": "1400px" }}>
    <h1>Office engine verification fixture</h1>
    <p>Synthetic visual states only. No connection, command, or approval is available.</p>
    <nav style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
      <label>State <select aria-label="Office state" value={state()} onChange={(event) => setState(event.currentTarget.value)}>
        <For each={["idle", "tool", "attention", "offline", "thinking", "compacting"]}>{(value) => <option value={value}>{value}</option>}</For>
      </select></label>
      <button type="button" onClick={() => setMounted(!mounted())}>{mounted() ? "Unmount office" : "Mount office"}</button>
      <Show when={query.has("snapshots")}><button type="button" onClick={() => setRevision((value) => value + 1)}>Refresh snapshot</button></Show>
      <button type="button" onClick={() => setZeroSize(!zeroSize())}>{zeroSize() ? "Restore size" : "Zero size"}</button>
      <button type="button" onClick={() => setPreferences({ ...preferences(), motion: preferences().motion === "system" ? "reduced" : "system" })}>Toggle reduced motion</button>
      <button type="button" onClick={() => setPreferences({ ...preferences(), quality: preferences().quality === "standard" ? "battery" : "standard" })}>Toggle quality</button>
      <Show when={query.has("team")}><button type="button" style={{ display: "none" }} onClick={() => setShowTeamCue(!showTeamCue())}>Toggle observed cue</button></Show>
      <Show when={query.has("transitionTask")}><button type="button" onClick={() => setTaskState(taskState() === "running" ? "completed" : "running")}>Toggle task completion</button></Show>
      <Show when={query.has("arrival")}><button type="button" onClick={() => setExtraSession(!extraSession())}>Toggle arriving session</button></Show>
    </nav>
    <p>Selected session: <output id="selected-session">{selected()}</output>. Quality: <output id="office-quality">{preferences().quality}</output>. Motion: <output id="office-motion">{preferences().motion}</output>.</p>
    <input aria-label="Typing stays in the composer" placeholder="Keyboard input probe" />
    <div class="office-engine-host" classList={{ "office-zero": zeroSize() }} style={{ "max-width": "100%", "margin-top": "12px" }}>
      <Show when={mounted() && !normal()} fallback={<button type="button" onClick={() => { setNormal(false); setMounted(true) }}>Show office</button>}>
        <Show when={query.has("workspace")} fallback={<OfficeCanvas snapshot={snapshot()} preferences={preferences()} onSelectSession={setSelected} onNormalView={() => setNormal(true)} onLocations={() => {}} />}>
          <OfficeWorkspace snapshot={snapshot()} preferences={preferences()} renderKey="fixture" requestCount={0} onSelectSession={setSelected} onNormalView={() => setNormal(true)} onShowRequests={() => setNormal(true)} onLoadMoreTeam={() => {}} />
        </Show>
      </Show>
    </div>
    <aside aria-label="Office session roster" data-cues={snapshot().cues.length}><For each={snapshot().actors}>{(actor) => <button type="button" onClick={() => setSelected(actor.sessionID)}>{actor.name}: {actor.status}</button>}</For></aside>
  </main>
}

const root = document.getElementById("root")
if (!root) throw new Error("Office fixture root missing")
if (new URLSearchParams(location.search).has("inspectEngine")) {
  const { default: Phaser } = await import("phaser")
  const candidate: unknown = Reflect.get(Phaser.Game.prototype, "start")
  if (typeof candidate !== "function") throw new Error("Phaser start hook missing")
  Reflect.set(Phaser.Game.prototype, "start", function (this: Phaser.Game) {
    candidate.call(this)
    document.documentElement.dataset.officeFps = String(this.loop.fpsLimit)
    Object.assign(window, { __officeGame: this })
  })
}
render(() => <Fixture />, root)
