import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import { Modal } from "../../ui/modal"
import { useRemote } from "../context"
import {
  assignRole,
  capacitySummary,
  centralPolicyNote,
  createGroupInput,
  delegatedCategories,
  delegationDraftIssue,
  effectiveDelegation,
  expiryAt,
  expiryChoices,
  externalKinds,
  FILTER_STORAGE_KEY,
  filterLabel,
  formatBudget,
  isDefaultFilter,
  leaseLine,
  lifecycleActions,
  maxCoordinatorSelection,
  maxScopes,
  maxTools,
  membersInput,
  parseBudget,
  parseConcurrency,
  parseGroupName,
  parseList,
  parseQueueCapacity,
  pushFilterWire,
  queueItems,
  receiptLine,
  removeMember,
  roles,
  rosterIssue,
  selectionLines,
  sessionLabel,
  setScope,
  statusLabel,
  toggleCategory,
  toggleCoordinator,
  type CentralPolicy,
  type CoordinationRole,
  type CoordinationStatus,
  type DelegatedCategory,
  type ExpiryChoice,
  type ExternalKind,
  type LifecycleActionID,
  type MemberView,
  type NotificationFilter,
  type NotificationScope,
  type PolicyView,
  type SelectionView,
} from "../coordination"
import { createPushHttp } from "../http"
import { pushCategoriesFor, readNotificationPreferences } from "../preferences"
import { browserPushPlatform, savePushCategories } from "../push"
import { createRemoteQuery } from "../query"
import type { CoordinationBundle, CoordinationOperation, CoordinationOverview } from "../queries"
import { moveRadio } from "./settings"
import "./projects.css"

type View =
  | { readonly type: "list" }
  | { readonly type: "detail"; readonly id: string }
  | { readonly type: "edit"; readonly id?: string }
  | { readonly type: "policy"; readonly id: string }

type Notice = { readonly tone: "danger" | "attention" | "success"; readonly text: string }
type Change = (label: string, operation: CoordinationOperation, input: Readonly<Record<string, unknown>>, success: string) => Promise<boolean>

const categoryLabels: Readonly<Record<ExternalKind, string>> = { question: "Questions", permission: "Permission requests", review: "Guardrail reviews", failure: "Failures", completion: "Completion" }
const delegatedLabels: Readonly<Record<DelegatedCategory, string>> = { question: "Questions", permission: "Permission requests", review: "Guardrail reviews" }
const roleLabels: Readonly<Record<CoordinationRole, string>> = { coordinator: "Coordinator", worker: "Worker", observer: "Observer" }
const sessionIDPattern = /^ses_[A-Za-z0-9_-]{1,92}$/

function statusTone(status: CoordinationStatus) {
  return status === "armed" || status === "waiting" ? " chip--success" : status === "stopped" || status === "needs-rearm" ? " chip--attention" : ""
}

