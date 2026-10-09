import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import { createThrottler } from "@tanstack/solid-pacer"
import type { SessionInfoView } from "../store"
import { LoadingPlaceholder } from "./loading"
import "./running-sessions.css"

export function RunningSessions(props: {
  readonly sessions: readonly (SessionInfoView & { readonly workspaceName: string })[]
  readonly loading?: boolean
  readonly onSelectSession: (sessionID: string) => void
}): JSX.Element {
  const [active, setActive] = createSignal(0)
  const [overflow, setOverflow] = createSignal(false)
  let track: HTMLUListElement | undefined
  let target: { readonly index: number; readonly left: number } | undefined
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
  const pacedMeasure = createThrottler(measure, { wait: 50 })
  // Mouse drag scrolls the rail; a press that travels under the slop stays an ordinary click.
  const dragSlop = 6
  let drag: { readonly pointerID: number; readonly startX: number; readonly startLeft: number; moved: boolean } | undefined
  const onPointerDown = (event: PointerEvent) => {
    if (!track || event.pointerType !== "mouse" || event.button !== 0) return
    drag = { pointerID: event.pointerId, startX: event.clientX, startLeft: track.scrollLeft, moved: false }
    target = undefined
  }
  const onPointerMove = (event: PointerEvent) => {
    if (!track || !drag || event.pointerId !== drag.pointerID) return
    const delta = event.clientX - drag.startX
    if (!drag.moved) {
      if (Math.abs(delta) < dragSlop) return
      drag.moved = true
      track.setPointerCapture(event.pointerId)
      track.dataset.cursor = "panning"
    }
    track.scrollLeft = drag.startLeft - delta
  }
  let suppressClick = false
  const endDrag = (event: PointerEvent) => {
    if (!track || !drag || event.pointerId !== drag.pointerID) return
    const moved = drag.moved
    drag = undefined
    if (!moved) return
    // The click that follows a drag release must not open the card under the pointer.
    suppressClick = event.type === "pointerup"
    track.dataset.cursor = "pan"
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId)
    measure()
  }
  const onClickCapture = (event: MouseEvent) => {
    if (!suppressClick) return
    suppressClick = false
    event.stopPropagation()
    event.preventDefault()
  }
  createEffect(() => {
    if (props.sessions.length === 0 || !track) { setOverflow(false); return }
    const observer = new ResizeObserver(pacedMeasure.maybeExecute)
    observer.observe(track)
    window.addEventListener("resize", pacedMeasure.maybeExecute)
    measure()
    onCleanup(() => { observer.disconnect(); window.removeEventListener("resize", pacedMeasure.maybeExecute); pacedMeasure.cancel() })
  })
  return <Show when={props.loading || props.sessions.length > 0}>
    <section class={`running-sessions${props.loading ? " running-sessions--loading" : " running-sessions--ready"}`} aria-labelledby="running-sessions-title" aria-busy={props.loading === true}>
      <h2 id="running-sessions-title">Running and recent</h2>
      <ul class="running-sessions__list" data-cursor="pan" ref={track} onScroll={pacedMeasure.maybeExecute} onWheel={() => { target = undefined }} onTouchStart={() => { target = undefined }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} on:click={{ capture: true, handleEvent: onClickCapture }}>
        <Show when={props.loading && props.sessions.length === 0}><For each={[0, 1, 2]}>{(index) => <li><LoadingPlaceholder kind="session" label="Loading running and recent sessions…" announce={index === 0} /></li>}</For></Show>
        <For each={props.sessions}>
          {(session, index) => {
            const lastActive = session.activeAt !== undefined ? new Date(session.activeAt) : undefined
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
