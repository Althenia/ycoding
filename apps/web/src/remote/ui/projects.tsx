import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import { Modal } from "../../ui/modal"
import { CustomSelect } from "../../ui/custom-select"
import { useRemote } from "../context"
import { createRemoteQuery } from "../query"
import { createPushHttp } from "../http"
import { pushCategoriesFor, readNotificationPreferences } from "../preferences"
import { browserPushPlatform, savePushCategories } from "../push"
import {
  activityBuckets, addMemberInput, ageLabel, centralPolicyNote, changeMasterInput, concurrencyMeter, createProjectInput,
  delegatedCategories, delegationDraftIssue, effectiveDelegation, expiryAt, expiryChoices, externalKinds,
  filterLabel, freshnessLabel, liveLabel, maxMembers, memberCounts, parseConcurrency, parseList, parseProjectName,
  projectOf, pushFilterWire, removeMemberInput, renameInput, setScope, settingsInput, statusLabel, summaryLine, toggleCategory, toggleMaster,
  type DelegatedCategory, type ExpiryChoice, type ExternalKind, type ParticipantView, type ProjectDetail,
} from "../coordination"
import type { CoordinationChange, CoordinationOperation } from "../queries"
import { moveRadio } from "./settings"
import { DotTrail } from "./dot-trail"
import "./projects.css"

type Notice = { readonly tone: "danger" | "attention" | "success"; readonly text: string }
type ProjectDialog = { readonly kind: "add" | "new" | "master" | "delete-session" | "delete-project"; readonly project: ProjectDetail; readonly session?: ParticipantView; readonly trigger: HTMLElement }

export function createProjectsData(enabled: () => boolean, open: (sessionID: string) => void) {
  const remote = useRemote()
  const connected = () => remote.state().transport.kind === "open" && remote.state().connection.kind === "connected"
  const query = createRemoteQuery(remote.store.queryClient, () => remote.queries.coordination(remote.scope(), connected() && enabled()))
  const ready = () => { const value = query().data; return value?.status === "ready" ? value : undefined }
  const groups = () => ready()?.groups ?? []
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 5_000)
  onCleanup(() => clearInterval(timer))
  const [creating, setCreating] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [notice, setNotice] = createSignal<Notice>()
  const [dialog, setDialog] = createSignal<ProjectDialog>()
  let previousScope = ""
  createEffect(() => {
    const scope = remote.scope()
    const key = `${scope?.deviceID}:${scope?.generation}`
    if (previousScope && key !== previousScope) { setDialog(undefined); setCreating(false); setNotice(undefined) }
    previousScope = key
  })
  const report = (result: CoordinationChange, success: string) => {
    setNotice(result.reached ? { tone: "success", text: success } : { tone: result.unconfirmed ? "attention" : "danger", text: result.message })
    return result.reached
  }
  const run = async (operation: CoordinationOperation, input: Readonly<Record<string, unknown>>, success: string) => {
    const scope = remote.scope()
    if (!scope || pending()) return false
    setPending(true)
    setNotice(undefined)
    try {
      const result = await remote.queries.changeCoordination(scope, operation, input)
      if (remote.scope()?.deviceID !== scope.deviceID || remote.scope()?.generation !== scope.generation) return false
      return report(result, success)
    } finally { setPending(false) }
  }
  const refresh = () => { const scope = remote.scope(); if (scope) void remote.queries.refreshCoordination(scope) }
  const membership = () => projectOf(groups(), remote.state().activeSessionID ?? "")
  const freshness = () => freshnessLabel({ updatedAt: query().dataUpdatedAt, failedAt: query().isError ? query().errorUpdatedAt : undefined }, now())
  return { remote, query, connected, ready, groups, now, creating, setCreating, pending, setPending, notice, setNotice, dialog, setDialog, run, report, refresh, membership, freshness, open }
}
export type ProjectsData = ReturnType<typeof createProjectsData>

function Feedback(props: { readonly data: ProjectsData }) {
  return <Show when={props.data.notice()}>{(notice) => <p class="projects__notice" data-tone={notice().tone} role={notice().tone === "danger" ? "alert" : "status"}>{notice().text}</p>}</Show>
}