export function ProjectsPage(): JSX.Element {
  const remote = useRemote()
  const connected = () => remote.state().transport.kind === "open" && remote.state().connection.kind === "connected"
  const query = createRemoteQuery(remote.store.queryClient, () => remote.queries.coordination(remote.scope(), connected()))
  const overview = (): CoordinationOverview | undefined => query().data
  const ready = () => { const value = overview(); return value?.status === "ready" ? value : undefined }
  const groups = () => ready()?.groups ?? []
  const sessions = () => remote.state().sessions.filter((session) => session.parentID === undefined && !session.archived)
  const titles = createMemo(() => new Map(remote.state().sessions.map((session) => [session.id, session.title] as const)))
  const title = (id: string) => sessionLabel(id, titles())
  const [view, setView] = createSignal<View>({ type: "list" })
  const [pending, setPending] = createSignal<string>()
  const [notice, setNotice] = createSignal<Notice>()
  let page: HTMLDivElement | undefined

  const change: Change = async (label, operation, input, success) => {
    const scope = remote.scope()
    if (pending() !== undefined || scope === undefined) return false
    setPending(label)
    setNotice(undefined)
    const result = await remote.queries.changeCoordination(scope, operation, input)
    setPending(undefined)
    if (result.reached) {
      setNotice({ tone: "success", text: success })
      return true
    }
    setNotice({ tone: result.unconfirmed ? "attention" : "danger", text: result.message })
    return false
  }

  const refresh = () => {
    const scope = remote.scope()
    if (scope !== undefined) void remote.queries.refreshCoordination(scope)
  }

  const go = (next: View, keepNotice = false) => {
    if (!keepNotice) setNotice(undefined)
    setView(next)
  }

  createEffect(on(view, () => queueMicrotask(() => page?.querySelector<HTMLElement>("[data-projects-heading]")?.focus({ preventScroll: true })), { defer: true }))

  return <div class="projects" ref={page}>
    <div class="page-head">
      <div>
        <h1 class="page-head__title">Projects</h1>
        <p class="page-head__support">Local coordination groups: one coordinator Session directs worker Sessions. Not repository workspaces.</p>
      </div>
      <Show when={view().type === "list" && ready() !== undefined}>
        <button type="button" class="button button--primary button--small page-head__action" onClick={() => go({ type: "edit" })}><Icon name="plus" size={16} />New project</button>
      </Show>
    </div>
    <div class="pane" style={{ "padding-inline": "0" }}>
      <div class="settings projects__stack">
        <p class="projects__live visually-hidden" role="status" aria-live="polite">{pending() === undefined ? "" : "Working…"}</p>
        <Show when={notice()}>{(current) => <p class="projects__notice" data-tone={current().tone} role={current().tone === "danger" ? "alert" : "status"}>{current().text}</p>}</Show>
        <Show when={connected()} fallback={<Unavailable text="Projects need a connected machine. Connect one in Settings, then return here." />}>
          <Show when={overview()?.status !== "unsupported"} fallback={<Unavailable text="This machine does not offer Projects yet. Update YCoding on it, then reload." />}>
            <Show when={ready()} fallback={<Loading message={query().isError ? query().error?.message : undefined} retry={refresh} />}>
              <Show when={query().isError}><p class="projects__notice" data-tone="danger" role="alert">{query().error?.message ?? "Projects could not be refreshed."} <button type="button" class="button button--ghost button--small" onClick={refresh}>Retry</button></p></Show>
              <Show when={view()} keyed>
                {(current) => {
                  if (current.type === "list") return <ProjectList groups={groups} title={title} open={(id) => go({ type: "detail", id })} refresh={refresh} refreshing={() => query().isFetching} />
                  const back = (keepNotice = false) => go(current.type === "edit" && current.id === undefined ? { type: "list" } : { type: "detail", id: current.id! }, keepNotice)
                  if (current.type === "edit" && current.id === undefined)
                    return <Editor bundle={() => undefined} title={title} sessions={sessions} pending={pending} change={change} done={() => go({ type: "list" }, true)} cancel={() => go({ type: "list" })} />
                  return <Show when={groups().find((group) => group.summary.id === current.id)} fallback={<Missing back={() => go({ type: "list" })} />}>{(found) =>
                    current.type === "detail"
                      ? <Detail bundle={found} central={() => ready()?.central} title={title} pending={pending} change={change} edit={() => go({ type: "edit", id: current.id })} policy={() => go({ type: "policy", id: current.id })} back={() => go({ type: "list" })} />
                      : current.type === "policy"
                        ? <PolicyEditor bundle={found} central={() => ready()?.central} pending={pending} change={change} done={(saved) => back(saved)} />
                        : <Editor bundle={found} title={title} sessions={sessions} pending={pending} change={change} done={() => back(true)} cancel={() => back()} />
                  }</Show>
                }}
              </Show>
            </Show>
          </Show>
        </Show>
        <Show when={view().type === "list"}><FilterSection groups={() => ready()?.groups} title={title} /></Show>
      </div>
    </div>
  </div>
}

function Unavailable(props: { readonly text: string }): JSX.Element {
  return <section class="settings__section"><p class="projects__empty" role="status">{props.text}</p></section>
}

function Loading(props: { readonly message?: string; readonly retry: () => void }): JSX.Element {
  return <section class="settings__section" aria-busy={props.message === undefined}>
    <Show when={props.message} fallback={<p class="projects__empty" role="status">Loading projects…</p>}>
      <p class="projects__notice" data-tone="danger" role="alert">{props.message}</p>
      <button type="button" class="button button--secondary button--small" onClick={props.retry}>Retry</button>
    </Show>
  </section>
}

function Missing(props: { readonly back: () => void }): JSX.Element {
  return <section class="settings__section">
    <h2 class="projects__heading" tabindex="-1" data-projects-heading>This project no longer exists</h2>
    <button type="button" class="button button--secondary button--small" onClick={props.back}>Back to projects</button>
  </section>
}

function SectionHead(props: { readonly id: string; readonly category: string; readonly title: string; readonly hint?: string; readonly heading?: boolean }): JSX.Element {
  return <div class="settings__head">
    <p class="settings__category">{props.category}</p>
    <h2 id={props.id} class="projects__heading" tabindex={props.heading ? "-1" : undefined} data-projects-heading={props.heading ? "" : undefined}>{props.title}</h2>
    <Show when={props.hint}><p class="settings__hint">{props.hint}</p></Show>
  </div>
}

