import type { JSX } from "solid-js"

export type ChipTone = "neutral" | "attention" | "success" | "danger"

/**
 * A short state or metadata label shared by every surface.
 *
 * The tone carries the meaning (neutral, attention, success, danger) and the pill
 * shape, height, and pill radius are the same everywhere; a session row's meta line
 * renders the same element smaller by class, not by a second component.
 */
export function Chip(props: { readonly label: string; readonly tone?: ChipTone }): JSX.Element {
  const tone = () => (props.tone === undefined || props.tone === "neutral" ? "" : ` chip--${props.tone}`)
  return <span class={`chip${tone()}`}>{props.label}</span>
}
