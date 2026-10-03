import { For, Show, createComputed, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { createDebouncer, createThrottler } from "@tanstack/solid-pacer"
import { Icon } from "../../ui/icon"
import { useRemote } from "../context"
import { hasCompactionCheckpoint, visibleTranscriptMessages, type RemoteMessageView } from "../projection"
import { MessageRow } from "./conversation"
import { LoadingPlaceholder } from "./loading"
import { createRowVirtualizer, sameKeys } from "./virtual-rows"
import "./transcript-nav.css"

export function followState(following: boolean, event: { readonly kind: "scroll" | "content" | "jump" | "top" | "session"; readonly distance: number }): boolean {
  if (event.kind === "top") return false
  if (event.kind === "session" || event.kind === "jump") return true
  if (event.kind === "content") return following
  return event.distance <= (following ? 48 : 1)
}

export function navigationTargets(scrollTop: number, following: boolean) {
  return { top: scrollTop > 8, bottom: !following }
}

export function jumpBehavior(): ScrollBehavior {
  return matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
}

export function JumpControls(props: { readonly onTop?: () => void; readonly onBottom?: () => void; readonly hidden?: boolean; readonly clearance?: number }): JSX.Element {
  return <div class="transcript-navigation__controls" style={{ "margin-block-end": `${props.clearance ?? 0}px` }} classList={{ "transcript-navigation__controls--visible": props.hidden !== true && (props.onTop !== undefined || props.onBottom !== undefined) }}><Show when={props.onTop}>{(jump) => <button type="button" aria-label="Jump to top" onClick={jump()}><Icon name="arrow-up" size={18} /></button>}</Show><Show when={props.onBottom}>{(jump) => <button type="button" aria-label="Jump to latest" onClick={jump()}><Icon name="arrow-down" size={18} /></button>}</Show></div>
}

export function rowKey(message: RemoteMessageView): string {
  return message.kind === "compaction" && message.jobID ? message.jobID : message.id
}

export function estimateRowHeight(message: RemoteMessageView | undefined): number {
  if (message === undefined) return 120
  if (message.kind === "compaction") return 196
  if (message.kind === "user") return 88
  return 160
}

export function promptPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length > 90 ? `${normalized.slice(0, 89)}…` : normalized
}

export type TranscriptPosition = { readonly top: number; readonly key?: string; readonly offset?: number }

