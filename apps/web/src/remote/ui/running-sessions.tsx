import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import type { SessionInfoView } from "../store"
import "./running-sessions.css"

export function RunningSessions(props: {
  readonly sessions: readonly (SessionInfoView & { readonly workspaceName: string })[]
  readonly onSelectSession: (sessionID: string) => void
}): JSX.Element {
  const [active, setActive] = createSignal(0)
  const [overflow, setOverflow] = createSignal(false)
  let track: HTMLUListElement | undefined
  let target: { readonly index: number; readonly left: number } | undefined
  let frame = 0
  const measure = () => {
    if (!track) return
    const excess = track.scrollWidth - track.clientWidth
    setOverflow(excess > 1)
    if (excess <= 1) { setActive(0); return }
    if (target) {
      if (Math.abs(track.scrollLeft - target.left) <= 1) { setActive(target.index); target = undefined }
      return
    }
    setActive(Math.min(props.sessions.length - 1, Math.round(track.scrollLeft / excess * (props.sessions.length - 1))))
  }
  const showCard = (index: number) => {
    if (!track) return
    const card = track.children.item(index)
    if (!(card instanceof HTMLElement)) return
    const left = Math.max(0, Math.min(track.scrollWidth - track.clientWidth,
      track.scrollLeft + card.getBoundingClientRect().left - track.getBoundingClientRect().left))
    target = { index, left }
    setActive(index)
    track.scrollTo({ left, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })
  }
  createEffect(() => {
    if (props.sessions.length === 0 || !track) { setOverflow(false); return }
    const observer = new ResizeObserver(measure)
    observer.observe(track)
    window.addEventListener("resize", measure)
    frame = requestAnimationFrame(measure)
    onCleanup(() => { observer.disconnect(); window.removeEventListener("resize", measure); cancelAnimationFrame(frame) })
  })
  return <Show when={props.sessions.length > 0}>
    <section class="running-sessions" aria-labelledby="running-sessions-title">
      <h2 id="running-sessions-title">Running and recent</h2>
      <ul class="running-sessions__list" ref={track} onScroll={measure} onWheel={() => { target = undefined }} onTouchStart={() => { target = undefined }}>
        <For each={props.sessions}>
          {(session, index) => {
            const lastActive = session.updatedAt > 0 ? new Date(session.updatedAt) : undefined
            return <li role="group" aria-label={`${index() + 1} of ${props.sessions.length}`}>
            <button type="button" class="running-sessions__item"
              aria-label={`Open ${session.title} in ${session.workspaceName}`}
              onClick={() => props.onSelectSession(session.id)}>
              <span class="running-sessions__title">{session.title}</span>
              <span class="running-sessions__workspace">{session.workspaceName}</span>
              <span class="running-sessions__status">
                <Show when={session.running} fallback={lastActive === undefined ? "Last active not reported" : <time dateTime={lastActive.toISOString()}>Last active {lastActive.toLocaleString()}</time>}>
                  <span aria-hidden="true" class="running-sessions__dot" />Running
                </Show>
              </span>
            </button>
          </li>}}
        </For>
      </ul>
      <Show when={overflow()}><div class="running-sessions__pagination" role="group" aria-label="Session carousel pages">
        <For each={props.sessions}>{(_, index) => <button type="button" aria-label={`Show Session ${index() + 1} of ${props.sessions.length}`} aria-current={active() === index() ? "true" : undefined} onClick={() => showCard(index())} />}</For>
      </div></Show>
    </section>
  </Show>
}