function ProjectState(props: { readonly data: ProjectsData; readonly children: JSX.Element }) {
  const data = props.data
  return <Show when={data.connected()} fallback={<p class="projects__empty" role="status">Connect a machine in Settings to open Projects.</p>}>
    <Show when={data.query().data?.status !== "unsupported"} fallback={<p class="projects__empty" role="status">This machine does not offer Projects yet. Update YCoding on it, then reload.</p>}>
      <Show when={data.ready()} fallback={data.query().isError
        ? <div role="alert"><p>{data.query().error?.message}</p><button class="button button--secondary" onClick={data.refresh}>Retry</button></div>
        : <div class="project-skeleton" role="status" aria-busy="true"><span /><span /><span /><p>Loading projects…</p></div>}>
        {props.children}
      </Show>
    </Show>
  </Show>
}

export function ProjectStatus(props: { readonly project: Pick<ProjectDetail, "active" | "pausedReason"> }) {
  return <span class="project-status" data-active={props.project.active}><span aria-hidden="true">{props.project.active ? "●" : "Ⅱ"}</span>{statusLabel(props.project.active, props.project.pausedReason)}</span>
}

export function ProjectFreshness(props: { readonly data: ProjectsData }) {
  return <span class="project-freshness" data-stale={props.data.freshness().stale} role="status">{props.data.freshness().text}</span>
}

function Meter(props: { readonly project: ProjectDetail }) {
  const meter = () => concurrencyMeter(props.project.settings.concurrency, memberCounts(props.project.members).running)
  const cells = () => { const value = meter(); return value.kind === "limit" ? value.cells : [false, false, false] }
  return <div class="project-meter"><div class="project-meter__label"><span>{props.project.settings.concurrency === null ? "Running" : "Concurrency limit"}</span><strong>{meter().text}</strong></div>
    <div class="project-meter__track" role={meter().kind === "limit" ? "meter" : undefined} aria-label="Running members against the concurrency limit" aria-valuemin={0} aria-valuemax={props.project.settings.concurrency ?? undefined} aria-valuenow={meter().running} aria-valuetext={meter().text}>
      <For each={cells()}>{(on) => <span data-on={on} data-unlimited={props.project.settings.concurrency === null} />}</For>
    </div></div>
}

function Sparkline(props: { readonly project: ProjectDetail; readonly now: number }) {
  const buckets = () => activityBuckets(props.project.members, props.now)
  const max = () => Math.max(1, ...buckets())
  return <span class="project-sparkwrap"><span class="project-spark" role="img" aria-label={`Members last active per 5 minutes over the last hour: ${buckets().join(", ")}`}><For each={buckets()}>{(value) => <i data-zero={value === 0} style={{ "block-size": `${Math.max(2, Math.round(value / max() * 24))}px` }} />}</For></span>member activity · 1 h</span>
}

function NewProjectButton(props: { readonly data: ProjectsData; readonly onNew: () => void }) {
  return <button type="button" class="button button--primary button--small" disabled={!props.data.ready() || props.data.pending()} onClick={props.onNew}><Icon name="plus" size={16} />New project</button>
}

export function ProjectsRail(props: { readonly data: ProjectsData; readonly onNew: () => void }) {
  const data = props.data
  return <section class="project-rail" aria-label="Projects"><div class="project-rail__head"><h2>Projects</h2><NewProjectButton data={data} onNew={props.onNew} /></div>
    <ProjectState data={data}><ul class="project-list project-list--rail"><For each={data.groups()}>{(group) => <li><button type="button" class="project-item" aria-label={`Open project ${group.detail.name}`} aria-current={data.membership()?.detail.id === group.detail.id ? "true" : undefined} onClick={() => data.open(group.detail.master.sessionID)}><span class="project-item__name">{group.detail.name}<Icon name="chevron-right" size={16} /></span><ProjectStatus project={group.detail} /><span class="project-meta">{summaryLine(memberCounts(group.detail.members))}</span><Sparkline project={group.detail} now={data.now()} /></button></li>}</For></ul></ProjectState>
  </section>
}