export function TranscriptNavigation(props: { readonly messages: () => readonly RemoteMessageView[]; readonly active?: boolean; readonly position?: TranscriptPosition; readonly onPositioned?: () => void }): JSX.Element {
  const remote = useRemote()
  const [intent, setIntent] = createSignal<"following" | "leaving" | "reading">("following")
  const following = () => intent() === "following"
  const setFollowing = (value: boolean) => setIntent(value ? "following" : "reading")
  const away = () => !following()
  const [scrollTop, setScrollTop] = createSignal(0)
  const [visible, setVisible] = createSignal<ReadonlySet<string>>(new Set())
  const [hovered, setHovered] = createSignal<string>()
  const [tooltipTop, setTooltipTop] = createSignal(0)
  const [jumpSlot, setJumpSlot] = createSignal<HTMLElement>()
  const [clearance, setClearance] = createSignal(0)
  const targets = () => navigationTargets(scrollTop(), !away())
  const rows = createMemo(() => visibleTranscriptMessages(props.messages()))
  const checkpoint = createMemo(() => hasCompactionCheckpoint(props.messages()))
  const ids = createMemo(() => rows().map(rowKey), [], { equals: sameKeys })
  const byKey = createMemo(() => new Map(rows().map((entry) => [rowKey(entry), entry])))
  const prompts = createMemo(() => rows().filter((message): message is Extract<RemoteMessageView, { kind: "user" }> => message.kind === "user"))
  const preview = (id: string) => {
    const item = byKey().get(id)
    return item?.kind === "user" ? promptPreview(item.text) : ""
  }
  let wrapper: HTMLDivElement | undefined
  let railSlot: HTMLDivElement | undefined
  let list: HTMLOListElement | undefined
  let scrollRoot: HTMLElement | undefined
  let jumping = false
  let jumpingTop = false
  let selecting = false
  let touchY: number | undefined
  let contentUpdate = false
  let loadingOlder = false
  let sessionID: string | undefined
  let pendingFocus: string | undefined
  let mounted = false
  let pinnedTop: number | undefined
  let arrivals = new Set<string>()
  let known = new Set<string>()
  const active = () => props.active !== false

  const distance = () => scrollRoot ? Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight - scrollRoot.scrollTop) : 0
  const showPromptsInView = () => {
    if (!active() || !wrapper || !scrollRoot) return
    const viewport = scrollRoot.getBoundingClientRect()
    const next = new Set([...wrapper.querySelectorAll<HTMLElement>("[data-prompt-id]")].filter((row) => {
      const bounds = row.getBoundingClientRect()
      return bounds.top < viewport.bottom && bounds.bottom > viewport.top
    }).map((row) => row.dataset.promptId!))
    setVisible((previous) => previous.size === next.size && [...next].every((id) => previous.has(id)) ? previous : next)
    const slot = jumpSlot()
    const controls = slot?.querySelector<HTMLElement>(".transcript-navigation__controls")
    if (!slot || !controls) return
    const bounds = slot.getBoundingClientRect()
    const bottom = bounds.top + controls.offsetTop + controls.offsetHeight + clearance()
    const left = bounds.left + controls.offsetLeft
    const gap = Number.parseFloat(getComputedStyle(controls).bottom)
    setClearance([...scrollRoot.querySelectorAll<HTMLElement>(".request__actions")].map((row) => row.getBoundingClientRect()).sort((a, b) => b.top - a.top).reduce((offset, row) =>
      row.left < left + controls.offsetWidth && row.right > left && row.top < bottom - offset && row.bottom > bottom - offset - controls.offsetHeight
        ? bottom - row.top + gap : offset, 0))
  }
  const visibility = createThrottler(showPromptsInView, { wait: 100 })
  const settle = createDebouncer(() => {
    if (!jumping && !jumpingTop && !selecting) return
    const landed = selecting
    jumping = false
    jumpingTop = false
    selecting = false
    if (landed && scrollRoot) setFollowing(followState(following(), { kind: "scroll", distance: distance() }))
    pin()
  }, { wait: 120 })
  const endContentUpdate = createDebouncer(() => { contentUpdate = false }, { wait: 0 })
  const pin = () => {
    if (!active() || !scrollRoot || !following()) return
    virtual.write(scrollRoot, scrollRoot.scrollHeight - scrollRoot.clientHeight)
    pinnedTop = scrollRoot.scrollTop
    setScrollTop(scrollRoot.scrollTop)
    visibility.maybeExecute()
  }
  const historyHeader = createMemo(() => `${checkpoint()}:${remote.state().history?.status}:${remote.state().history?.before}`)
  const virtual = createRowVirtualizer({
    list: () => list,
    scroller: () => scrollRoot ??= wrapper?.closest<HTMLElement>(".workspace__scroll") ?? undefined,
    keys: ids,
    estimate: (index) => estimateRowHeight(rows()[index]),
    overscan: 8,
    scrollPaddingStart: 12,
    scrollEndThreshold: 48,
    layout: historyHeader,
    compensate: () => !following(),
    onChange: () => { if (mounted && following() && !jumping && !jumpingTop) pin() },
  })
  const restorePosition = () => {
    const position = props.position
    if (!position || !mounted || !active() || !scrollRoot) return
    if (position.key && !virtual.indexByKey().has(position.key)) {
      setFollowing(true)
      pin()
      props.onPositioned?.()
      return
    }
    const row = position.key ? list?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(position.key)}"]`) : undefined
    if (position.key && !row) { virtual.reveal(position.key); return }
    setFollowing(false)
    sessionID = remote.state().activeSessionID
    contentUpdate = false
    virtual.write(scrollRoot, row ? scrollRoot.scrollTop + row.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top - (position.offset ?? 0) : position.top)
    setScrollTop(scrollRoot.scrollTop)
    props.onPositioned?.()
  }
  createEffect(() => {
    props.position
    virtual.rendered()
    queueMicrotask(restorePosition)
  })
  const olderCheck = createThrottler(() => {
    if (scrollRoot && scrollRoot.scrollTop < 120 && remote.state().history?.status === "idle") void loadOlder()
  }, { wait: 100, leading: false })
  const loadOlder = async () => {
    if (!active() || loadingOlder || checkpoint() || remote.state().history?.status === "loading" || !remote.state().history?.before) return
    loadingOlder = true
    try { await remote.store.loadOlderMessages() } finally { loadingOlder = false }
  }
  const onScroll = () => {
    if (!active() || !scrollRoot || virtual.writing()) return
    if (intent() === "leaving" && distance() <= 1) return
    if (contentUpdate && following()) {
      pin()
      return
    }
    settle.maybeExecute()
    if (pinnedTop !== undefined && Math.abs(scrollRoot.scrollTop - pinnedTop) < 1) return
    pinnedTop = undefined
    if (selecting) {
      setScrollTop(scrollRoot.scrollTop)
      visibility.maybeExecute()
      return
    }
    if (jumpingTop) {
      setScrollTop(scrollRoot.scrollTop)
      if (scrollRoot.scrollTop <= 8) jumpingTop = false
      visibility.maybeExecute()
      return
    }
    if (jumping && distance() > 48) return
    if (distance() <= 48) jumping = false
    setFollowing(followState(following(), { kind: "scroll", distance: distance() }))
    setScrollTop(scrollRoot.scrollTop)
    visibility.maybeExecute()
    olderCheck.maybeExecute()
  }
  const onUserScroll = (event: Event) => {
    if (!active()) return
    jumping = false
    jumpingTop = false
    selecting = false
    pinnedTop = undefined
    if (event instanceof WheelEvent && event.deltaY < 0 && !event.ctrlKey && !event.metaKey) setIntent("leaving")
    if (event.type === "touchstart" && event instanceof TouchEvent) touchY = event.touches.length === 1 ? event.touches[0]?.clientY : undefined
    if (event instanceof KeyboardEvent && ["ArrowUp", "PageUp", "Home"].includes(event.key) && event.target instanceof HTMLElement && !event.target.closest("input, textarea, select, [contenteditable='true'], [role='slider'], [role='combobox'], [role='listbox'], [role='menu']")) setIntent("leaving")
  }
  const onTouchMove = (event: TouchEvent) => {
    if (!active() || touchY === undefined || event.touches.length !== 1) return
    const next = event.touches[0]?.clientY
    if (next === undefined) return
    if (next > touchY) setIntent("leaving")
    touchY = next
  }
  const jumpToBottom = () => {
    if (!scrollRoot) return
    setFollowing(followState(following(), { kind: "jump", distance: distance() }))
    jumping = true
    jumpingTop = false
    scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior: jumpBehavior() })
  }
  const jumpToTop = () => {
    if (!scrollRoot) return
    setFollowing(followState(following(), { kind: "top", distance: distance() }))
    jumping = false
    jumpingTop = true
    virtual.virtualizer.scrollToOffset(0, { behavior: jumpBehavior() })
    void loadOlder().then(() => { if (jumpingTop) virtual.virtualizer.scrollToOffset(0) })
  }
  const selectPrompt = (id: string) => {
    const index = virtual.indexByKey().get(id)
    if (!scrollRoot || index === undefined) return
    jumping = false
    jumpingTop = false
    selecting = true
    setFollowing(false)
    const row = list?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
    pendingFocus = row ? undefined : id
    if (!row) virtual.reveal(id)
    row?.focus({ preventScroll: true })
    virtual.virtualizer.scrollToIndex(index, { align: "start", behavior: jumpBehavior() })
  }
  const revealPrompt = (id: string, button: HTMLButtonElement) => {
    setHovered(id)
    setTooltipTop(button.getBoundingClientRect().top - (railSlot?.getBoundingClientRect().top ?? 0))
  }

  onMount(() => {
    mounted = true
    const root = scrollRoot ??= wrapper?.closest<HTMLElement>(".workspace__scroll") ?? undefined
    const container = wrapper?.closest<HTMLElement>(".workspace__main")
    if (!root || !container || !wrapper) return
    const content = wrapper
    setJumpSlot(container.querySelector<HTMLElement>(".conversation-jump-slot") ?? undefined)
    const observer = new ResizeObserver(() => {
      if (!active()) return
      if (following() && !jumping) pin()
      visibility.maybeExecute()
    })
    let observing = false
    const stop = () => {
      if (!observing) return
      observing = false
      touchY = undefined
      observer.disconnect()
      root.removeEventListener("scroll", onScroll, { capture: true })
      root.removeEventListener("wheel", onUserScroll)
      root.removeEventListener("touchstart", onUserScroll)
      root.removeEventListener("touchmove", onTouchMove)
      root.removeEventListener("pointerdown", onUserScroll)
      root.removeEventListener("keydown", onUserScroll)
      visibility.cancel()
      settle.cancel()
    }
    const start = () => {
      if (!active() || observing) return
      observing = true
      observer.observe(content)
      observer.observe(root)
      observer.observe(container)
      root.addEventListener("scroll", onScroll, { passive: true, capture: true })
      root.addEventListener("wheel", onUserScroll, { passive: true })
      root.addEventListener("touchstart", onUserScroll, { passive: true })
      root.addEventListener("touchmove", onTouchMove, { passive: true })
      root.addEventListener("pointerdown", onUserScroll, { passive: true })
      root.addEventListener("keydown", onUserScroll)
      setFollowing(props.position === undefined)
      jumping = false
      jumpingTop = false
      setScrollTop(root.scrollTop)
      if (props.position) virtual.write(root, props.position.top)
      else pin()
      restorePosition()
      visibility.maybeExecute()
    }
    start()
    createEffect(() => { if (active()) start(); else stop() })
    onCleanup(() => { mounted = false; stop() })
  })

  createComputed(() => {
    const current = ids()
    const session = remote.state().activeSessionID
    const arrived = session === sessionID ? new Set(current.filter((id) => !known.has(id))) : new Set(current)
    known = new Set(current)
    arrivals = arrived
    queueMicrotask(() => { if (arrivals === arrived) arrivals = new Set() })
  })

  createEffect(() => {
    const activeNow = active()
    const current = remote.state().activeSessionID
    rows()
    if (current !== sessionID) {
      sessionID = current
      setFollowing(props.position === undefined)
      jumping = false
      jumpingTop = false
    }
    contentUpdate = activeNow && following()
    endContentUpdate.maybeExecute()
    if (activeNow) pin()
  })

  return <div class="transcript-navigation" classList={{ "transcript-navigation--empty": rows().length === 0 }} ref={wrapper}>
    <div class="transcript-navigation__rail-slot" ref={railSlot}>
      <Show when={prompts().length > 0}>
        <nav class="transcript-navigation__rail" aria-label="Conversation prompts">
          <div class="transcript-navigation__ticks"><For each={prompts().map((prompt) => prompt.id)}>{(id) => <button type="button" class="transcript-navigation__tick" classList={{ "transcript-navigation__tick--visible": visible().has(id) }} aria-label={`Go to prompt: ${preview(id)}`} onMouseEnter={(event) => revealPrompt(id, event.currentTarget)} onMouseLeave={(event) => { if (document.activeElement !== event.currentTarget) setHovered(undefined) }} onFocus={(event) => revealPrompt(id, event.currentTarget)} onBlur={() => setHovered(undefined)} onClick={() => selectPrompt(id)}><span class="transcript-navigation__tick-mark" /></button>}</For></div>
        </nav>
        <Show when={hovered()}>{(id) => <div class="transcript-navigation__tooltip" role="tooltip" style={{ top: `${tooltipTop()}px` }}>{preview(id())}</div>}</Show>
      </Show>
    </div>
    <Show when={!checkpoint() && remote.state().history?.status === "loading"}><div class="transcript-navigation__history-loading"><LoadingPlaceholder kind="history" label="Loading older messages…" /></div></Show>
    <Show when={!checkpoint() && remote.state().history?.status === "idle" && !remote.state().history?.before}><p class="transcript-navigation__beginning">Beginning of conversation</p></Show>
    <Show when={!checkpoint() && remote.state().history?.status === "error"}><p class="transcript-navigation__history-error" role="alert">{remote.state().history?.error} <button type="button" onClick={() => void loadOlder()}>Retry older history</button></p></Show>
    <ol class="transcript" ref={list} style={{ "block-size": `${virtual.virtualizer.getTotalSize()}px` }}>
      <For each={virtual.rendered()}>{(id) => {
        const row = virtual.row(id)
        const settled = !arrivals.has(id)
        const item = createMemo<RemoteMessageView>((previous) => byKey().get(id) ?? previous, byKey().get(id)!)
        return <li class="transcript-navigation__item" data-message-id={id} data-index={row.index()} data-settled={settled ? "" : undefined} data-prompt-id={item().kind === "user" ? id : undefined} tabindex={item().kind === "user" ? -1 : undefined} style={{ "inset-block-start": `${row.top()}px` }}
          onFocusOut={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) virtual.release(id) }}
          ref={(element) => {
            row.measure(element)
            onMount(() => {
              if (pendingFocus !== id) return
              pendingFocus = undefined
              element.focus({ preventScroll: true })
            })
          }}><MessageRow message={item} /></li>
      }}</For>
    </ol>
    <Show when={jumpSlot()}>{(slot) => <Portal mount={slot()}><JumpControls hidden={!active()} clearance={clearance()} onTop={targets().top ? jumpToTop : undefined} onBottom={targets().bottom ? jumpToBottom : undefined} /></Portal>}</Show>
  </div>
}
