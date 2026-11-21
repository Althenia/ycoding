import { createEffect, onCleanup, onMount } from "solid-js"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function PendingPreview(props: { readonly class: string; readonly text: string }) {
  let node!: HTMLSpanElement
  const initial = props.text
  onMount(() => {
    const range = document.createRange()
    const fit = () => {
      const text = props.text
      const width = node.getBoundingClientRect().width
      const fits = (preview: string) => {
        node.textContent = preview
        range.selectNodeContents(node)
        return range.getBoundingClientRect().width <= width
      }
      if (fits(text)) return
      const ends = [0, ...Array.from(graphemes.segment(text), ({ index, segment }) => index + segment.length)]
      let lower = 0
      let upper = ends.length - 1
      while (lower < upper) {
        const middle = Math.ceil((lower + upper) / 2)
        if (fits(text.slice(0, ends[middle]).trimEnd() + "..")) lower = middle
        else upper = middle - 1
      }
      node.textContent = text.slice(0, ends[lower]).trimEnd() + ".."
    }
    const observer = new ResizeObserver(fit)
    observer.observe(node)
    document.fonts.addEventListener("loadingdone", fit)
    createEffect(fit)
    onCleanup(() => {
      observer.disconnect()
      document.fonts.removeEventListener("loadingdone", fit)
    })
  })
  return <span class={props.class} ref={node} title={props.text}>{initial}</span>
}
