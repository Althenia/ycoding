import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import type { RemoteWorkspaceInfo } from "@ycoding-ai/remote"
import { Modal } from "../../ui/modal"
import { useRemote } from "../context"

export function NewSessionButton(props: { readonly disabled: boolean; readonly onClick: () => void }): JSX.Element {
  return (
    <button type="button" class="button button--primary new-session__trigger" disabled={props.disabled} onClick={props.onClick}>
      New session
    </button>
  )
}

export function NewSessionDialog(props: {
  readonly onClose: () => void
  readonly onCreated: (sessionID: string) => void
}): JSX.Element {
  const remote = useRemote()
  const [workspaceID, setWorkspaceID] = createSignal("")
  let mounted = true
  onCleanup(() => mounted = false)

  const state = () => remote.state()
  const creation = () => state().sessionCreation
  const workspaces = () => state().workspaces
  const workspace = () => workspaces().find((item) => item.id === workspaceID())
  const connected = () => state().transport.kind === "open" && state().connection.kind === "connected"
  const createDisabled = () => !connected() || state().workspaceStatus !== "ready" || workspace() === undefined || creation() !== undefined
  const refreshDisabled = () => !connected() || state().workspaceStatus === "loading"

  createEffect(() => {
    if (!workspaces().some((item) => item.id === workspaceID())) setWorkspaceID(workspaces()[0]?.id ?? "")
  })

  const create = async () => {
    const selected = workspace()
    if (createDisabled() || selected === undefined) return
    const sessionID = await remote.store.createSession(selected.id)
    if (mounted && sessionID !== undefined) props.onCreated(sessionID)
  }

  const retry = async () => {
    const sessionID = await remote.store.retrySessionCreation()
    if (mounted && sessionID !== undefined) props.onCreated(sessionID)
  }

  return (
    <Modal class="overlay--dialog" label="New session" onClose={props.onClose}>
      <div class="new-session">
        <p class="new-session__support">Choose a repository already opened on this machine.</p>
        <Show when={creation()?.status === "creating"}>
          <p class="new-session__message" role="status">Creating session…</p>
        </Show>
        <Show when={creation()?.status === "unknown"}>
          <div class="new-session__outcome new-session__outcome--unknown" role="alert">
            <p>{creation()?.message ?? "The creation result is unknown."}</p>
            <p>The session may already exist. Check Sessions before dismissing.</p>
            <div class="new-session__actions">
              <button type="button" class="button button--primary" disabled={!connected()} onClick={() => void retry()}>Retry</button>
              <button type="button" class="button button--secondary" onClick={() => remote.store.dismissSessionCreation()}>Dismiss</button>
            </div>
          </div>
        </Show>
        <Show when={!connected()}>
          <p class="new-session__message" role="status">Connect to an online machine to create a session.</p>
        </Show>
        <Show when={creation()?.status === "failed"}>
          <div class="new-session__outcome" role="alert">
            <p>{creation()?.message ?? "Session creation failed."}</p>
            <div class="new-session__actions">
              <button type="button" class="button button--primary" disabled={!connected()} onClick={() => void retry()}>Retry</button>
              <button type="button" class="button button--secondary" onClick={() => remote.store.dismissSessionCreation()}>Choose another repository</button>
            </div>
          </div>
        </Show>
        <Show when={creation() === undefined}>
          <Show when={state().workspaceStatus === "loading"}>
            <p class="new-session__message" role="status">Loading previously opened repositories…</p>
          </Show>
          <Show when={state().workspaceStatus === "error"}>
            <p class="new-session__outcome" role="alert">{state().workspaceError ?? "Repositories could not be loaded."}</p>
          </Show>
          <Show when={state().workspaceStatus === "ready" && workspaces().length === 0}>
            <div class="new-session__empty">
              <p>No previously opened repositories are available.</p>
              <p>Open a repository locally once, then refresh.</p>
            </div>
          </Show>
          <Show when={state().workspaceStatus === "ready" && workspaces().length > 0}>
            <label class="field new-session__field">
              <span>Previously opened repository</span>
              <select class="select" value={workspaceID()} disabled={!connected()} onChange={(event) => setWorkspaceID(event.currentTarget.value)}>
                <For each={workspaces()}>{(item) => (
                  <option value={item.id}>{workspaceName(item)} — {item.directory}</option>
                )}</For>
              </select>
            </label>
          </Show>
          <div class="new-session__actions">
            <button type="button" class="button button--secondary" disabled={refreshDisabled()} onClick={() => void remote.store.loadWorkspaces()}>
              Refresh repositories
            </button>
            <button type="button" class="button button--secondary" onClick={props.onClose}>Cancel</button>
            <button type="button" class="button button--primary" disabled={createDisabled()} onClick={() => void create()}>
              Create session
            </button>
          </div>
        </Show>
      </div>
    </Modal>
  )
}

function workspaceName(workspace: RemoteWorkspaceInfo) {
  if (workspace.name?.trim()) return workspace.name
  return workspace.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace.projectID
}
