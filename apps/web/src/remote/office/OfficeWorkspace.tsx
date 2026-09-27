import { For, Show, createMemo, type JSX } from "solid-js"
import { Link } from "../../router/router"
import { Chip } from "../../ui/chip"
import { OfficeCanvas } from "./OfficeCanvas"
import { homeRoomLabel } from "./model"
import type { OfficeActor, OfficePreferences, OfficeSnapshot } from "./types"

export function OfficeWorkspace(props: {
  readonly snapshot: OfficeSnapshot
  readonly preferences: OfficePreferences
  readonly renderKey: string
  readonly requestCount: number
  readonly onSelectSession: (sessionID: string) => void
  readonly onNormalView: () => void
  readonly onShowRequests: () => void
  readonly onLoadMoreTeam: () => void
  readonly inspector: JSX.Element
}): JSX.Element {
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
              />
            )}
          </For>
        </div>
        <OfficeRoster snapshot={props.snapshot} onSelectSession={props.onSelectSession} onLoadMoreTeam={props.onLoadMoreTeam} />
      </section>
      <div class="office-workspace__inspector">{props.inspector}</div>
    </div>
  )
}

function OfficeRoster(props: {
  readonly snapshot: OfficeSnapshot
  readonly onSelectSession: (sessionID: string) => void
  readonly onLoadMoreTeam: () => void
}): JSX.Element {
  const ids = createMemo(() => props.snapshot.actors.map((actor) => actor.sessionID))
  const actor = (sessionID: string) => props.snapshot.actors.find((entry) => entry.sessionID === sessionID)
  const root = () => props.snapshot.actors.find((entry) => entry.id === props.snapshot.team.rootActorID)
  return (
    <div class="office-roster">
      <h3 class="office-roster__title">In this office</h3>
      <Show when={ids().length > 0} fallback={<p class="office-roster__empty">No sessions are shown in the office yet.</p>}>
        <ul class="office-roster__list">
          <For each={ids()}>
            {(sessionID) => (
              <Show when={actor(sessionID)}>
                {(entry) => <OfficeRosterRow actor={entry()} root={root()} onSelectSession={props.onSelectSession} />}
              </Show>
            )}
          </For>
        </ul>
      </Show>
      <Show when={teamNote(props.snapshot.team)}>{(note) => <p class="office-roster__note">{note()}</p>}</Show>
      <Show when={props.snapshot.team.more}>
        <button type="button" class="button button--secondary button--small office-roster__more" onClick={props.onLoadMoreTeam}>
          Load more subagents
        </button>
      </Show>
      <p class="visually-hidden" role="status">{cueAnnouncement(props.snapshot)}</p>
      <Show when={props.snapshot.overflow > 0}>
        <p class="office-roster__note">
          {props.snapshot.overflow === 1 ? "1 more session is" : `${props.snapshot.overflow} more sessions are`} listed in{" "}
          <Link href="/remote/sessions">Sessions</Link>.
        </p>
      </Show>
    </div>
  )
}

function OfficeRosterRow(props: {
  readonly actor: OfficeActor
  readonly root: OfficeActor | undefined
  readonly onSelectSession: (sessionID: string) => void
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        class={`office-roster__row${props.actor.selected ? " office-roster__row--selected" : ""}`}
        aria-current={props.actor.selected ? "true" : undefined}
        onClick={() => props.onSelectSession(props.actor.sessionID)}
      >
        <span class="office-roster__name">{props.actor.name}</span>
        <span class="office-roster__session">{props.actor.title}</span>
        <Show when={props.actor.kind === "task"}>
          <span class="office-roster__session">Subagent of {props.root?.title ?? "the parent session"}</span>
        </Show>
        <span class="office-roster__room">{homeRoomLabel[props.actor.homeRoom]}</span>
        <span class="office-roster__status">{props.actor.statusText}</span>
        <span class="office-roster__chips">
          <Show when={props.actor.selected}>
            <Chip label="Selected" tone="success" />
          </Show>
          <Show when={props.actor.kind === "task"}>
            <Chip label="Subagent" />
          </Show>
          <Show when={props.actor.unknownOutcome}>
            <Chip label="Outcome unknown" tone="attention" />
          </Show>
        </span>
      </button>
    </li>
  )
}

function teamNote(team: OfficeSnapshot["team"]): string | undefined {
  if (team.status === "loading") return "Loading subagents…"
  if (team.status === "unsupported") return "The connected machine does not report subagents."
  if (team.status === "error") return "Subagents could not be loaded."
  if (team.status !== "ready") return undefined
  if (team.total === 0) return "No subagents for this session."
  return team.total > team.shown ? `Showing ${team.shown} of ${team.total} subagents.` : undefined
}

function cueAnnouncement(snapshot: OfficeSnapshot): string {
  const cue = snapshot.cues.at(-1)
  if (!cue) return ""
  const child = snapshot.actors.find((actor) => actor.id === (cue.kind === "delegate" ? cue.toActorID : cue.fromActorID))
  if (!child) return ""
  if (cue.kind === "report" && cue.outcome) return `Subagent ${child.title} reported ${cue.outcome}.`
  return `Delegated to subagent ${child.title}.`
}
