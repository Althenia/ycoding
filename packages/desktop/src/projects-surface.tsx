import { For, Show, type ComponentProps, type JSX } from "solid-js"
import { createSharedProjectForm, SharedRadioGroup, type SharedProjectsSurface } from "../../../apps/web/src/remote/ui/shared-workspace"
import { Icon } from "../../../apps/web/src/ui/icon"
import { ProjectDeleteIcon } from "./project-members"

export function DesktopProjectsSurface(props: ComponentProps<typeof SharedProjectsSurface> & { roster?: JSX.Element }) {
  const selected = () => props.projects.find(project => project.id === props.selectedID)
  const form = props.form ?? createSharedProjectForm(props)
  const candidates = () => (props.candidates ?? []).filter(candidate => !form.query() || `${candidate.title} ${candidate.id}`.toLowerCase().includes(form.query().toLowerCase()))
  return <div class="relay-settings st-stack desktop-project-overview">
    <div class="st-toolbar"><p class="st-count" data-part="st-coord-count">{props.projects.length} {props.projects.length === 1 ? "project" : "projects"}</p><div class="ws-row"><button type="button" class="rl-icon-button" aria-label="Refresh projects" data-tooltip="Refresh projects" disabled={props.refreshing} onClick={props.onRefresh}><Icon name="refresh" /></button><button type="button" class="rl-btn" data-action-id="st-coord-new" disabled={props.busy} onClick={props.onOpenCreate}><Icon name="plus" />New project</button></div></div>
    <Show when={props.notice}><p class="st-result" role="status">{props.notice}</p></Show>
    <Show when={props.creating}><section class="st-form" aria-label="Create project">
      <label class="rl-field"><span>Project name</span><input value={form.name()} disabled={props.busy} onInput={e => form.setName(e.currentTarget.value)} /></label>
      <SharedRadioGroup label="Master Session source" options={[{ value: "existing", label: "Existing Session", icon: "chat" }, { value: "directory", label: "New Session in folder", icon: "folder-plus" }]} value={form.source()} disabled={props.busy} onChange={value => form.setSource(value === "directory" ? "directory" : "existing")} />
      <Show when={form.source() === "directory" && props.directories?.length}><SharedRadioGroup label="Registered master folders" value={form.directory()} disabled={props.busy} options={(props.directories ?? []).map(directory => ({ value: directory.directory, label: directory.name ?? directory.directory }))} onChange={form.setDirectory} /></Show>
      <Show when={form.source() === "existing"} fallback={<><label class="rl-field"><span>Master folder</span><input value={form.directory()} disabled={props.busy} onInput={e => form.setDirectory(e.currentTarget.value)} /></label><button type="button" class="rl-btn" disabled={props.busy} onClick={form.browse}><Icon name="folder" />Choose folder…</button><label class="rl-field"><span>Master Session title (optional)</span><input value={form.masterTitle()} disabled={props.busy} onInput={e => form.setMasterTitle(e.currentTarget.value)} /></label></>}>
        <label class="rl-field"><span>Search Sessions</span><input type="search" value={form.query()} disabled={props.busy} onInput={e => form.setQuery(e.currentTarget.value)} /></label>
        <SharedRadioGroup label="Master Session" value={form.masterID() ?? ""} disabled={props.busy} options={candidates().map(candidate => ({ value: candidate.id, label: candidate.title }))} onChange={form.chooseMaster} />
      </Show>
      <h3>Member Sessions</h3><div class="st-project-candidates"><For each={(props.candidates ?? []).filter(candidate => form.source() === "directory" || candidate.id !== form.masterID())}>{candidate => <label class="rl-choice"><input type="checkbox" checked={form.memberIDs().includes(candidate.id)} disabled={props.busy} onChange={() => form.toggleMember(candidate.id)} /><span>{candidate.title}</span></label>}</For></div>
      <Show when={form.error() ?? props.nameError}>{error => <p role="alert">{error()}</p>}</Show>
      <div class="st-actions"><button type="button" class="rl-btn" disabled={props.busy} data-action-id="st-coord-create" onClick={form.submit}>Create project</button><button type="button" class="rl-btn" onClick={props.onCancelCreate}>Cancel</button></div>
    </section></Show>
    <div class="ws-projects"><section class="st-section" aria-label="Projects"><header class="st-section-head"><h3>Projects</h3></header><div class="rl-list"><For each={props.projects} fallback={<p class="st-muted">No projects reported.</p>}>{project => <button type="button" class="rl-option" aria-pressed={project.id === props.selectedID} onClick={() => props.onSelect(project.id)}><span class="rl-option-text"><strong>{project.name}</strong><small>{project.masterTitle} · {project.members.length} members</small></span><span class="desktop-project-active" data-active={project.active}><Icon name={project.active ? "check" : "stop"} /><span class="desktop__sr">{project.statusText}</span></span></button>}</For></div></section>
    <Show when={selected()}>{project => <section class="st-section desktop-project-detail" aria-label={project().name}><header class="st-section-head"><h3>{project().name}</h3><span class="desktop-project-revision">Revision {project().revision}</span><button type="button" class="rl-icon-button" aria-label="Open project chat" data-tooltip="Open Master Session" onClick={() => props.onOpenMaster(project().master.sessionID)}><Icon name="external" /></button><button type="button" class="rl-icon-button" data-tone="danger" aria-label="Delete project" data-tooltip="Delete project · keep Sessions" disabled={props.busy} onClick={() => props.onDeleteProject?.(project().id)}><ProjectDeleteIcon /></button></header>
      {props.roster}
    </section>}</Show></div>
    <Show when={selected()}>{project => <div class="desktop-project-options"><label><span>Members running at once</span>{props.concurrencyControl?.(project())}</label><p class="st-muted">Delegated decisions <span>{project().delegatedText ?? "None reported"}</span></p></div>}</Show>
  </div>
}
