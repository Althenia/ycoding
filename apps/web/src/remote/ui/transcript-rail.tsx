import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
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

export function promptPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length > 90 ? `${normalized.slice(0, 89)}…` : normalized
}

export type PromptTick = { readonly id: string; readonly text: string }

export function promptTicks<T>(items: readonly T[], prompt: (item: T) => PromptTick | undefined): readonly PromptTick[] {
  return items.flatMap((item) => {
    const tick = prompt(item)
    return tick ? [tick] : []
  })
}

export type Span = { readonly top: number; readonly bottom: number }

export function promptsInView(viewport: Span, prompts: readonly (Span & { readonly id: string })[]): ReadonlySet<string> {
  return new Set(prompts.filter((prompt) => prompt.top < viewport.bottom && prompt.bottom > viewport.top).map((prompt) => prompt.id))
}

export function sameSet(previous: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  return previous.size === next.size && [...next].every((id) => previous.has(id))
}

export function pillClearance(pill: { readonly left: number; readonly width: number; readonly bottom: number; readonly height: number; readonly gap: number }, obstacles: readonly (Span & { readonly left: number; readonly right: number })[]): number {
  return [...obstacles].sort((a, b) => b.top - a.top).reduce((offset: number, row) =>
    row.left < pill.left + pill.width && row.right > pill.left && row.top < pill.bottom - offset && row.bottom > pill.bottom - offset - pill.height
      ? pill.bottom - row.top + pill.gap : offset, 0)
}

export function JumpControls(props: { readonly onTop?: () => void; readonly onBottom?: () => void; readonly hidden?: boolean; readonly clearance?: number }): JSX.Element {
  return <div class="transcript-navigation__controls" style={{ "margin-block-end": `${props.clearance ?? 0}px` }} classList={{ "transcript-navigation__controls--visible": props.hidden !== true && (props.onTop !== undefined || props.onBottom !== undefined) }}><Show when={props.onTop}>{(jump) => <button type="button" aria-label="Jump to top" onClick={jump()}><Icon name="arrow-up" size={18} /></button>}</Show><Show when={props.onBottom}>{(jump) => <button type="button" aria-label="Jump to latest" onClick={jump()}><Icon name="arrow-down" size={18} /></button>}</Show></div>
}

export function PromptRail(props: { readonly prompts: readonly PromptTick[]; readonly visible: ReadonlySet<string>; readonly onSelect: (id: string) => void }): JSX.Element {
  const [hovered, setHovered] = createSignal<string>()
  const [tooltipTop, setTooltipTop] = createSignal(0)
  const ids = createMemo(() => props.prompts.map((prompt) => prompt.id), [], { equals: (previous, next) => previous.length === next.length && previous.every((id, index) => id === next[index]) })
  const previews = createMemo(() => new Map(props.prompts.map((prompt) => [prompt.id, promptPreview(prompt.text)])))
  const preview = (id: string) => previews().get(id) ?? ""
  let railSlot: HTMLDivElement | undefined
  const revealPrompt = (id: string, button: HTMLButtonElement) => {
    setHovered(id)
    setTooltipTop(button.getBoundingClientRect().top - (railSlot?.getBoundingClientRect().top ?? 0))
  }
  return <div class="transcript-navigation__rail-slot" ref={railSlot}>
    <Show when={ids().length > 0}>
      <nav class="transcript-navigation__rail" aria-label="Conversation prompts">
        <div class="transcript-navigation__ticks"><For each={ids()}>{(id) => <button type="button" class="transcript-navigation__tick" classList={{ "transcript-navigation__tick--visible": props.visible.has(id) }} aria-label={`Go to prompt: ${preview(id)}`} onMouseEnter={(event) => revealPrompt(id, event.currentTarget)} onMouseLeave={(event) => { if (document.activeElement !== event.currentTarget) setHovered(undefined) }} onFocus={(event) => revealPrompt(id, event.currentTarget)} onBlur={() => setHovered(undefined)} onClick={() => props.onSelect(id)}><span class="transcript-navigation__tick-mark" /></button>}</For></div>
      </nav>
      <Show when={hovered()}>{(id) => <div class="transcript-navigation__tooltip" role="tooltip" style={{ top: `${tooltipTop()}px` }}>{preview(id())}</div>}</Show>
    </Show>
  </div>
}