export function ProjectsPage(props: { readonly data: ProjectsData }) {
  const data = props.data
  return <div class="projects"><Show when={!data.creating()} fallback={<CreateProject data={data} />}>
    <header class="project-pagehead"><div><h1>Projects</h1><p>Each Project is a master Session plus the Sessions it directs.</p></div><div class="project-actions"><ProjectFreshness data={data} /><button class="button button--ghost button--small" disabled={data.query().isFetching} onClick={data.refresh}><Icon name="refresh" size={16} />Refresh</button><NewProjectButton data={data} onNew={() => data.setCreating(true)} /></div></header>
    <Feedback data={data} />
    <ProjectState data={data}><Show when={data.groups().length > 0} fallback={<div class="project-empty"><h2>No projects</h2><p>A Project is one master Session plus the Sessions it directs.</p><NewProjectButton data={data} onNew={() => data.setCreating(true)} /></div>}>
      <ul class="project-list"><For each={data.groups()}>{(group) => <li class="project-card"><div class="project-card__head"><h2>{group.detail.name}</h2><ProjectStatus project={group.detail} /></div><div class="project-actions"><span class="project-badge project-badge--master">Master</span><span>{group.detail.master.title}</span></div><p class="project-meta">{summaryLine(memberCounts(group.detail.members))} · {group.detail.members.length + 1} Sessions</p><Meter project={group.detail} /><Sparkline project={group.detail} now={data.now()} /><div class="project-actions"><button class="button button--primary" aria-label={`Open project ${group.detail.name}`} onClick={() => data.open(group.detail.master.sessionID)}>Open project<Icon name="chevron-right" size={16} /></button><button class="button button--danger button--small" aria-label={`Delete project ${group.detail.name}`} onClick={(event) => data.setDialog({ kind: "delete-project", project: group.detail, trigger: event.currentTarget })}>Delete…</button></div></li>}</For></ul>
    </Show></ProjectState>
  </Show></div>
}

export function Segmented<Value extends string>(props: { readonly label: string; readonly value: Value; readonly options: readonly { readonly id: Value; readonly label: string }[]; readonly onChange: (value: Value) => void; readonly disabled?: boolean }) {
  return <span class="filters filters--inline project-segmented" role="radiogroup" aria-label={props.label}><For each={props.options}>{(option, index) => <button type="button" role="radio" disabled={props.disabled} aria-checked={props.value === option.id} tabIndex={props.value === option.id ? 0 : -1} class={`filters__option${props.value === option.id ? " filters__option--active" : ""}`} onClick={() => props.onChange(option.id)} onKeyDown={(event) => moveRadio(event, index(), props.options.length, (next) => { const selected = props.options[next]; if (selected) props.onChange(selected.id) })}>{option.label}</button>}</For></span>
}

function SessionPicker(props: { readonly data: ProjectsData; readonly selected?: string; readonly allowProject?: string; readonly onChoose: (id: string) => void; readonly label: string }) {
  const [search, setSearch] = createSignal("")
  const remote = props.data.remote
  const listed = createRemoteQuery(remote.store.queryClient, () => remote.queries.projectCandidates(remote.scope(), props.data.connected(), search()))
  const entries = createMemo(() => {
    const local = props.data.groups().flatMap((group) => [group.detail.master, ...group.detail.members]).map((entry) => ({ id: entry.sessionID, title: entry.title, directory: entry.directory, active: entry.lastActivity }))
    return [...new Map([...(listed().data ?? []), ...local].map((entry) => [entry.id, entry])).values()].filter((entry) => `${entry.title} ${entry.directory}`.toLowerCase().includes(search().toLowerCase()))
  })
  return <div class="project-picker"><label class="field"><span class="field__label">Search Sessions</span><input class="input" type="search" value={search()} placeholder="Title or directory" onInput={(event) => setSearch(event.currentTarget.value)} /></label>
    <Show when={listed().isError}><p class="projects__notice" data-tone="danger" role="alert">{listed().error?.message}</p></Show>
    <Show when={entries().length} fallback={<p role="status">{listed().isFetching ? "Loading Sessions…" : "No Sessions match."}</p>}><ul class="project-members"><For each={entries()}>{(entry) => {
      const owner = () => projectOf(props.data.groups(), entry.id)
      const unavailable = () => owner() !== undefined && owner()?.detail.id !== props.allowProject
      return <li class="project-pick" data-selected={props.selected === entry.id}><div><strong>{entry.title}</strong><p class="project-meta">{entry.directory}</p><Show when={unavailable()}><p class="project-meta">In {owner()?.detail.name}</p></Show></div><button class="button button--secondary button--small" disabled={unavailable() || props.data.pending() || props.selected === entry.id} aria-label={`${props.label} ${entry.title}`} onClick={() => props.onChoose(entry.id)}>{props.selected === entry.id ? "Selected" : props.label}</button></li>
    }}</For></ul></Show>
  </div>
}

