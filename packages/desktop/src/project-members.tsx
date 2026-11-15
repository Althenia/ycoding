import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { SharedRadioGroup } from "../../../apps/web/src/remote/ui/shared-workspace"
import type { ProjectMutationInput, ProjectsSnapshot, SessionItem } from "./contract"
import { formatCount } from "./form-rules"

type Group = ProjectsSnapshot["groups"][number]
type MemberAction =
  | { readonly kind: "add" | "remove" | "delete"; readonly sessionID: string }
  | { readonly kind: "new"; readonly directory: string; readonly title: string }
type Draft = { readonly identity: string; readonly selected: string; readonly directory: string; readonly title: string; readonly error?: string }
type MemberState = { readonly group: Group; readonly revision: number; readonly sessions: readonly SessionItem[]; readonly disabled: boolean }

export function memberCandidates(group: Group, sessions: readonly SessionItem[]) {
  const taken = new Set([group.master.sessionID, ...group.members.map((member) => member.sessionID)])
  return sessions.filter((item) => item.parentID === undefined && item.time.archived === undefined && !taken.has(item.id))
}

export function memberChange(state: MemberState, action: MemberAction): { readonly input: ProjectMutationInput; readonly confirmation: string } | { readonly error: string } | undefined {
  if (state.disabled) return undefined
  const { group, revision } = state
  const identity = { revision, groupID: group.id, groupRevision: group.revision }
  const members = group.members.map((member) => member.sessionID)
  if (action.kind === "new") {
    if (!action.directory.startsWith("/")) return { error: "Choose a folder for the new member Session." }
    const title = action.title.trim()
    return { input: { kind: "new-member", ...identity, directory: action.directory, ...(title ? { title } : {}) }, confirmation: `Create a new Session${title ? ` titled “${title}”` : ""} in ${action.directory} and add it as a member of project “${group.name}”?` }
  }
  if (action.kind === "add") {
    const candidate = memberCandidates(group, state.sessions).find((item) => item.id === action.sessionID)
    if (!candidate) return { error: "Choose a loaded Session that is not already in the project." }
    return { input: { kind: "update", ...identity, memberSessionIDs: [...members, candidate.id] }, confirmation: `Add “${candidate.title}” as a member of project “${group.name}”?` }
  }
  if (action.sessionID === group.master.sessionID) return { error: "The master Session cannot be removed or deleted here. Change the master in project settings first." }
  const member = group.members.find((item) => item.sessionID === action.sessionID)
  if (!member) return { error: "This Session is no longer a member of the project. Refresh projects." }
  if (action.kind === "remove") return { input: { kind: "update", ...identity, memberSessionIDs: members.filter((id) => id !== member.sessionID) }, confirmation: `Remove “${member.title}” from project “${group.name}”? The Session and its stored data stay available in Sessions.` }
  return { input: { kind: "delete-member", ...identity, sessionID: member.sessionID }, confirmation: `Delete member Session “${member.title}”? This permanently deletes its stored Session data, including its transcript, and removes it from project “${group.name}”.` }
}

export function DesktopProjectMembers(props: { readonly group: Group; readonly revision: number; readonly sessions: readonly SessionItem[]; readonly disabled: boolean; readonly onChange: (input: ProjectMutationInput, confirmation: string) => void; readonly onBrowseFolder: (initialDirectory: string, choose: (directory: string) => void) => void }): JSX.Element {
  const identity = () => `${props.revision}:${props.group.id}:${props.group.revision}`
  const empty = (): Draft => ({ identity: identity(), selected: "", directory: "", title: "" })
  const [draft, setDraft] = createSignal<Draft>(empty())
  const current = () => draft().identity === identity() ? draft() : empty()
  const stage = (change: Partial<Omit<Draft, "identity">>) => setDraft({ ...current(), ...change })
  const selected = () => current().selected
  const directory = () => current().directory
  const title = () => current().title
  const error = () => current().error
  const candidates = createMemo(() => memberCandidates(props.group, props.sessions))
  const run = (action: MemberAction) => {
    const result = memberChange({ group: props.group, revision: props.revision, sessions: props.sessions, disabled: props.disabled }, action)
    if (!result) return
    if ("error" in result) { stage({ error: result.error }); return }
    stage({ error: undefined })
    props.onChange(result.input, result.confirmation)
  }
  const browse = () => {
    if (props.disabled) return
    const owner = identity()
    props.onBrowseFolder(directory() || props.group.master.location.directory, (chosen) => { if (identity() === owner) stage({ directory: chosen, error: undefined }) })
  }
  return <section class="st-section" aria-label={`Members of ${props.group.name}`}>
    <header class="st-section-head"><h3>Members</h3></header>
    <ul class="st-rows">
      <li class="st-row"><span class="st-row-main"><span>{props.group.master.title}</span><small>Master · change it in project settings before removing it</small></span></li>
      <For each={props.group.members} fallback={<li class="st-row"><span class="st-muted">No members yet.</span></li>}>{(member) => <li class="st-row"><span class="st-row-main"><span>{member.title}</span><small>Member · {member.state}</small></span><button type="button" class="rl-btn" data-action-id="project-member-remove" aria-label={`Remove ${member.title} from project`} disabled={props.disabled} onClick={() => run({ kind: "remove", sessionID: member.sessionID })}>Remove member</button><button type="button" class="rl-btn" data-tone="danger" data-action-id="project-member-delete" aria-label={`Delete member Session ${member.title}`} disabled={props.disabled} onClick={() => run({ kind: "delete", sessionID: member.sessionID })}>Delete member</button></li>}</For>
    </ul>
    <h3>Add an existing Session</h3>
    <p class="st-muted">{formatCount(candidates().length)} eligible of {formatCount(props.sessions.length)} Sessions loaded in the rail. Load more Sessions in the rail to add others.</p>
    <Show when={candidates().length} fallback={<p class="st-muted">No loaded Session can be added.</p>}>
      <SharedRadioGroup label="Session to add" value={selected()} disabled={props.disabled} options={candidates().map((item) => ({ value: item.id, label: item.title }))} onChange={(value) => stage({ selected: value, error: undefined })} />
    </Show>
    <button type="button" class="rl-btn" data-action-id="project-member-add" disabled={props.disabled || !selected()} onClick={() => run({ kind: "add", sessionID: selected() })}>Add member</button>
    <h3>New member Session</h3>
    <div class="ws-row"><p class="st-muted">{directory() ? `Folder: ${directory()}` : "No folder chosen."}</p><button type="button" class="rl-btn" data-action-id="project-member-browse" disabled={props.disabled} onClick={browse}>Choose folder…</button></div>
    <label class="rl-field"><span>Session title (optional)</span><input value={title()} disabled={props.disabled} onInput={(event) => stage({ title: event.currentTarget.value })} /></label>
    <button type="button" class="rl-btn" data-tone="go" data-action-id="project-member-new" disabled={props.disabled || !directory()} onClick={() => run({ kind: "new", directory: directory(), title: title() })}>Create member Session</button>
    <Show when={error()}><p role="alert" data-tone="bad">{error()}</p></Show>
  </section>
}