function ProjectList(props: { readonly groups: () => readonly CoordinationBundle[]; readonly title: (id: string) => string; readonly open: (id: string) => void; readonly refresh: () => void; readonly refreshing: () => boolean }): JSX.Element {
  const ids = createMemo(() => props.groups().map((group) => group.summary.id))
  const bundle = (id: string) => props.groups().find((group) => group.summary.id === id)!
  return <section class="settings__section" aria-labelledby="projects-list-title">
    <SectionHead id="projects-list-title" category="Coordination" title="Your projects" heading hint="Each project arms a coordinator Session to dispatch work to its workers under a shared policy." />
    <div class="projects__toolbar">
      <button type="button" class="button button--ghost button--small" disabled={props.refreshing()} onClick={props.refresh}><Icon name="refresh" size={16} />{props.refreshing() ? "Refreshing…" : "Refresh"}</button>
    </div>
    <Show when={ids().length > 0} fallback={<p class="projects__empty" role="status">No coordination groups</p>}>
      <ul class="project-list" role="list" aria-label="Projects">
        <For each={ids()}>{(id) => {
          const coordinator = () => bundle(id).detail.members.find((member) => member.role === "coordinator")
          return <li class="project-card" data-project-id={id}>
            <div class="project-card__head">
              <h3 class="project-card__name" title={bundle(id).summary.name}>{bundle(id).summary.name}</h3>
              <span class={`chip${statusTone(bundle(id).summary.status)}`}>{statusLabel(bundle(id).summary.status)}</span>
            </div>
            <p class="project-card__meta">{capacitySummary({ active: bundle(id).capacity.active, hardLimit: bundle(id).capacity.hardLimit, concurrency: bundle(id).summary.policy.concurrency })}</p>
            <p class="project-card__meta">{bundle(id).summary.memberCount} {bundle(id).summary.memberCount === 1 ? "Session" : "Sessions"}<Show when={coordinator()}>{(lead) => <> · coordinator {props.title(lead().sessionID)}</>}</Show></p>
            <div class="project-actions"><button type="button" class="button button--secondary button--small" aria-label={`Open ${bundle(id).summary.name}`} onClick={() => props.open(id)}>Open<Icon name="chevron-right" size={16} /></button></div>
          </li>
        }}</For>
      </ul>
    </Show>
  </section>
}

function Detail(props: {
  readonly bundle: () => CoordinationBundle
  readonly central: () => CentralPolicy | undefined
  readonly title: (id: string) => string
  readonly pending: () => string | undefined
  readonly change: Change
  readonly edit: () => void
  readonly policy: () => void
  readonly back: () => void
}): JSX.Element {
  const [confirming, setConfirming] = createSignal<{ readonly trigger: HTMLElement }>()
  const detail = () => props.bundle().detail
  const now = () => Date.now()
  const busy = () => props.pending() !== undefined
  const run = (id: LifecycleActionID) => {
    const input = { groupID: detail().id, revision: detail().revision }
    if (id === "arm" || id === "rearm") return props.change(id, "coordination.arm", input, id === "arm" ? "Project armed." : "Project re-armed.")
    if (id === "stop") return props.change(id, "coordination.stop", input, "Dispatch stopped. Running workers keep running.")
    return props.change(id, "coordination.complete", input, "Project completed.")
  }
  const delegation = () => effectiveDelegation(props.central(), detail().policy.delegatedDecisions)
  return <>
    <section class="settings__section" aria-labelledby="project-title">
      <div class="projects__bar"><button type="button" class="button button--ghost button--small" onClick={props.back}><Icon name="arrow-left" size={16} />Back to projects</button></div>
      <SectionHead id="project-title" category="Project" title={detail().name} heading />
      <p class="project-card__meta"><span class={`chip${statusTone(detail().status)}`}>{statusLabel(detail().status)}</span> {capacitySummary({ active: props.bundle().capacity.active, hardLimit: props.bundle().capacity.hardLimit, concurrency: detail().policy.concurrency })}</p>
      <div class="project-actions" role="group" aria-label="Lifecycle">
        <For each={lifecycleActions(detail().status)}>{(action) =>
          <button type="button" class={`button button--small ${action.id === "complete" ? "button--danger" : "button--secondary"}`} disabled={busy()}
            onClick={(event) => { if (action.id === "complete") setConfirming({ trigger: event.currentTarget }); else void run(action.id) }}>{props.pending() === action.id ? "Working…" : action.title}</button>
        }</For>
        <button type="button" class="button button--ghost button--small" disabled={busy()} onClick={props.edit}>Edit name and roster</button>
        <button type="button" class="button button--ghost button--small" disabled={busy()} onClick={props.policy}>Edit policy</button>
      </div>
    </section>
    <Show when={confirming()} keyed>{(entry) => {
      let close: (() => void) | undefined
      return <Modal class="overlay--confirm" label="Complete project" returnFocus={entry.trigger} onClose={() => setConfirming((current) => current === entry ? undefined : current)} requestClose={(handoff) => { close = handoff }}>
        <p>Complete {detail().name}? Completed projects cannot be re-armed. Running workers are not cancelled.</p>
        <div class="projects__confirm">
          <button type="button" class="button button--secondary" onClick={() => close?.()}>Cancel</button>
          <button type="button" class="button button--danger" data-confirm-complete disabled={busy()} onClick={() => void run("complete").then(() => close?.())}>{props.pending() === "complete" ? "Working…" : "Complete project"}</button>
        </div>
      </Modal>
    }}</Show>
    <section class="settings__section" aria-labelledby="project-roster-title">
      <SectionHead id="project-roster-title" category="Roster" title="Sessions and roles" hint="Roles are the recorded assignment. They are not evidence that the runtime enforces them." />
      <ul class="project-members" role="list">
        <For each={detail().members}>{(member) => <li class="project-member">
          <span class="project-member__name" title={member.sessionID}>{props.title(member.sessionID)}</span>
          <span class="chip">{roleLabels[member.role]}</span>
          <span class="project-member__limits">{member.allowedTools === undefined || member.allowedTools.length === 0 ? "No tool limit recorded" : `Tools: ${member.allowedTools.join(", ")}`} · {member.resourceScopes === undefined || member.resourceScopes.length === 0 ? "No scope limit recorded" : `Scopes: ${member.resourceScopes.join(", ")}`}</span>
        </li>}</For>
      </ul>
    </section>
    <section class="settings__section" aria-labelledby="project-queue-title">
      <SectionHead id="project-queue-title" category="Queue" title="Waiting work" />
      <Show when={queueItems(detail(), props.title).length > 0} fallback={<p class="projects__empty">Queue is empty</p>}>
        <ul class="project-lines" role="list"><For each={queueItems(detail(), props.title)}>{(item) => <li>{item.target} · {item.reason}<SelectionNote selection={item.selection} /></li>}</For></ul>
      </Show>
    </section>
    <section class="settings__section" aria-labelledby="project-policy-title">
      <SectionHead id="project-policy-title" category="Policy" title="Limits and delegation" />
      <div class="defs">
        <div class="defs__row"><span class="defs__key">Concurrency</span><span class="defs__value">{detail().policy.concurrency === null ? `uncapped policy · hard limit ${props.bundle().capacity.hardLimit === null ? "unreported" : `${props.bundle().capacity.hardLimit} applies`}` : detail().policy.concurrency}</span></div>
        <div class="defs__row"><span class="defs__key">Queue capacity</span><span class="defs__value">{detail().policy.queueCapacity}</span></div>
        <div class="defs__row"><span class="defs__key">Budget</span><span class="defs__value">{detail().policy.budget === undefined ? "none" : formatBudget(detail().policy.budget!)}</span></div>
        <div class="defs__row"><span class="defs__key">Delegated decisions</span><span class="defs__value" data-delegation={delegation().state}>{delegationSummary(delegation())}</span></div>
      </div>
    </section>
    <section class="settings__section" aria-labelledby="project-leases-title">
      <SectionHead id="project-leases-title" category="Leases" title="Active leases" />
      <Show when={detail().claims.filter((claim) => claim.status === "active").length > 0} fallback={<p class="projects__empty">No active leases</p>}>
        <ul class="project-lines" role="list"><For each={detail().claims.filter((claim) => claim.status === "active")}>{(claim) => <li>{leaseLine(claim, props.title, now())}</li>}</For></ul>
      </Show>
    </section>
    <section class="settings__section" aria-labelledby="project-receipts-title">
      <SectionHead id="project-receipts-title" category="Receipts" title="Dispatch receipts" />
      <Show when={props.bundle().receipts.length > 0} fallback={<p class="projects__empty">No dispatch receipts</p>}>
        <ul class="project-lines" role="list"><For each={props.bundle().receipts}>{(receipt) => <li>{receiptLine(receipt, props.title, now())}<SelectionNote selection={receipt.selection} /></li>}</For></ul>
      </Show>
    </section>
  </>
}

