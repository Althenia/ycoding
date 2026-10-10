import { For, Show, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { OfficeCanvas } from "./OfficeCanvas"
import { LoadingPlaceholder } from "../ui/loading"
import { officeLocationLabel } from "./model"
import { appearanceFor, characterColumnCount, characterFrame } from "./sprites"
import type { OfficeActor, OfficePreferences, OfficeRoomID, OfficeSnapshot } from "./types"
import { entityCatalog, entityState, entityUsers, type OfficeEntity } from "./entities"

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
  const [inspected, setInspected] = createSignal<OfficeEntity>()
  const [entityClaims, setEntityClaims] = createSignal<ReadonlyMap<string, readonly string[]>>(new Map())
  let inspectFocus: HTMLElement | undefined
  const inspect = (id: string) => {
    if (!inspected()) inspectFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    setInspected(entityCatalog.find((entity) => entity.id === id))
  }
  const closeInspect = () => { setInspected(undefined); inspectFocus?.focus(); inspectFocus = undefined }
  const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") closeInspect() }
  document.addEventListener("keydown", keydown)
  onCleanup(() => document.removeEventListener("keydown", keydown))
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
                onInspectEntity={inspect}
                onEntityClaims={setEntityClaims}
                focusRequest={focusRequest()}
              />
            )}
          </For>
        </div>
        <OfficeRoster snapshot={props.snapshot} locations={locations()} onFocusActor={focusActor} onLoadMoreTeam={props.onLoadMoreTeam} />
        <OfficeEntityList snapshot={props.snapshot} claims={entityClaims()} onInspect={inspect} />
        <Show when={inspected()}>{(entity) => <OfficeEntityCard entity={entity()} snapshot={props.snapshot} claims={entityClaims()} onClose={closeInspect} />}</Show>
      </section>
    </div>
  )
}

function OfficeEntityList(props: { readonly snapshot: OfficeSnapshot; readonly claims: ReadonlyMap<string, readonly string[]>; readonly onInspect: (id: string) => void }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false)
  return <div class="office-entity-list">
    <button type="button" class="button button--secondary button--small" aria-expanded={expanded()} aria-controls="office-entity-options" onClick={() => setExpanded(!expanded())}>Inspect office objects</button>
    <ul id="office-entity-options" hidden={!expanded()} inert={!expanded()}><For each={entityCatalog}>{(entity) => <li><button type="button" data-entity-id={entity.id} data-entity-users={entityUsers(entity, props.snapshot.actors, props.claims).join(", ")} onClick={() => props.onInspect(entity.id)}>{entity.name}, {entity.room}, {entityUsers(entity, props.snapshot.actors, props.claims).join(", ") || "unoccupied"}</button></li>}</For></ul>
  </div>
}

function OfficeEntityCard(props: { readonly entity: OfficeEntity; readonly snapshot: OfficeSnapshot; readonly claims: ReadonlyMap<string, readonly string[]>; readonly onClose: () => void }): JSX.Element {
  const users = () => entityUsers(props.entity, props.snapshot.actors, props.claims)
  const state = () => entityState(props.entity, props.claims.get(props.entity.id) ?? [])
  return <section class="office-entity-card" role="region" aria-label={`${props.entity.name} inspection`} aria-live="polite">
    <header><h3>{props.entity.name}</h3><button type="button" class="button button--secondary button--small" aria-label="Close object inspection" onClick={props.onClose}>Close</button></header>
    <dl><dt>Kind</dt><dd>{props.entity.kind}</dd><dt>Room</dt><dd>{props.entity.room}</dd>
      <dt>State</dt><dd>{state().status}</dd><dt>Using</dt><dd>{users().join(", ") || "No one"}</dd>
      <dt>Description</dt><dd>{props.entity.description}</dd></dl>
  </section>
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
      <Show when={actors().length > 0} fallback={<Show when={props.snapshot.team.status !== "loading"}><p class="office-roster__empty">No agents in this Session yet.</p></Show>}>
        <ul id="office-roster-list" class="office-roster__list">
          <For each={actorIDs()}>
            {(id) => {
              const actor = createMemo(() => actors().find((item) => item.id === id)!)
              return <OfficeRosterRow actor={actor()} room={Object.hasOwn(props.locations, id) ? props.locations[id] : actor().status === "idle" ? "lounge" : "block"} onFocusActor={props.onFocusActor} />
            }}
          </For>
        </ul>
      </Show>
      <Show when={props.snapshot.team.status === "loading"}><LoadingPlaceholder kind="team" label="Loading subagents…" /></Show>
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
        <span class="office-roster__sprite" aria-hidden="true" style={{ "background-image": `url(${characterSheetURL})`, "background-position": `${-(frame() % characterColumnCount) * 32}px ${-Math.floor(frame() / characterColumnCount) * 48}px` }} />
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