function DirectoryPicker(props: { readonly data: ProjectsData; readonly value: string; readonly onChange: (value: string) => void }) {
  const remote = props.data.remote
  const query = createRemoteQuery(remote.store.queryClient, () => remote.queries.workspaces(remote.scope(), props.data.connected()))
  return <div class="field"><span class="field__label">Directory</span><CustomSelect label="Directory" placeholder="Choose a directory" value={props.value} options={(query().data ?? []).map((entry) => ({ value: entry.id, label: entry.directory }))} onChange={props.onChange} /><Show when={query().isError}><p role="alert">{query().error?.message}</p></Show><p class="field__hint">Choose a directory previously opened on this machine. The Session receives its title from its first conversation.</p></div>
}

function CreateProject(props: { readonly data: ProjectsData }) {
  const data = props.data
  const [name, setName] = createSignal("")
  const [source, setSource] = createSignal<"existing" | "new">("existing")
  const [master, setMaster] = createSignal("")
  const [workspace, setWorkspace] = createSignal("")
  const [created, setCreated] = createSignal<string>()
  const [unconfirmed, setUnconfirmed] = createSignal(false)
  const [error, setError] = createSignal("")
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    const parsed = parseProjectName(name())
    if ("error" in parsed) return setError(parsed.error ?? "Project name is required")
    if (source() === "existing" && !master()) return setError("Choose a master Session")
    if (source() === "new" && !workspace()) return setError("Choose a directory")
    let id = source() === "existing" ? master() : created()
    if (!id) {
      const scope = data.remote.scope()
      if (!scope || data.pending()) return
      data.setPending(true)
      const result = await data.remote.queries.createProjectSession(scope, workspace())
      data.setPending(false)
      if (data.remote.scope()?.deviceID !== scope.deviceID || data.remote.scope()?.generation !== scope.generation) return
      if (!result.reached) { setUnconfirmed(result.unconfirmed === true); data.report(result, ""); return }
      id = result.sessionID
      setCreated(id)
    }
    if (await data.run("coordination.create", createProjectInput(parsed.value!, id), "Project created.")) { data.setCreating(false); data.open(id) }
    else if (data.notice()?.tone === "attention") setUnconfirmed(true)
  }
  return <form class="project-create" onSubmit={(event) => void save(event)}><header class="project-pagehead"><div><h1>New project</h1><p>Name it, then choose the master. Add other Sessions afterwards.</p></div></header><Feedback data={data} />
    <section class="project-step"><h2><span>1</span>Name</h2><label class="field"><span class="field__label">Project name</span><input autofocus class="input" maxLength={120} value={name()} onInput={(event) => setName(event.currentTarget.value)} /></label></section>
    <section class="project-step"><h2><span>2</span>Master</h2><p>The master is an ordinary chat Session. You talk to it; it directs the members.</p><Segmented label="Master source" value={source()} options={[{ id: "existing", label: "Use an existing Session" }, { id: "new", label: "Create a new Session" }]} onChange={setSource} /><Show when={source() === "existing"} fallback={<DirectoryPicker data={data} value={workspace()} onChange={setWorkspace} />}><SessionPicker data={data} selected={master()} onChoose={setMaster} label="Use as master" /></Show></section>
    <Show when={error()}><p class="projects__notice" data-tone="danger" role="alert">{error()}</p></Show><div class="project-actions project-actions--end"><button type="button" class="button button--ghost" onClick={() => data.setCreating(false)}>{unconfirmed() ? "Back to Projects" : "Cancel"}</button><button type="submit" class="button button--primary" disabled={data.pending() || unconfirmed()}>{data.pending() ? "Creating…" : "Create project"}</button></div>
  </form>
}

function LiveState(props: { readonly participant: ParticipantView }) {
  return <span class="project-live" data-state={props.participant.state}><Show when={props.participant.state === "running"} fallback={<span aria-hidden="true">{props.participant.state === "waiting" ? "△" : props.participant.state === "failed" ? "×" : "○"}</span>}><DotTrail /></Show>{liveLabel(props.participant)}</span>
}