function SelectionNote(props: { readonly selection: SelectionView | undefined }): JSX.Element {
  const lines = () => selectionLines(props.selection)
  return <span class="project-selection" data-selection={props.selection === undefined ? "unreported" : "reported"}>
    <span class="project-selection__choice">{lines().choice}</span>
    <Show when={lines().reason}>{(reason) => <span class="project-selection__reason">Reason: {reason()}</span>}</Show>
  </span>
}

function delegationSummary(delegation: ReturnType<typeof effectiveDelegation>) {
  if (delegation.state === "unavailable") return "Central policy unavailable; group narrowing cannot be checked"
  if (delegation.state === "revoked") return "Revoked: central policy is off for every group"
  const parts = [delegation.categories.length === 0 ? "no decision category" : delegation.categories.map((category) => delegatedLabels[category].toLowerCase()).join(", ")]
  if (delegation.actions !== undefined) parts.push(`actions ${delegation.actions.join(", ")}`)
  if (delegation.resources !== undefined) parts.push(`resources ${delegation.resources.join(", ")}`)
  if (delegation.expiresAt !== undefined) parts.push(`expires ${new Date(delegation.expiresAt).toLocaleString()}`)
  return `${delegation.state === "inherited" ? "Inherits central policy" : "Narrowed"}: ${parts.join(" · ")}`
}

type DraftMember = { readonly sessionID: string; readonly role: CoordinationRole; readonly tools: string; readonly scopes: string }

