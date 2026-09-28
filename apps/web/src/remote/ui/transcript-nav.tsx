import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "../../ui/icon"
import { useRemote } from "../context"
import { hasCompactionCheckpoint, visibleTranscriptMessages, type RemoteMessageView } from "../projection"
import { MessageRow } from "./conversation"
import { LoadingPlaceholder } from "./loading"
import "./transcript-nav.css"

export function followState(following: boolean, event: { readonly kind: "scroll" | "content" | "jump" | "top" | "session"; readonly distance: number }): boolean {
  if (event.kind === "top") return false
  if (event.kind === "session" || event.kind === "jump") return true
  if (event.kind === "content") return following
  return event.distance <= 48
}

export function navigationTargets(scrollTop: number, following: boolean) {
  return { top: scrollTop > 8, bottom: !following }
}

export function promptPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length > 90 ? `${normalized.slice(0, 89)}…` : normalized
}

export function TranscriptNavigation(props: { readonly messages: () => readonly RemoteMessageView[] }): JSX.Element {
  const remote = useRemote()
  const [away, setAway] = createSignal(false)
  const [scrollTop, setScrollTop] = createSignal(0)
  const [visible, setVisible] = createSignal<ReadonlySet<string>>(new Set())
  const [hovered, setHovered] = createSignal<string>()
  const [tooltipTop, setTooltipTop] = createSignal(0)
  const [jumpSlot, setJumpSlot] = createSignal<HTMLElement>()
  const targets = () => navigationTargets(scrollTop(), !away())
  const rows = createMemo(() => visibleTranscriptMessages(props.messages()))
  const checkpoint = createMemo(() => hasCompactionCheckpoint(props.messages()))
  const ids = createMemo(() => rows().map((message) => message.kind === "compaction" && message.jobID ? message.jobID : message.id))
  const prompts = createMemo(() => rows().filter((message): message is Extract<RemoteMessageView, { kind: "user" }> => message.kind === "user"))
  const message = (id: string) => rows().find((entry) => (entry.kind === "compaction" && entry.jobID ? entry.jobID : entry.id) === id)!
  const preview = (id: string) => {
    const item = message(id)
    return item.kind === "user" ? promptPreview(item.text) : ""
  }
  let wrapper: HTMLDivElement | undefined
  let railSlot: HTMLDivElement | undefined
  let scrollRoot: HTMLElement | undefined
  let following = true
  let jumping = false
  let jumpingTop = false
  let contentUpdate = false
  let loadingOlder = false
  let sessionID: string | undefined
  let frame = 0

  const distance = () => scrollRoot ? Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight - scrollRoot.scrollTop) : 0
  const showPromptsInView = () => {
    if (!wrapper || !scrollRoot) return
    const viewport = scrollRoot.getBoundingClientRect()
    const next = new Set([...wrapper.querySelectorAll<HTMLElement>("[data-prompt-id]")].filter((row) => {
      const bounds = row.getBoundingClientRect()
      return bounds.top < viewport.bottom && bounds.bottom > viewport.top
    }).map((row) => row.dataset.promptId!))
    setVisible((previous) => previous.size === next.size && [...next].every((id) => previous.has(id)) ? previous : next)
  }
  const pin = () => {
    if (!scrollRoot || !following) return
    scrollRoot.scrollTop = scrollRoot.scrollHeight
    setAway(false)
    setScrollTop(scrollRoot.scrollTop)
    showPromptsInView()
  }
  const schedule = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      pin()
      contentUpdate = false
      showPromptsInView()
    })
  }
  const loadOlder = async (preserve: boolean) => {
    if (!scrollRoot || !wrapper || loadingOlder || checkpoint() || remote.state().history?.status === "loading" || !remote.state().history?.before) return
    loadingOlder = true
    const anchor = preserve ? [...wrapper.querySelectorAll<HTMLElement>("[data-message-id]")].find((row) => row.getBoundingClientRect().bottom > scrollRoot!.getBoundingClientRect().top) : undefined
    const top = anchor?.getBoundingClientRect().top
    try {
      await remote.store.loadOlderMessages()
      requestAnimationFrame(() => {
        if (scrollRoot && anchor?.isConnected && top !== undefined) scrollRoot.scrollTop += anchor.getBoundingClientRect().top - top
        showPromptsInView()
      })
    } finally { loadingOlder = false }
  }
  const onScroll = () => {
    if (contentUpdate && following) return
    if (jumpingTop) {
      setScrollTop(scrollRoot?.scrollTop ?? 0)
      if ((scrollRoot?.scrollTop ?? 0) <= 8) jumpingTop = false
      showPromptsInView()
      return
    }
    if (jumping && distance() > 48) return
    if (distance() <= 48) jumping = false
    following = followState(following, { kind: "scroll", distance: distance() })
    setAway(!following)
    setScrollTop(scrollRoot?.scrollTop ?? 0)
    showPromptsInView()
    if (scrollRoot && scrollRoot.scrollTop < 120 && remote.state().history?.status === "idle") void loadOlder(true)
  }
  const onUserScroll = () => { jumping = false; jumpingTop = false; contentUpdate = false }
  const jumpToBottom = () => {
    if (!scrollRoot) return
    following = followState(following, { kind: "jump", distance: distance() })
    jumping = true
    jumpingTop = false
    setAway(false)
    scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })
  }
  const jumpToTop = () => {
    if (!scrollRoot) return
    following = followState(following, { kind: "top", distance: distance() })
    jumping = false
    jumpingTop = true
    setAway(true)
    scrollRoot.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })
    void loadOlder(false)
  }
  const selectPrompt = (id: string) => {
    if (!wrapper || !scrollRoot) return
    const row = [...wrapper.querySelectorAll<HTMLElement>("[data-message-id]")].find((item) => item.dataset.messageId === id)
    if (!row) return
    jumping = false
    jumpingTop = false
    following = false
    setAway(true)
    row.focus({ preventScroll: true })
    scrollRoot.scrollTo({ top: scrollRoot.scrollTop + row.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top - 12, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })
  }
  const revealPrompt = (id: string, button: HTMLButtonElement) => {
    setHovered(id)
    setTooltipTop(button.getBoundingClientRect().top - (railSlot?.getBoundingClientRect().top ?? 0))
  }

  onMount(() => {
    scrollRoot = wrapper?.closest<HTMLElement>(".workspace__scroll") ?? undefined
    const container = wrapper?.closest<HTMLElement>(".workspace__main")
    if (!scrollRoot || !container || !wrapper) return
    setJumpSlot(container.querySelector<HTMLElement>(".conversation-jump-slot") ?? undefined)
    const observer = new ResizeObserver(() => {
      if (following) pin()
      showPromptsInView()
    })
    observer.observe(wrapper)
    observer.observe(scrollRoot)
    observer.observe(container)
    scrollRoot.addEventListener("scroll", onScroll, { passive: true })
    scrollRoot.addEventListener("wheel", onUserScroll, { passive: true })
    scrollRoot.addEventListener("touchstart", onUserScroll, { passive: true })
    scrollRoot.addEventListener("pointerdown", onUserScroll, { passive: true })
    schedule()
    onCleanup(() => {
      observer.disconnect()
      scrollRoot?.removeEventListener("scroll", onScroll)
      scrollRoot?.removeEventListener("wheel", onUserScroll)
      scrollRoot?.removeEventListener("touchstart", onUserScroll)
      scrollRoot?.removeEventListener("pointerdown", onUserScroll)
      cancelAnimationFrame(frame)
    })
  })

  createEffect(() => {
    const current = remote.state().activeSessionID
    ids()
    rows()
    if (current !== sessionID) {
      sessionID = current
      following = followState(following, { kind: "session", distance: distance() })
      jumping = false
      jumpingTop = false
    }
    contentUpdate = following
    schedule()
  })

  return <div class="transcript-navigation" classList={{ "transcript-navigation--empty": rows().length === 0 }} ref={wrapper}>
    <div class="transcript-navigation__rail-slot" ref={railSlot}>
      <Show when={prompts().length > 0}>
        <nav class="transcript-navigation__rail" aria-label="Conversation prompts">
          <div class="transcript-navigation__ticks"><For each={prompts().map((prompt) => prompt.id)}>{(id) => <button type="button" class="transcript-navigation__tick" classList={{ "transcript-navigation__tick--visible": visible().has(id) }} aria-label={`Go to prompt: ${preview(id)}`} onMouseEnter={(event) => revealPrompt(id, event.currentTarget)} onMouseLeave={(event) => { if (document.activeElement !== event.currentTarget) setHovered(undefined) }} onFocus={(event) => revealPrompt(id, event.currentTarget)} onBlur={() => setHovered(undefined)} onClick={() => selectPrompt(id)}><span class="transcript-navigation__tick-mark" /></button>}</For></div>
          <div class="transcript-navigation__desktop-controls"><Show when={targets().top}><button type="button" aria-label="Jump to top" onClick={jumpToTop}><Icon name="arrow-up" size={16} /></button></Show><Show when={targets().bottom}><button type="button" aria-label="Jump to latest" onClick={jumpToBottom}><Icon name="arrow-down" size={16} /></button></Show></div>
        </nav>
        <Show when={hovered()}>{(id) => <div class="transcript-navigation__tooltip" role="tooltip" style={{ top: `${tooltipTop()}px` }}>{preview(id())}</div>}</Show>
      </Show>
    </div>
    <Show when={!checkpoint() && remote.state().history?.status === "loading"}><div class="transcript-navigation__history-loading"><LoadingPlaceholder kind="history" label="Loading older messages…" /></div></Show>
    <Show when={!checkpoint() && remote.state().history?.status === "idle" && !remote.state().history?.before}><p class="transcript-navigation__beginning">Beginning of conversation</p></Show>
    <Show when={!checkpoint() && remote.state().history?.status === "error"}><p class="transcript-navigation__history-error" role="alert">{remote.state().history?.error} <button type="button" onClick={() => void loadOlder(true)}>Retry older history</button></p></Show>
    <ol class="transcript"><For each={ids()}>{(id) => <li class="transcript-navigation__item" data-message-id={id} data-prompt-id={message(id).kind === "user" ? id : undefined} tabindex={message(id).kind === "user" ? -1 : undefined}><MessageRow message={() => message(id)} /></li>}</For></ol>
    <Show when={jumpSlot()}>{(slot) => <Portal mount={slot()}><div class="transcript-navigation__mobile-controls" classList={{ "transcript-navigation__mobile-controls--visible": targets().top || targets().bottom }}><Show when={targets().top}><button type="button" aria-label="Jump to top" onClick={jumpToTop}><Icon name="arrow-up" size={18} /></button></Show><Show when={targets().bottom}><button type="button" aria-label="Jump to latest" onClick={jumpToBottom}><Icon name="arrow-down" size={18} /></button></Show></div></Portal>}</Show>
  </div>
}
