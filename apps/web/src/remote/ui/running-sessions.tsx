import { For, Show, type JSX } from "solid-js"
import type { SessionInfoView } from "../store"
import "./running-sessions.css"

export function RunningSessions(props: {
  readonly sessions: readonly (SessionInfoView & { readonly workspaceName: string })[]
  readonly onSelectSession: (sessionID: string) => void
}): JSX.Element {
  return <Show when={props.sessions.length > 0}>
    <section class="running-sessions" aria-labelledby="running-sessions-title">
      <h2 id="running-sessions-title">Running across workspaces</h2>
      <ul class="running-sessions__list">
        <For each={props.sessions}>
          {(session) => <li>
            <button type="button" class="running-sessions__item"
              aria-label={`Open ${session.title} in ${session.workspaceName}`}
              onClick={() => props.onSelectSession(session.id)}>
              <span class="running-sessions__title">{session.title}</span>
              <span class="running-sessions__workspace">{session.workspaceName}</span>
              <span class="running-sessions__status"><span aria-hidden="true" class="running-sessions__dot" />Running</span>
            </button>
          </li>}
        </For>
      </ul>
    </section>
  </Show>
}