function Editor(props: {
  readonly bundle: () => CoordinationBundle | undefined
  readonly title: (id: string) => string
  readonly sessions: () => readonly { readonly id: string; readonly title: string }[]
  readonly pending: () => string | undefined
  readonly change: Change
  readonly done: (created: boolean) => void
  readonly cancel: () => void
}): JSX.Element {
  const existing = props.bundle()?.detail
  const [name, setName] = createSignal(existing?.name ?? "")
  const [members, setMembers] = createSignal<readonly DraftMember[]>(existing?.members.map((member) => ({ sessionID: member.sessionID, role: member.role, tools: (member.allowedTools ?? []).join(", "), scopes: (member.resourceScopes ?? []).join("\n") })) ?? [])
  const [search, setSearch] = createSignal("")
  const [byID, setByID] = createSignal("")
  const [error, setError] = createSignal<string>()
  const ids = createMemo(() => members().map((member) => member.sessionID))
  const member = (id: string) => members().find((entry) => entry.sessionID === id)!
  const patch = (id: string, change: Partial<DraftMember>) => setMembers(members().map((entry) => entry.sessionID === id ? { ...entry, ...change } : entry))
  const setRole = (id: string, role: CoordinationRole) => {
    const next = assignRole(members().map((entry) => ({ sessionID: entry.sessionID, role: entry.role })), { sessionID: id }, role)
    setMembers(members().map((entry) => ({ ...entry, role: next.find((candidate) => candidate.sessionID === entry.sessionID)!.role })))
  }
  const add = (id: string) => {
    if (ids().includes(id)) return
    setError(undefined)
    setMembers([...members(), { sessionID: id, role: members().some((entry) => entry.role === "coordinator") ? "worker" : "coordinator", tools: "", scopes: "" }])
  }
  const remove = (id: string) => {
    const result = removeMember(members().map((entry) => ({ sessionID: entry.sessionID, role: entry.role })), id)
    if ("error" in result) return setError(result.error)
    setError(undefined)
    setMembers(members().filter((entry) => entry.sessionID !== id))
  }
  const addByID = () => {
    const id = byID().trim()
    if (!sessionIDPattern.test(id)) return setError("Enter a Session ID that starts with ses_")
    add(id)
    setByID("")
  }
  const candidates = createMemo(() => props.sessions().filter((session) => !ids().includes(session.id) && `${session.title} ${session.id}`.toLowerCase().includes(search().trim().toLowerCase())).slice(0, 8))
  const draftRoster = (): { readonly roster: MemberView[] } | { readonly error: string } => {
    const roster: MemberView[] = []
    for (const entry of members()) {
      const tools = parseList(entry.tools, { limit: maxTools, length: 128, noun: "tool" })
      if ("error" in tools) return { error: `${props.title(entry.sessionID)}: ${tools.error}` }
      const scopes = parseList(entry.scopes, { limit: maxScopes, length: 512, noun: "scope" })
      if ("error" in scopes) return { error: `${props.title(entry.sessionID)}: ${scopes.error}` }
      roster.push({ sessionID: entry.sessionID, role: entry.role, ...(tools.value.length === 0 ? {} : { allowedTools: tools.value }), ...(scopes.value.length === 0 ? {} : { resourceScopes: scopes.value }) })
    }
    return { roster }
  }
  const issue = () => { const parsed = draftRoster(); return "error" in parsed ? parsed.error : rosterIssue(parsed.roster) }
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    const parsedName = parseGroupName(name())
    if ("error" in parsedName) return setError(parsedName.error)
    const parsed = draftRoster()
    if ("error" in parsed) return setError(parsed.error)
    const problem = rosterIssue(parsed.roster)
    if (problem !== undefined) return setError(problem)
    setError(undefined)
    const detail = existing
    const saved = detail === undefined
      ? await props.change("save", "coordination.create", createGroupInput(parsedName.value, parsed.roster), "Project created.")
      : await props.change("save", "coordination.members", { groupID: detail.id, ...membersInput(detail, { members: parsed.roster, name: parsedName.value }) }, "Project updated.")
    if (saved) props.done(detail === undefined)
  }
  return <form class="settings__section project-editor" aria-labelledby="project-editor-title" onSubmit={(event) => void save(event)}>
    <SectionHead id="project-editor-title" category="Project" title={existing === undefined ? "New project" : `Edit ${existing.name}`} heading />
    <label class="field"><span class="field__label">Project name</span>
      <input class="input" value={name()} maxLength={120} aria-describedby="project-name-hint" onInput={(event) => setName(event.currentTarget.value)} />
      <span id="project-name-hint" class="field__hint">1 to 120 characters.</span></label>
    <fieldset class="project-roster-editor"><legend class="field__label">Roster</legend>
      <p class="field__hint">Exactly one coordinator. Assigning a new coordinator demotes the current one to worker.</p>
      <Show when={ids().length > 0} fallback={<p class="projects__empty">No Sessions yet. Add the coordinator first.</p>}>
        <ul class="project-members" role="list">
          <For each={ids()}>{(id) => <li class="project-member project-member--edit">
            <span class="project-member__name" title={id}>{props.title(id)}</span>
            <Segmented label={`Role for ${props.title(id)}`} value={member(id).role} options={roles.map((role) => ({ id: role, label: roleLabels[role] }))} onChange={(role) => setRole(id, role)} />
            <button type="button" class="button button--ghost button--small" aria-label={`Remove ${props.title(id)}`} onClick={() => remove(id)}><Icon name="close" size={16} />Remove</button>
            <details class="project-member__limits-editor"><summary>Tools and scopes</summary>
              <label class="field"><span class="field__label">Allowed tools</span><textarea class="textarea" rows="2" value={member(id).tools} placeholder="read, edit (empty means no recorded limit)" onInput={(event) => patch(id, { tools: event.currentTarget.value })} /></label>
              <label class="field"><span class="field__label">Resource scopes</span><textarea class="textarea" rows="2" value={member(id).scopes} placeholder="src/**, docs/** (one per line or comma separated)" onInput={(event) => patch(id, { scopes: event.currentTarget.value })} /></label>
            </details>
          </li>}</For>
        </ul>
      </Show>
    </fieldset>
    <fieldset class="project-picker"><legend class="field__label">Add a Session</legend>
      <label class="field"><span class="field__label">Search loaded Sessions</span><input class="input" type="search" value={search()} placeholder="Title or ID" onInput={(event) => setSearch(event.currentTarget.value)} /></label>
      <Show when={candidates().length > 0} fallback={<p class="field__hint">No other loaded Session matches. Open Sessions to load more, or add one by its ID.</p>}>
        <ul class="project-lines" role="list"><For each={candidates()}>{(session) => <li class="project-picker__row"><span class="project-member__name" title={session.id}>{session.title}</span><button type="button" class="button button--secondary button--small" aria-label={`Add ${session.title}`} onClick={() => add(session.id)}><Icon name="plus" size={16} />Add</button></li>}</For></ul>
      </Show>
      <div class="project-picker__id"><label class="field"><span class="field__label">Add by Session ID</span><input class="input" value={byID()} placeholder="ses_…" onInput={(event) => setByID(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addByID() } }} /></label>
        <button type="button" class="button button--secondary button--small" onClick={addByID}>Add ID</button></div>
    </fieldset>
    <Show when={error() ?? issue()}>{(text) => <p class="projects__notice" data-tone="danger" role="alert">{text()}</p>}</Show>
    <div class="project-actions"><button type="submit" class="button button--primary" disabled={props.pending() !== undefined || issue() !== undefined || "error" in parseGroupName(name())}>{props.pending() === "save" ? "Saving…" : existing === undefined ? "Create project" : "Save changes"}</button>
      <button type="button" class="button button--ghost" onClick={props.cancel}>Cancel</button></div>
  </form>
}

