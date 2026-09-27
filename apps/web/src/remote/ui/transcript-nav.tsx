import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "../../ui/icon"
import { useRemote } from "../context"
import type { RemoteMessageView } from "../projection"
import { MessageRow } from "./conversation"
import "./transcript-nav.css"

export function followState(following: boolean, event: { readonly kind: "scroll" | "content" | "jump" | "session"; readonly distance: number }): boolean {
  if (event.kind === "session" || event.kind === "jump") return true
  if (event.kind === "content") return following
  return event.distance <= 48
}

export function promptPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length > 90 ? `${normalized.slice(0, 89)}…` : normalized
}

export function TranscriptNavigation(props: { readonly messages: () => readonly RemoteMessageView[] }): JSX.Element {
  const remote = useRemote()
  const [away, setAway] = createSignal(false)
  const [visible, setVisible] = createSignal<ReadonlySet<string>>(new Set())
  const [hovered, setHovered] = createSignal<string>()
  const [tooltipTop, setTooltipTop] = createSignal(0)
  const [main, setMain] = createSignal<HTMLElement>()
  const [jumpPosition, setJumpPosition] = createSignal({ left: 0, bottom: 0 })
  const ids = createMemo(() => props.messages().map((message) => message.id))
  const prompts = createMemo(() => props.messages().filter((message): message is Extract<RemoteMessageView, { kind: "user" }> => message.kind === "user"))
  const message = (id: string) => props.messages().find((entry) => entry.id === id)!
  const preview = (id: string) => {
    const item = message(id)
    return item.kind === "user" ? promptPreview(item.text) : ""
  }
  let wrapper: HTMLDivElement | undefined
  let railSlot: HTMLDivElement | undefined
  let scrollRoot: HTMLElement | undefined
  let following = true
  let jumping = false
  let contentUpdate = false
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
  const onScroll = () => {
    if (contentUpdate && following) return
    if (jumping && distance() > 48) return
    if (distance() <= 48) jumping = false
    following = followState(following, { kind: "scroll", distance: distance() })
    setAway(!following)
    showPromptsInView()
  }
  const onUserScroll = () => { jumping = false; contentUpdate = false }
  const jump = () => {
    if (!scrollRoot) return
    following = followState(following, { kind: "jump", distance: distance() })
    jumping = true
    setAway(false)
    scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })
  }
  const selectPrompt = (id: string) => {
    if (!wrapper || !scrollRoot) return
    const row = [...wrapper.querySelectorAll<HTMLElement>("[data-message-id]")].find((item) => item.dataset.messageId === id)
    if (!row) return
    jumping = false
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
    setMain(container)
    const positionJump = () => {
      const bounds = container.getBoundingClientRect()
      const composer = container.querySelector<HTMLElement>(".composer")
      const reference = composer?.getBoundingClientRect() ?? scrollRoot!.getBoundingClientRect()
      setJumpPosition({ left: (reference.left + reference.right) / 2 - bounds.left, bottom: bounds.bottom - reference.top + 12 })
    }
    const observer = new ResizeObserver(() => {
      positionJump()
      if (following) pin()
      showPromptsInView()
    })
    observer.observe(wrapper)
    observer.observe(scrollRoot)
    observer.observe(container)
    const composer = container.querySelector<HTMLElement>(".composer")
    if (composer) observer.observe(composer)
    scrollRoot.addEventListener("scroll", onScroll, { passive: true })
    scrollRoot.addEventListener("wheel", onUserScroll, { passive: true })
    scrollRoot.addEventListener("touchstart", onUserScroll, { passive: true })
    scrollRoot.addEventListener("pointerdown", onUserScroll, { passive: true })
    positionJump()
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
    props.messages()
    if (current !== sessionID) {
      sessionID = current
      following = followState(following, { kind: "session", distance: distance() })
      jumping = false
    }
    contentUpdate = following
    schedule()
  })

  return <div class="transcript-navigation" ref={wrapper}>
    <div class="transcript-navigation__rail-slot" ref={railSlot}>
      <Show when={prompts().length > 0}>
        <nav class="transcript-navigation__rail" aria-label="Conversation prompts">
          <For each={prompts().map((prompt) => prompt.id)}>{(id) => <button type="button" class="transcript-navigation__tick" classList={{ "transcript-navigation__tick--visible": visible().has(id) }} aria-label={`Go to prompt: ${preview(id)}`} onMouseEnter={(event) => revealPrompt(id, event.currentTarget)} onMouseLeave={(event) => { if (document.activeElement !== event.currentTarget) setHovered(undefined) }} onFocus={(event) => revealPrompt(id, event.currentTarget)} onBlur={() => setHovered(undefined)} onClick={() => selectPrompt(id)}><span class="transcript-navigation__tick-mark" /></button>}</For>
        </nav>
        <Show when={hovered()}>{(id) => <div class="transcript-navigation__tooltip" role="tooltip" style={{ top: `${tooltipTop()}px` }}>{preview(id())}</div>}</Show>
      </Show>
    </div>
    <ol class="transcript"><For each={ids()}>{(id) => <li class="transcript-navigation__item" data-message-id={id} data-prompt-id={message(id).kind === "user" ? id : undefined} tabindex={message(id).kind === "user" ? -1 : undefined}><MessageRow message={() => message(id)} /></li>}</For></ol>
    <Show when={main()}>{(container) => <Portal mount={container()}><button type="button" class="transcript-navigation__jump" classList={{ "transcript-navigation__jump--visible": away() }} aria-label="Jump to latest" aria-hidden={!away()} tabIndex={away() ? 0 : -1} style={{ left: `${jumpPosition().left}px`, bottom: `${jumpPosition().bottom}px` }} onClick={jump}><Icon name="arrow-down" size={20} /></button></Portal>}</Show>
  </div>
}
