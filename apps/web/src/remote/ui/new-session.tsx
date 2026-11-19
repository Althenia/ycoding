import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import { useRemote } from "../context"
import { createRemoteQuery } from "../query"
import { newSessionDisplayView, workspaceLabels } from "../view-model"
import { MiniComposer, type ComposerSubmission } from "./composer"
import { ComposerPicker } from "./composer-picker"
import { Icon } from "../../ui/icon"
import { Link } from "../../ui/link"
import { LoadingPlaceholder } from "./loading"
import type { PaletteModelBinding } from "./command-palette-model"

export function NewSessionButton(props: { readonly disabled: boolean; readonly onClick: () => void; readonly labeled?: boolean; readonly newChat?: boolean; readonly workspace?: string }): JSX.Element {
  const label = () => props.workspace ? `New chat in ${props.workspace}` : "New chat"
  return <button type="button" class={`button button--primary button--small new-session__trigger${props.labeled ? " new-session__trigger--labeled" : ""}`} aria-label={label()} data-tooltip={label()} disabled={props.disabled} onClick={() => props.onClick()}><Icon name="plus" size={20} /><Show when={props.labeled}><span>{label()}</span><Show when={props.newChat}><kbd>⌘ N</kbd></Show></Show></button>
}

export function NewSessionComposer(props: { readonly workspaceID?: string; readonly repositoryRequired?: boolean; readonly onCreated: (sessionID: string) => void; readonly onWorkspaceChange?: (workspaceID: string | undefined) => void; readonly registerPaletteModel?: (binding: PaletteModelBinding) => () => void }): JSX.Element {
  const remote = useRemote()
  const [workspaceID, setWorkspaceID] = createSignal("")
  const [text, setText] = createSignal("")
  let mounted = true
  onCleanup(() => mounted = false)
  const state = () => remote.state()
  const creation = () => state().sessionCreation
  const connected = () => state().transport.kind === "open" && state().connection.kind === "connected"
  const listed = createRemoteQuery(remote.store.queryClient, () => remote.queries.workspaces(remote.scope(), connected()))
  const workspaces = () => listed().data ?? []
  const workspaceStatus = () => listed().isFetching ? "loading" : listed().isError ? "error" : listed().isSuccess ? "ready" : "idle"
  const workspace = () => workspaces().find((item) => item.id === workspaceID())
  const labels = () => workspaceLabels(workspaces())
  const selectedWorkspaceName = () => {
    const selected = workspace()
    return selected ? labels().get(selected.id) ?? selected.name ?? "Repository" : undefined
  }
  const originUnavailable = () => props.workspaceID !== undefined && workspaceStatus() === "ready" && !workspace()
  const repositoryRequired = () => props.repositoryRequired !== false
  const display = () => newSessionDisplayView({
    connected: connected(),
    workspaceStatus: workspaceStatus(),
    workspaceCount: workspaces().length,
    selectedWorkspaceName: selectedWorkspaceName(),
    originUnavailable: originUnavailable(),
    repositoryRequired: repositoryRequired(),
    errorMessage: listed().error?.message,
    creating: !!creation(),
  })
  const disabled = () => display().sendBlocked

  createEffect(() => props.onWorkspaceChange?.(workspace()?.id))
  onCleanup(() => props.onWorkspaceChange?.(undefined))

  createEffect(() => {
    if (props.workspaceID !== undefined) { setWorkspaceID(props.workspaceID); return }
    if (workspaceID() && !workspaces().some((item) => item.id === workspaceID())) setWorkspaceID("")
  })
  const create = async (submission: ComposerSubmission) => {
    if (disabled()) return false
    const selectedID = workspace()?.id
    if (submission.kind === "promptGenerate") {
      const previous = remote.state().activeSessionID
      const accepted = await remote.store.requestPromptGenerate({
        mode: submission.input.mode ?? "start",
        intent: submission.input.intent ?? "",
        memory: submission.input.memory ?? [],
        ...(selectedID ? { workspaceID: selectedID } : {}),
        ...(submission.input.agent ? { agent: submission.input.agent } : {}),
        ...(submission.input.model ? { model: submission.input.model } : {}),
      })
      const created = remote.state().activeSessionID
      if (mounted && created && created !== previous) props.onCreated(created)
      return accepted
    }
    if (submission.kind !== "prompt" && submission.kind !== "command") return false
    const prompt = submission.kind === "command"
      ? { command: submission.input.command, ...(submission.input.arguments ? { arguments: submission.input.arguments } : {}), ...(submission.input.files ? { files: submission.input.files } : {}), ...(submission.input.agents ? { agents: submission.input.agents } : {}) }
      : submission.input.text || submission.input.files?.length ? { text: submission.input.text, ...(submission.input.files ? { files: submission.input.files } : {}), ...(submission.input.agents ? { agents: submission.input.agents } : {}), ...(submission.input.skills ? { skills: submission.input.skills } : {}) } : undefined
    const sessionID = await remote.store.createSession({ ...(selectedID ? { workspaceID: selectedID } : {}), ...(submission.input.agent ? { agent: submission.input.agent } : {}), ...(submission.input.model ? { model: submission.input.model } : {}), ...(prompt ? { prompt } : {}) })
    if (mounted && sessionID) props.onCreated(sessionID)
    return sessionID !== undefined
  }
  const retry = async () => {
    const sessionID = await remote.store.retrySessionCreation()
    if (mounted && sessionID) props.onCreated(sessionID)
  }
  return <section class="new-session-composer" aria-label="New chat">
    <div class="new-session-composer__header">
      <h2>Start with a conversation.</h2>
      <Show when={workspaceStatus() === "ready"}>
        <span class="new-session-composer__repository-count">{workspaces().length} {workspaces().length === 1 ? "repository" : "repositories"}</span>
      </Show>
    </div>
    <div class="new-session-composer__surface">
      <div class="new-session-composer__repository" classList={{ "new-session-composer__repository--required": display().repositoryHighlight, "new-session-composer__repository--selected": Boolean(workspace()) }}>
        <Show when={workspaceStatus() === "loading"} fallback={<ComposerPicker label="Repository" icon="folder" placeholder={display().repositoryPlaceholder} value={workspaceID()} options={workspaces().map((item) => ({ value: item.id, label: labels().get(item.id) ?? item.name ?? "Repository" }))} disabled={!connected() || props.workspaceID !== undefined || workspaces().length === 0} onChange={setWorkspaceID} />}>
          <LoadingPlaceholder kind="repository" label="Loading previously opened repositories…" />
        </Show>
        <button type="button" class="new-session-composer__refresh" classList={{ "new-session-composer__refresh--primary": display().refreshHighlight }} aria-label="Refresh repositories" data-tooltip="Refresh repositories" disabled={!connected() || workspaceStatus() === "loading"} onClick={() => void listed().refetch()}><Icon name="refresh" /></button>
      </div>
      <MiniComposer phoneSummary registerPaletteModel={props.registerPaletteModel} target={workspace() ? { workspaceID: workspaceID() } : undefined} text={text()} onText={setText} disabled={!!creation()} sendDisabled={disabled()} sendDescription={display().sendBlockedReason} allowEmpty onSubmit={create} />
    </div>
    <p class="field__hint new-session-composer__helper" classList={{ "new-session-composer__helper--blocked": display().repositoryHighlight || display().refreshHighlight }} role={display().messageTone}>
      {display().message}<Show when={originUnavailable()}> <Link to="/remote" class="text-link">Choose another repository</Link>.</Show>
    </p>
    <Show when={creation()?.status === "creating"}><p role="status">Creating session…</p></Show>
    <Show when={creation()?.status === "unknown" || creation()?.status === "failed"}><div class="new-session__outcome" classList={{ "new-session__outcome--unknown": creation()?.status === "unknown" }} role="alert">
      <p>{creation()?.message ?? "Session creation failed."}</p>
      <Show when={creation()?.status === "unknown"}><p>The session may already exist. Check Sessions before dismissing.</p></Show>
      <button class="button button--primary" type="button" disabled={!connected()} onClick={() => void retry()}>Retry</button>
      <button class="button button--secondary" type="button" onClick={() => remote.store.dismissSessionCreation()}>{creation()?.status === "unknown" ? "Dismiss" : "Choose another repository"}</button>
    </div></Show>
  </section>
}