function Segmented<Value extends string>(props: { readonly label: string; readonly value: Value; readonly options: readonly { readonly id: Value; readonly label: string }[]; readonly onChange: (value: Value) => void; readonly disabled?: boolean }): JSX.Element {
  return <span class="filters filters--inline project-segmented" role="radiogroup" aria-label={props.label}>
    <For each={props.options}>{(option, index) => <button type="button" role="radio" disabled={props.disabled} aria-checked={props.value === option.id} tabIndex={props.value === option.id ? 0 : -1}
      class={`filters__option${props.value === option.id ? " filters__option--active" : ""}`} onClick={() => props.onChange(option.id)}
      onKeyDown={(event) => moveRadio(event, index(), props.options.length, (next) => { const selected = props.options[next]; if (selected) props.onChange(selected.id) })}>{option.label}</button>}</For>
  </span>
}

function PolicyEditor(props: { readonly bundle: () => CoordinationBundle; readonly central: () => CentralPolicy | undefined; readonly pending: () => string | undefined; readonly change: Change; readonly done: (saved: boolean) => void }): JSX.Element {
  const detail = props.bundle().detail
  const current = detail.policy.delegatedDecisions
  const [capped, setCapped] = createSignal(detail.policy.concurrency !== null)
  const [concurrency, setConcurrency] = createSignal(String(detail.policy.concurrency ?? 1))
  const [queue, setQueue] = createSignal(String(detail.policy.queueCapacity))
  const [budget, setBudget] = createSignal(detail.policy.budget === undefined ? "" : String(detail.policy.budget))
  const [narrow, setNarrow] = createSignal(current !== undefined)
  const [categories, setCategories] = createSignal<readonly DelegatedCategory[]>(current?.categories ?? props.central()?.categories ?? [])
  const [actions, setActions] = createSignal((current?.actions ?? []).join("\n"))
  const [resources, setResources] = createSignal((current?.resources ?? []).join("\n"))
  const [expiry, setExpiry] = createSignal<ExpiryChoice | "keep">(current?.expiresAt === undefined ? "none" : "keep")
  const [error, setError] = createSignal<string>()
  const central = () => props.central()
  const delegationEditable = () => central()?.enabled === true
  const draft = () => {
    const parsedActions = parseList(actions(), { limit: 32, length: 512, noun: "action" })
    const parsedResources = parseList(resources(), { limit: 32, length: 512, noun: "resource" })
    if ("error" in parsedActions) return { error: parsedActions.error }
    if ("error" in parsedResources) return { error: parsedResources.error }
    const expiresAt = expiry() === "keep" ? current?.expiresAt : expiryAt(expiry() as ExpiryChoice, Date.now())
    return { value: { categories: categories(), ...(parsedActions.value.length === 0 ? {} : { actions: parsedActions.value }), ...(parsedResources.value.length === 0 ? {} : { resources: parsedResources.value }), ...(expiresAt === undefined ? {} : { expiresAt }) } }
  }
  const preview = () => { const parsed = draft(); return effectiveDelegation(central(), !narrow() || "error" in parsed ? undefined : parsed.value) }
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    const limit = capped() ? parseConcurrency(concurrency()) : { value: null }
    const size = parseQueueCapacity(queue())
    const money = parseBudget(budget())
    if ("error" in limit) return setError(limit.error)
    if ("error" in size) return setError(size.error)
    if ("error" in money) return setError(money.error)
    let delegated = current
    if (delegationEditable()) {
      const parsed = narrow() ? draft() : { value: undefined }
      if ("error" in parsed) return setError(parsed.error)
      const issue = parsed.value === undefined ? undefined : delegationDraftIssue(central(), parsed.value, Date.now())
      if (issue !== undefined) return setError(issue)
      delegated = parsed.value
    }
    const policy: PolicyView = { concurrency: limit.value, queueCapacity: size.value, ...(money.value === undefined ? {} : { budget: money.value }), ...(delegated === undefined ? {} : { delegatedDecisions: delegated }) }
    setError(undefined)
    if (await props.change("policy", "coordination.members", { groupID: detail.id, ...membersInput(detail, { members: detail.members, policy }) }, "Policy updated.")) props.done(true)
  }
  const toggleDelegated = (category: DelegatedCategory) => setCategories(categories().includes(category) ? categories().filter((item) => item !== category) : [...categories(), category])
  return <form class="settings__section project-editor" aria-labelledby="project-policy-editor-title" onSubmit={(event) => void save(event)}>
    <SectionHead id="project-policy-editor-title" category="Policy" title={`Policy · ${detail.name}`} heading />
    <div class="field"><span class="field__label" id="policy-concurrency-label">Concurrency</span>
      <Segmented label="Concurrency mode" value={capped() ? "limit" : "uncapped"} options={[{ id: "uncapped", label: "Uncapped policy" }, { id: "limit", label: "Set a limit" }]} onChange={(value) => setCapped(value === "limit")} />
      <Show when={capped()}><input class="input" inputMode="numeric" aria-labelledby="policy-concurrency-label" value={concurrency()} onInput={(event) => setConcurrency(event.currentTarget.value)} /></Show>
      <span class="field__hint">An uncapped policy still obeys the hard limit{props.bundle().capacity.hardLimit === null ? " (unreported)" : ` of ${props.bundle().capacity.hardLimit}`}.</span></div>
    <label class="field"><span class="field__label">Queue capacity</span><input class="input" inputMode="numeric" value={queue()} onInput={(event) => setQueue(event.currentTarget.value)} /><span class="field__hint">Whole number from 1 to 1000.</span></label>
    <label class="field"><span class="field__label">Budget</span><input class="input" value={budget()} placeholder="USD amount or none" onInput={(event) => setBudget(event.currentTarget.value)} /><span class="field__hint">Positive USD with up to two decimals, or empty for none.</span></label>
    <fieldset class="project-delegation"><legend class="field__label">Delegated decisions</legend>
      <p class="projects__notice" data-tone={central() === undefined || !central()!.enabled ? "attention" : "success"} role="status">{centralPolicyNote(central())}</p>
      <Segmented label="Delegation mode" value={narrow() ? "narrow" : "inherit"} disabled={!delegationEditable()} options={[{ id: "inherit", label: "Inherit central policy" }, { id: "narrow", label: "Narrow for this project" }]} onChange={(value) => setNarrow(value === "narrow")} />
      <Show when={narrow() && delegationEditable()}>
        <div class="project-delegation__body">
          <div role="group" aria-label="Delegated categories" class="project-switches">
            <For each={delegatedCategories}>{(category) => <label class="switch"><input type="checkbox" checked={categories().includes(category)} disabled={!central()!.categories.includes(category)} onChange={() => toggleDelegated(category)} /><span>{delegatedLabels[category]}{central()!.categories.includes(category) ? "" : " (not delegated centrally)"}</span></label>}</For>
          </div>
          <label class="field"><span class="field__label">Action patterns</span><textarea class="textarea" rows="2" value={actions()} placeholder="shell, edit* (empty keeps the central actions)" onInput={(event) => setActions(event.currentTarget.value)} /></label>
          <label class="field"><span class="field__label">Resource patterns</span><textarea class="textarea" rows="2" value={resources()} placeholder="src/**, docs/** (empty keeps the central resources)" onInput={(event) => setResources(event.currentTarget.value)} /></label>
          <div class="field"><span class="field__label" id="policy-expiry-label">Expires</span>
            <Segmented label="Expiry" value={expiry()} options={[...(current?.expiresAt === undefined ? [] : [{ id: "keep" as const, label: `Keep ${new Date(current.expiresAt).toLocaleString()}` }]), ...expiryChoices.map((choice) => ({ id: choice.id, label: choice.label }))]} onChange={setExpiry} /></div>
        </div>
      </Show>
      <p class="field__hint" role="status" data-testid="delegation-effective">{delegationSummary(preview())}</p>
    </fieldset>
    <Show when={error()}>{(text) => <p class="projects__notice" data-tone="danger" role="alert">{text()}</p>}</Show>
    <div class="project-actions"><button type="submit" class="button button--primary" disabled={props.pending() !== undefined}>{props.pending() === "policy" ? "Saving…" : "Save policy"}</button>
      <button type="button" class="button button--ghost" onClick={() => props.done(false)}>Cancel</button></div>
  </form>
}

