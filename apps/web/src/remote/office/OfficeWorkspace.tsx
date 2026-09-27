import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { OfficeCanvas } from "./OfficeCanvas"
import { officeLocationLabel } from "./model"
import { appearanceFor, characterFrame } from "./sprites"
import type { OfficeActor, OfficePreferences, OfficeRoomID, OfficeSnapshot } from "./types"

const characterSheetURL = new URL("./assets/characters.png?no-inline", import.meta.url).href

export function OfficeWorkspace(props: {
  readonly snapshot: OfficeSnapshot
  readonly preferences: OfficePreferences
  readonly renderKey: string
  readonly requestCount: number
  readonly onSelectSession: (sessionID: string) => void
  readonly onNormalView: () => void
  readonly onShowRequests: () => void
  readonly onLoadMoreTeam: () => void
}): JSX.Element {
  const [locations, setLocations] = createSignal<Readonly<Record<string, OfficeRoomID | undefined>>>({})
  const [focusRequest, setFocusRequest] = createSignal<{ readonly actorID: string; readonly revision: number }>()
  const focusActor = (actor: OfficeActor) => {
    props.onSelectSession(actor.sessionID)
    setFocusRequest({ actorID: actor.id, revision: (focusRequest()?.revision ?? 0) + 1 })
  }
  return (
    <div class="office-workspace">
      <section class="office-workspace__stage" aria-labelledby="office-stage-title">
        <h2 id="office-stage-title" class="visually-hidden">Office</h2>
        <Show when={props.requestCount > 0}>
          <button type="button" class="office-attention" onClick={props.onShowRequests}>
            {props.requestCount === 1 ? "1 request needs your reply" : `${props.requestCount} requests need your reply`}
          </button>
        </Show>
        <div class="office-workspace__canvas">
          <For each={[props.renderKey]}>
            {() => (
              <OfficeCanvas
                snapshot={props.snapshot}
                preferences={props.preferences}
                onSelectSession={props.onSelectSession}
                onNormalView={props.onNormalView}
                onLocations={setLocations}
                focusRequest={focusRequest()}
              />
            )}
          </For>
        </div>
        <OfficeRoster snapshot={props.snapshot} locations={locations()} onFocusActor={focusActor} onLoadMoreTeam={props.onLoadMoreTeam} />
      </section>
    </div>
  )
}

function OfficeRoster(props: {
  readonly snapshot: OfficeSnapshot
  readonly locations: Readonly<Record<string, OfficeRoomID | undefined>>
  readonly onFocusActor: (actor: OfficeActor) => void
  readonly onLoadMoreTeam: () => void
}): JSX.Element {
  const [collapsed, setCollapsed] = createSignal(true)
  const actors = createMemo(() => props.snapshot.actors.filter((actor) => actor.kind !== "task" || !["completed", "cancelled", "failed", "lost"].includes(actor.taskState ?? "") || Object.hasOwn(props.locations, actor.id)))
  const actorIDs = createMemo(() => actors().map((actor) => actor.id))
  return (
    <aside class="office-roster" classList={{ "office-roster--collapsed": collapsed() }} aria-label="Office agents">
      <div class="office-roster__head">
        <h3 class="office-roster__title">Agents <span>{actors().length}</span></h3>
        <button type="button" class="office-roster__toggle" aria-label={collapsed() ? "Show agent list" : "Hide agent list"} aria-expanded={!collapsed()} aria-controls="office-roster-list" onClick={() => setCollapsed(!collapsed())}>{collapsed() ? "Show agents" : "Hide agents"}</button>
      </div>
      <Show when={props.snapshot.activityStatus === "unsupported"}><p class="office-roster__note" role="status">Update YCoding on this machine to show agent activity.</p></Show>
      <Show when={actors().length > 0} fallback={<p class="office-roster__empty">No agents in this Session yet.</p>}>
        <ul id="office-roster-list" class="office-roster__list">
          <For each={actorIDs()}>
            {(id) => {
              const actor = createMemo(() => actors().find((item) => item.id === id)!)
              return <OfficeRosterRow actor={actor()} room={Object.hasOwn(props.locations, id) ? props.locations[id] : actor().status === "idle" ? "lounge" : actor().homeRoom} onFocusActor={props.onFocusActor} />
            }}
          </For>
        </ul>
      </Show>
      <Show when={teamNote(props.snapshot.team, actors().filter((actor) => actor.kind === "task").length)}>{(note) => <p class="office-roster__note">{note()}</p>}</Show>
      <Show when={props.snapshot.team.more}>
        <button type="button" class="button button--secondary button--small office-roster__more" onClick={props.onLoadMoreTeam}>
          Load more subagents
        </button>
      </Show>
      <p class="visually-hidden" role="status">{cueAnnouncement(props.snapshot)}</p>
      <Show when={props.snapshot.overflow > 0}><p class="office-roster__note">{props.snapshot.overflow} more subagents are outside this view.</p></Show>
    </aside>
  )
}

function OfficeRosterRow(props: {
  readonly actor: OfficeActor
  readonly room?: OfficeRoomID
  readonly onFocusActor: (actor: OfficeActor) => void
}): JSX.Element {
  const frame = () => characterFrame(appearanceFor(props.actor.sessionID), "down", 0)
  return (
    <li>
      <button
        type="button"
        class={`office-roster__row${props.actor.selected ? " office-roster__row--selected" : ""}`}
        data-session-id={props.actor.sessionID}
        aria-current={props.actor.selected ? "true" : undefined}
        onClick={() => props.onFocusActor(props.actor)}
      >
        <span class="office-roster__sprite" aria-hidden="true" style={{ "background-image": `url(${characterSheetURL})`, "background-position": `${-(frame() % 12) * 32}px ${-Math.floor(frame() / 12) * 48}px` }} />
        <span class="office-roster__content">
          <span class="office-roster__name">{props.actor.name} <span aria-hidden="true">·</span> {props.actor.role}</span>
          <span class="office-roster__room">{officeLocationLabel(props.room)}</span>
          <Show when={props.actor.unknownOutcome || props.actor.statusText}><span class="office-roster__status">{props.actor.unknownOutcome ? "Outcome unknown" : props.actor.statusText}</span></Show>
        </span>
        <span class={`office-roster__indicator office-roster__indicator--${props.actor.status}`} aria-hidden="true" />
      </button>
    </li>
  )
}

function teamNote(team: OfficeSnapshot["team"], shown: number): string | undefined {
  if (team.status === "loading") return "Loading subagents…"
  if (team.status === "unsupported") return "The connected machine does not report subagents."
  if (team.status === "error") return "Subagents could not be loaded."
  if (team.status !== "ready") return undefined
  if (team.total === 0) return "No subagents for this session."
  return team.total > shown ? `Showing ${shown} of ${team.total} subagents.` : undefined
}

function cueAnnouncement(snapshot: OfficeSnapshot): string {
  const cue = snapshot.cues.at(-1)
  if (!cue) return ""
  const child = snapshot.actors.find((actor) => actor.id === (cue.kind === "delegate" ? cue.toActorID : cue.fromActorID))
  if (!child) return ""
  if (cue.kind === "report" && cue.outcome) return `Subagent ${child.title} reported ${cue.outcome}.`
  return `Delegated to subagent ${child.title}.`
}
