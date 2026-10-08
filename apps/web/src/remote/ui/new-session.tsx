import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import { useRemote } from "../context"
import { createRemoteQuery } from "../query"
import { workspaceLabels } from "../view-model"
import { MiniComposer, type ComposerSubmission } from "./composer"
import { ComposerPicker } from "./composer-picker"
import { BrandMark } from "../../ui/site"
import { Icon } from "../../ui/icon"
import { LoadingPlaceholder } from "./loading"

export function NewSessionButton(props: { readonly disabled: boolean; readonly onClick: () => void }): JSX.Element {
  return <button type="button" class="button button--primary button--small new-session__trigger" aria-label="New session" title="New session" disabled={props.disabled} onClick={() => props.onClick()}><Icon name="plus" size={18} /></button>
}

export function NewSessionComposer(props: { readonly workspaceID?: string; readonly onCreated: (sessionID: string) => void; readonly onWorkspaceChange?: (workspaceID: string | undefined) => void }): JSX.Element {
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
  const disabled = () => !connected() || workspaceStatus() !== "ready" || !workspace() || !!creation()
  const labels = () => workspaceLabels(workspaces())

  createEffect(() => props.onWorkspaceChange?.(workspace()?.id))
  onCleanup(() => props.onWorkspaceChange?.(undefined))

  createEffect(() => {
    if (props.workspaceID !== undefined) { setWorkspaceID(props.workspaceID); return }
    if (!workspaces().some((item) => item.id === workspaceID())) setWorkspaceID(workspaces()[0]?.id ?? "")
  })
  const create = async (submission: ComposerSubmission) => {
    if (disabled()) return false
    if (submission.kind !== "prompt" && submission.kind !== "command") return false
    const prompt = submission.kind === "command"
      ? { command: submission.input.command, ...(submission.input.arguments ? { arguments: submission.input.arguments } : {}), ...(submission.input.files ? { files: submission.input.files } : {}), ...(submission.input.agents ? { agents: submission.input.agents } : {}) }
      : submission.input.text || submission.input.files?.length ? { text: submission.input.text, ...(submission.input.files ? { files: submission.input.files } : {}), ...(submission.input.agents ? { agents: submission.input.agents } : {}), ...(submission.input.skills ? { skills: submission.input.skills } : {}) } : undefined
    const sessionID = await remote.store.createSession({ workspaceID: workspaceID(), ...(submission.input.agent ? { agent: submission.input.agent } : {}), ...(submission.input.model ? { model: submission.input.model } : {}), ...(prompt ? { prompt } : {}) })
    if (mounted && sessionID) props.onCreated(sessionID)
    return sessionID !== undefined
  }
  const retry = async () => {
    const sessionID = await remote.store.retrySessionCreation()
    if (mounted && sessionID) props.onCreated(sessionID)
  }
  return <section class="new-session-composer" aria-label="New session">
    <div class="new-session-composer__header"><h2 class="visually-hidden">New session</h2><div class="new-session-composer__brand"><BrandMark /></div></div>
    <Show when={!connected()}><p role="status">Connect to an online machine to create a session.</p></Show>
    <Show when={workspaceStatus() === "error"}><p role="alert">{listed().error?.message ?? "Repositories could not be loaded."}</p></Show>
    <Show when={workspaceStatus() === "ready" && !workspaces().length}><p role="status">No previously opened repositories are available. Open a repository locally once, then refresh.</p></Show>
    <Show when={props.workspaceID !== undefined && workspaceStatus() === "ready" && !workspace()}><p role="alert">The originating repository is unavailable on this machine. Open Conversation to choose another repository.</p></Show>
    <div class="new-session-composer__repository"><Show when={workspaceStatus() === "loading"} fallback={<ComposerPicker label="Repository" icon="folder" placeholder="Choose repository" value={workspaceID()} options={workspaces().map((item) => ({ value: item.id, label: labels().get(item.id) ?? item.name ?? "Repository" }))} disabled={!connected() || props.workspaceID !== undefined} onChange={setWorkspaceID} />}><LoadingPlaceholder kind="repository" label="Loading previously opened repositories…" /></Show>
      <button type="button" class="new-session-composer__refresh" aria-label="Refresh repositories" title="Refresh repositories" disabled={!connected() || workspaceStatus() === "loading"} onClick={() => void listed().refetch()}><Icon name="refresh" /></button>
    </div>
    <Show when={creation()?.status === "creating"}><p role="status">Creating session…</p></Show>
    <Show when={creation()?.status === "unknown" || creation()?.status === "failed"}><div class="new-session__outcome" classList={{ "new-session__outcome--unknown": creation()?.status === "unknown" }} role="alert">
      <p>{creation()?.message ?? "Session creation failed."}</p>
      <Show when={creation()?.status === "unknown"}><p>The session may already exist. Check Sessions before dismissing.</p></Show>
      <button class="button button--primary" type="button" disabled={!connected()} onClick={() => void retry()}>Retry</button>
      <button class="button button--secondary" type="button" onClick={() => remote.store.dismissSessionCreation()}>{creation()?.status === "unknown" ? "Dismiss" : "Choose another repository"}</button>
    </div></Show>
    <MiniComposer target={workspace() ? { workspaceID: workspaceID() } : undefined} text={text()} onText={setText} disabled={disabled()} allowEmpty onSubmit={create} />
  </section>
}
