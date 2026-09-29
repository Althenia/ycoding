import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import { useRemote } from "../context"
import { workspaceLabels } from "../view-model"
import { MiniComposer, type ComposerSubmission } from "./composer"
import { ComposerPicker } from "./composer-picker"
import { BrandMark } from "../../ui/site"
import { Icon } from "../../ui/icon"
import { LoadingPlaceholder } from "./loading"

export function NewSessionButton(props: { readonly disabled: boolean; readonly onClick: () => void }): JSX.Element {
  return <button type="button" class="button button--primary new-session__trigger" disabled={props.disabled} onClick={props.onClick}>New session</button>
}

export function NewSessionComposer(props: { readonly onCreated: (sessionID: string) => void }): JSX.Element {
  const remote = useRemote()
  const [workspaceID, setWorkspaceID] = createSignal("")
  const [text, setText] = createSignal("")
  let mounted = true
  onCleanup(() => mounted = false)
  const state = () => remote.state()
  const creation = () => state().sessionCreation
  const connected = () => state().transport.kind === "open" && state().connection.kind === "connected"
  const workspace = () => state().workspaces.find((item) => item.id === workspaceID())
  const disabled = () => !connected() || state().workspaceStatus !== "ready" || !workspace() || !!creation()
  const labels = () => workspaceLabels(state().workspaces)

  createEffect(() => {
    if (!state().workspaces.some((item) => item.id === workspaceID())) setWorkspaceID(state().workspaces[0]?.id ?? "")
  })
  createEffect(() => {
    if (connected() && state().workspaceStatus === "idle") void remote.store.loadWorkspaces()
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
    <Show when={state().workspaceStatus === "error"}><p role="alert">{state().workspaceError ?? "Repositories could not be loaded."}</p></Show>
    <Show when={state().workspaceStatus === "ready" && !state().workspaces.length}><p role="status">No previously opened repositories are available. Open a repository locally once, then refresh.</p></Show>
    <div class="new-session-composer__repository"><Show when={state().workspaceStatus === "loading"} fallback={<ComposerPicker label="Repository" icon="folder" placeholder="Choose repository" value={workspaceID()} options={state().workspaces.map((item) => ({ value: item.id, label: labels().get(item.id) ?? item.name ?? "Repository" }))} disabled={!connected()} onChange={setWorkspaceID} />}><LoadingPlaceholder kind="repository" label="Loading previously opened repositories…" /></Show>
      <button type="button" class="new-session-composer__refresh" aria-label="Refresh repositories" title="Refresh repositories" disabled={!connected() || state().workspaceStatus === "loading"} onClick={() => void remote.store.loadWorkspaces()}><Icon name="refresh" /></button>
    </div>
    <Show when={creation()?.status === "creating"}><p role="status">Creating session…</p></Show>
    <Show when={creation()?.status === "unknown" || creation()?.status === "failed"}><div class="new-session__outcome" classList={{ "new-session__outcome--unknown": creation()?.status === "unknown" }} role="alert">
      <p>{creation()?.message ?? "Session creation failed."}</p>
      <Show when={creation()?.status === "unknown"}><p>The session may already exist. Check Sessions before dismissing.</p></Show>
      <button class="button button--primary" type="button" disabled={!connected()} onClick={() => void retry()}>Retry</button>
      <button class="button button--secondary" type="button" onClick={() => remote.store.dismissSessionCreation()}>{creation()?.status === "unknown" ? "Dismiss" : "Choose another repository"}</button>
    </div></Show>
    <MiniComposer target={workspace() ? { workspaceID: workspaceID() } : undefined} text={text()} onText={setText} disabled={disabled()} allowEmpty onSubmit={(value) => void create(value)} />
  </section>
}