function FilterSection(props: { readonly groups: () => readonly CoordinationBundle[] | undefined; readonly title: (id: string) => string }): JSX.Element {
  const remote = useRemote()
  const filter = () => remote.state().notificationFilter
  const [status, setStatus] = createSignal("")
  const coordinators = createMemo(() => {
    const groups = props.groups()
    if (groups === undefined) return undefined
    const seen = new Set<string>()
    return groups.flatMap((group) => group.detail.members).filter((member) => member.role === "coordinator" && !seen.has(member.sessionID) && seen.add(member.sessionID))
      .map((member) => ({ sessionID: member.sessionID, title: props.title(member.sessionID) }))
  })
  const reload = (event: StorageEvent) => { if (event.key === FILTER_STORAGE_KEY || event.key === null) remote.store.reloadNotificationFilter() }
  onMount(() => window.addEventListener("storage", reload))
  onCleanup(() => window.removeEventListener("storage", reload))
  const apply = async (next: NotificationFilter) => {
    setStatus(remote.store.setNotificationFilter(next) ? "" : "Saved for this tab only. Browser storage refused the change.")
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return setStatus((current) => current === "" ? "System alerts are not allowed in this browser yet. The filter applies once they are." : current)
    const result = await savePushCategories(browserPushPlatform(), createPushHttp(), () => pushCategoriesFor(readNotificationPreferences()), () => pushFilterWire(remote.state().notificationFilter))
    if (result.status === "off") setStatus((current) => current === "" ? "No push subscription on this device. The filter applies to System alerts from this browser." : current)
    else if (result.status === "on") setStatus((current) => current === "" ? "Push alerts to this device now follow this filter." : current)
    else setStatus(result.message ?? "Push alerts to this device could not be updated.")
  }
  const scopes: readonly { readonly id: NotificationScope; readonly label: string }[] = [{ id: "all", label: "All sessions (default)" }, { id: "coordinators", label: "All coordinators" }, { id: "selected", label: "Selected coordinators" }]
  const selected = () => filter().sessionIDs ?? []
  const unknownSelected = () => selected().filter((id) => !(coordinators() ?? []).some((coordinator) => coordinator.sessionID === id))
  return <section class="settings__section" aria-labelledby="projects-filter-title">
    <SectionHead id="projects-filter-title" category="Notifications" title="External notifications"
      hint="Chooses which Sessions raise System alerts and closed-app push on this browser and device. In-app notices, pending requests, reviews and decisions are never hidden." />
    <p class="projects__summary" role="status" data-filter-state={isDefaultFilter(filter()) ? "default" : "narrowed"}>Currently: {filterLabel(filter(), coordinators())}</p>
    <Segmented label="Notification scope" value={filter().scope} options={scopes} onChange={(scope) => void apply(setScope(filter(), scope))} />
    <Show when={filter().scope === "selected"}>
      <div role="group" aria-label="Selected coordinators" class="project-switches">
        <Show when={(coordinators()?.length ?? 0) > 0 || selected().length > 0} fallback={<p class="projects__empty">{coordinators() === undefined ? "The coordinator list is unavailable. Connect a machine that offers Projects to choose coordinators." : "No coordinator Sessions are listed yet. Create a project first."}</p>}>
          <For each={coordinators() ?? []}>{(coordinator) => <label class="switch"><input type="checkbox" checked={selected().includes(coordinator.sessionID)} onChange={() => void apply(toggleCoordinator(filter(), coordinator.sessionID))} /><span>{coordinator.title}</span></label>}</For>
          <For each={unknownSelected()}>{(id) => <label class="switch"><input type="checkbox" checked onChange={() => void apply(toggleCoordinator(filter(), id))} /><span>Session {id} (not a listed coordinator)</span></label>}</For>
        </Show>
      </div>
      <p class="field__hint">Up to {maxCoordinatorSelection} Sessions. With nothing selected, nothing notifies externally.</p>
    </Show>
    <div role="group" aria-label="Notification categories" class="project-switches">
      <For each={externalKinds}>{(kind) => <label class="switch"><input type="checkbox" checked={filter().categories === undefined || filter().categories!.includes(kind)} onChange={() => void apply(toggleCategory(filter(), kind))} /><span>{categoryLabels[kind]}</span></label>}</For>
    </div>
    <p class="field__hint">Turn every category off to mute external alerts. In-app notices stay.</p>
    <p class="field__hint" role="status" aria-live="polite">{status()}</p>
  </section>
}