export function ProjectPanel(props: { readonly data: ProjectsData; readonly project: ProjectDetail; readonly onManage?: () => HTMLElement | undefined }) {
  const data = props.data
  const [tab, setTab] = createSignal<"sessions" | "settings">("sessions")
  const [removed, setRemoved] = createSignal<ParticipantView>()
  const counts = () => memberCounts(props.project.members)
  const manage = (kind: ProjectDialog["kind"], trigger: HTMLElement, session?: ParticipantView) => {
    const project = props.project
    const returnFocus = props.onManage?.() ?? trigger
    data.setDialog({ kind, project, trigger: returnFocus, session })
  }
  const remove = async (entry: ParticipantView) => { if (await data.run("coordination.update", removeMemberInput(props.project, entry.sessionID), `${entry.title} removed. The Session keeps running and keeps its history.`)) setRemoved(entry) }
  return <section class="project-panel" aria-label="Project panel"><div class="project-tabs" role="tablist" aria-label="Project panel"><For each={["sessions", "settings"] as const}>{(value, index) => <button class="project-tab" role="tab" aria-selected={tab() === value} tabIndex={tab() === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={(event) => moveRadio(event, index(), 2, (next) => setTab(next === 0 ? "sessions" : "settings"))}>{value === "sessions" ? <>Sessions <span>{props.project.members.length + 1}</span></> : "Settings"}</button>}</For></div>
    <div class="project-panel__body" role="tabpanel"><Feedback data={data} /><Show when={tab() === "sessions"} fallback={<ProjectSettings data={data} project={props.project} onMaster={(trigger) => manage("master", trigger)} onMembers={() => setTab("sessions")} />}>
      <div class="project-summary"><div class="project-actions"><For each={["running", "waiting", "idle", "failed"] as const}>{(state) => <span class="project-live" data-state={state}><span aria-hidden="true">{state === "running" ? "●" : state === "waiting" ? "△" : state === "failed" ? "×" : "○"}</span>{counts()[state]} {state}</span>}</For></div><Meter project={props.project} /><Sparkline project={props.project} now={data.now()} /></div>
      <div class="project-actions"><button class="button button--primary button--small" disabled={data.pending() || props.project.members.length >= maxMembers} onClick={(event) => manage("new", event.currentTarget)}><Icon name="plus" size={16} />New session…</button><button class="button button--secondary button--small" disabled={data.pending() || props.project.members.length >= maxMembers} onClick={(event) => manage("add", event.currentTarget)}><Icon name="plus" size={16} />Add session…</button></div>
      <Show when={removed()}>{(entry) => <button class="button button--ghost button--small" disabled={data.pending()} onClick={async () => { if (await data.run("coordination.update", addMemberInput(props.project, entry().sessionID), "Session restored to the Project.")) setRemoved(undefined) }}>Undo removal of {entry().title}</button>}</Show>
      <ul class="project-members" aria-label={`Sessions in ${props.project.name}`}><For each={[props.project.master, ...props.project.members]}>{(entry) => {
        const master = () => entry.sessionID === props.project.master.sessionID
        return <li class="project-member" data-master={master()} data-state={entry.state}><div class="project-member__head"><strong>{entry.title}</strong><span class={`project-badge${master() ? " project-badge--master" : ""}`}>{master() ? "Master" : "Member"}</span></div><div class="project-actions"><LiveState participant={entry} /><span class="project-meta">{ageLabel(entry, data.now())}</span></div><Show when={entry.drivenBy}>{(driver) => <p class="project-meta">driven by <b>{driver().title}</b> · master subagent</p>}</Show><Show when={entry.pending[0]?.summary}><p class="project-member__ask">{entry.pending[0]?.summary}</p></Show><p class="project-meta">{entry.directory}</p><div class="project-member__actions"><button class={`button button--${entry.state === "waiting" ? "primary" : "secondary"} button--small`} aria-label={`Open session ${entry.title}`} onClick={() => { props.onManage?.(); data.open(entry.sessionID) }}>Open session<Icon name="chevron-right" size={16} /></button><Show when={!master()}><button class="button button--ghost button--small" disabled={data.pending()} aria-label={`Remove ${entry.title} from project`} onClick={() => void remove(entry)}>Remove</button><button class="button button--danger button--small" disabled={data.pending()} aria-label={`Delete session ${entry.title}`} onClick={(event) => manage("delete-session", event.currentTarget, entry)}>Delete…</button></Show></div></li>
      }}</For></ul>
    </Show><ProjectFreshness data={data} /></div>
  </section>
}

function ProjectSettings(props: { readonly data: ProjectsData; readonly project: ProjectDetail; readonly onMaster: (trigger: HTMLElement) => void; readonly onMembers: () => void }) {
  const data = props.data
  const [name, setName] = createSignal(props.project.name)
  const [capped, setCapped] = createSignal(props.project.settings.concurrency !== null)
  const [limit, setLimit] = createSignal(String(props.project.settings.concurrency ?? 1))
  const current = props.project.settings.delegatedDecisions
  const [narrow, setNarrow] = createSignal(current !== undefined)
  const [categories, setCategories] = createSignal<readonly DelegatedCategory[]>(current?.categories ?? data.ready()?.central?.categories ?? [])
  const [actions, setActions] = createSignal(current?.actions?.join("\n") ?? "")
  const [resources, setResources] = createSignal(current?.resources?.join("\n") ?? "")
  const [expiry, setExpiry] = createSignal<ExpiryChoice | "keep">(current?.expiresAt === undefined ? "none" : "keep")
  const [error, setError] = createSignal("")
  const saveLimit = () => {
    const parsed = capped() ? parseConcurrency(limit()) : { value: null }
    if ("error" in parsed) return setError(parsed.error ?? "Invalid concurrency")
    setError("")
    void data.run("coordination.update", settingsInput(props.project, { ...props.project.settings, concurrency: parsed.value! }), "Concurrency updated.")
  }
  const saveDelegation = () => {
    const a = parseList(actions(), { limit: 32, length: 512, noun: "action" })
    const r = parseList(resources(), { limit: 32, length: 512, noun: "resource" })
    if ("error" in a || "error" in r) return setError("error" in a ? a.error : "error" in r ? r.error : "Invalid patterns")
    const expires = expiry() === "keep" ? current?.expiresAt : expiryAt(expiry() as ExpiryChoice, Date.now())
    const delegated = { categories: categories(), ...(a.value.length ? { actions: a.value } : {}), ...(r.value.length ? { resources: r.value } : {}), ...(expires === undefined ? {} : { expiresAt: expires }) }
    const issue = narrow() ? delegationDraftIssue(data.ready()?.central, delegated, Date.now()) : undefined
    if (issue) return setError(issue)
    setError("")
    void data.run("coordination.update", settingsInput(props.project, { concurrency: props.project.settings.concurrency, ...(narrow() ? { delegatedDecisions: delegated } : {}) }), "Delegated decisions updated.")
  }
  return <div class="project-settings"><section class="project-setting"><h3>Name</h3><form onSubmit={(event) => { event.preventDefault(); const parsed = parseProjectName(name()); if ("error" in parsed) setError(parsed.error ?? "Invalid name"); else void data.run("coordination.update", renameInput(props.project, parsed.value!), "Project name updated.") }}><label class="field"><span class="field__label">Project name</span><input class="input" value={name()} maxLength={120} onInput={(event) => setName(event.currentTarget.value)} /></label><button class="button button--secondary button--small" disabled={data.pending() || name() === props.project.name}>Save name</button></form></section>
    <section class="project-setting"><h3>Master</h3><div class="project-actions"><span class="project-badge project-badge--master">Master</span><strong>{props.project.master.title}</strong></div><button class="button button--secondary button--small" onClick={(event) => props.onMaster(event.currentTarget)}>Change master…</button><p class="field__hint">Choosing another master keeps {props.project.master.title} as an ordinary member.</p></section>
    <section class="project-setting"><h3>Members</h3><p>{props.project.members.length + 1} Sessions, including the Master.</p><button class="button button--secondary button--small" onClick={props.onMembers}>Manage Sessions</button></section>
    <section class="project-setting"><h3>Concurrency limit</h3><Segmented label="Concurrency limit" value={capped() ? "limit" : "none"} options={[{ id: "none", label: "No limit" }, { id: "limit", label: "Set a limit" }]} onChange={(value) => setCapped(value === "limit")} /><Show when={capped()}><label class="field"><span class="field__label">Members running at once</span><input class="input" inputMode="numeric" value={limit()} onInput={(event) => setLimit(event.currentTarget.value)} /></label></Show><p class="field__hint">When the limit is reached the master cannot message an idle member.</p><button class="button button--secondary button--small" disabled={data.pending()} onClick={saveLimit}>Save concurrency</button></section>
    <section class="project-setting"><h3>Delegated decisions</h3><p class="field__hint">{centralPolicyNote(data.ready()?.central)}</p><Segmented label="Delegation" value={narrow() ? "narrow" : "inherit"} disabled={!data.ready()?.central?.enabled} options={[{ id: "inherit", label: "Inherit central policy" }, { id: "narrow", label: "Narrow for this project" }]} onChange={(value) => setNarrow(value === "narrow")} /><Show when={narrow()}><div class="project-switches"><For each={delegatedCategories}>{(category) => <label class="switch"><input type="checkbox" checked={categories().includes(category)} disabled={!data.ready()?.central?.categories.includes(category)} onChange={() => setCategories(categories().includes(category) ? categories().filter((entry) => entry !== category) : [...categories(), category])} /><span>{category}</span></label>}</For></div><label class="field"><span class="field__label">Action patterns</span><textarea class="textarea" rows={2} value={actions()} onInput={(event) => setActions(event.currentTarget.value)} /></label><label class="field"><span class="field__label">Resource patterns</span><textarea class="textarea" rows={2} value={resources()} onInput={(event) => setResources(event.currentTarget.value)} /></label><CustomSelect label="Expires" placeholder="No expiry" value={expiry()} options={[...(current?.expiresAt === undefined ? [] : [{ value: "keep", label: "Keep current expiry" }]), ...expiryChoices.map((entry) => ({ value: entry.id, label: entry.label }))]} onChange={(value) => setExpiry(value as ExpiryChoice | "keep")} /></Show><p class="field__hint">Hard reviews always reach you. Effective categories: {effectiveDelegation(data.ready()?.central, props.project.settings.delegatedDecisions).categories.join(", ") || "none"}.</p><button class="button button--secondary button--small" disabled={data.pending() || !data.ready()?.central?.enabled} onClick={saveDelegation}>Save delegation</button></section>
    <NotificationFilter data={data} /><Show when={error()}><p class="projects__notice" data-tone="danger" role="alert">{error()}</p></Show>
  </div>
}

const categoryLabels: Record<ExternalKind, string> = { question: "Questions", permission: "Permission requests", review: "Guardrail reviews", failure: "Failures", completion: "Completion" }

function NotificationFilter(props: { readonly data: ProjectsData }) {
  const data = props.data
  const filter = () => data.remote.state().notificationFilter
  const masters = () => data.ready()?.groups.map((group) => ({ sessionID: group.detail.master.sessionID, title: group.detail.master.title }))
  const [status, setStatus] = createSignal("")
  const apply = async (next: ReturnType<typeof filter>) => {
    if (!data.remote.store.setNotificationFilter(next)) setStatus("Saved for this tab only. Browser storage refused the change.")
    if (typeof Notification === "undefined" || Notification.permission !== "granted") { setStatus("Saved. System alerts are not allowed in this browser yet."); return }
    const result = await savePushCategories(browserPushPlatform(), createPushHttp(), () => pushCategoriesFor(readNotificationPreferences()), () => pushFilterWire(filter()))
    setStatus(result.status === "on" ? "Push alerts now follow this filter." : result.status === "off" ? "Saved. No push subscription on this device." : result.message ?? "Push alerts could not be updated.")
  }
  return <section class="project-setting"><h3>Notifications</h3><p class="field__hint">Applies to external alerts in this browser, across Projects. In-app notices and pending requests remain visible.</p><Segmented label="Notification scope" value={filter().scope} options={[{ id: "all", label: "All sessions (default)" }, { id: "coordinators", label: "All masters" }, { id: "selected", label: "Selected masters" }]} onChange={(scope) => void apply(setScope(filter(), scope))} /><p class="field__hint">{filterLabel(filter(), masters())}</p><Show when={filter().scope === "selected"}><div class="project-switches" role="group" aria-label="Selected masters"><For each={masters() ?? []}>{(entry) => <label class="switch"><input type="checkbox" checked={filter().sessionIDs?.includes(entry.sessionID)} onChange={() => void apply(toggleMaster(filter(), entry.sessionID))} /><span>{entry.title}</span></label>}</For></div></Show><div class="project-switches" role="group" aria-label="Notification categories"><For each={externalKinds}>{(kind) => <label class="switch"><input type="checkbox" checked={filter().categories === undefined || filter().categories!.includes(kind)} onChange={() => void apply(toggleCategory(filter(), kind))} /><span>{categoryLabels[kind]}</span></label>}</For></div><p role="status" class="field__hint">{status()}</p></section>
}

export function ProjectsDialogs(props: { readonly data: ProjectsData }) {
  const data = props.data
  return <Show when={data.dialog()} keyed>{(entry) => {
    let close: (() => void) | undefined
    const [workspace, setWorkspace] = createSignal("")
    const [created, setCreated] = createSignal<string>()
    const [unconfirmed, setUnconfirmed] = createSignal(false)
    const [error, setError] = createSignal("")
    const label = entry.kind === "delete-project" ? "Delete project" : entry.kind === "delete-session" ? "Delete Session" : entry.kind === "new" ? "New session in this project" : entry.kind === "master" ? "Change master" : "Add an existing Session"
    const choose = async (id: string) => {
      try {
        const input = entry.kind === "master" ? changeMasterInput(entry.project, id) : addMemberInput(entry.project, id)
        if (await data.run("coordination.update", input, entry.kind === "master" ? "Master changed. The previous Master remains a member." : "Session added.")) close?.()
      } catch (cause) { setError(cause instanceof Error ? cause.message : "The Session could not be added.") }
    }
    const create = async () => {
      if (!workspace()) return setError("Choose a directory")
      let id = created()
      if (!id) {
        const scope = data.remote.scope()
        if (!scope || data.pending()) return
        data.setPending(true)
        const result = await data.remote.queries.createProjectSession(scope, workspace())
        data.setPending(false)
        if (data.remote.scope()?.deviceID !== scope.deviceID || data.remote.scope()?.generation !== scope.generation) return
        if (!result.reached) { setUnconfirmed(result.unconfirmed === true); data.report(result, ""); return }
        id = result.sessionID
        setCreated(id)
      }
      await choose(id)
    }
    const remove = async () => {
      if (entry.kind === "delete-project") { if (await data.run("coordination.delete", { groupID: entry.project.id }, "Project deleted. Its Sessions keep running and keep their histories.")) close?.(); return }
      const scope = data.remote.scope()
      if (!scope || !entry.session || data.pending()) return
      data.setPending(true)
      const result = await data.remote.queries.deleteProjectSession(scope, entry.session.sessionID)
      data.setPending(false)
      if (data.report(result, "Session deleted.")) close?.()
    }
    return <Modal label={label} class="overlay--confirm project-dialog" returnFocus={entry.trigger} onClose={() => data.setDialog(undefined)} requestClose={(handler) => { close = handler }}><Feedback data={data} />
      <Show when={entry.kind === "add" || entry.kind === "master"}><SessionPicker data={data} allowProject={entry.kind === "master" ? entry.project.id : undefined} selected={entry.kind === "master" ? entry.project.master.sessionID : undefined} onChoose={(id) => void choose(id)} label={entry.kind === "master" ? "Use as master" : "Add"} /></Show>
      <Show when={entry.kind === "new"}><DirectoryPicker data={data} value={workspace()} onChange={setWorkspace} /><p>Creates the Session and adds it as a member.</p></Show>
      <Show when={entry.kind === "delete-project"}><p>Delete <strong>{entry.project.name}</strong>? Its Master and member Sessions keep running and keep their histories.</p></Show>
      <Show when={entry.kind === "delete-session"}><p>Delete <strong>{entry.session?.title}</strong> permanently? This stops any running turn and deletes the Session and its history. It cannot be undone.</p></Show>
      <Show when={error()}><p class="projects__notice" data-tone="danger" role="alert">{error()}</p></Show><div class="project-actions project-actions--end"><button class="button button--secondary" onClick={() => close?.()}>Cancel</button><Show when={entry.kind === "new"}><button class="button button--primary" disabled={data.pending() || unconfirmed()} onClick={() => void create()}>{data.pending() ? "Creating…" : created() ? "Add created Session" : "Create and add"}</button></Show><Show when={entry.kind === "delete-project" || entry.kind === "delete-session"}><button class="button button--danger" disabled={data.pending()} onClick={() => void remove()}>{data.pending() ? "Deleting…" : label}</button></Show></div>
    </Modal>
  }}</Show>
}
