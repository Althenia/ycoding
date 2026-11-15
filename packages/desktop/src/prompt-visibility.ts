export type PromptIntersection = Pick<IntersectionObserverEntry, "target" | "isIntersecting"> & { readonly intersectionRect: Pick<DOMRectReadOnly, "height"> }

export function createPromptVisibility(input: {
  readonly root: Element
  readonly change: (visible: ReadonlySet<string>) => void
  readonly observer?: (callback: (entries: readonly PromptIntersection[]) => void, root: Element) => Pick<IntersectionObserver, "observe" | "unobserve" | "disconnect">
}) {
  let alive = true
  let visible = new Set<string>()
  const targets = new Map<Element, string>()
  const publish = (next: Set<string>) => {
    if (visible.size === next.size && [...next].every((id) => visible.has(id))) return
    visible = next
    input.change(next)
  }
  const observer = (input.observer ?? ((callback, root) => new IntersectionObserver(callback, { root })))((entries) => {
    if (!alive) return
    const next = new Set(visible)
    for (const entry of entries) {
      const id = targets.get(entry.target)
      if (!id) continue
      if (entry.isIntersecting && entry.intersectionRect.height > 0) next.add(id)
      else next.delete(id)
    }
    publish(next)
  }, input.root)
  return {
    sync(rows: readonly { readonly id: string; readonly node: Element }[]) {
      if (!alive) return
      const next = new Map(rows.map((row) => [row.node, row.id]))
      const retained = new Set(visible)
      for (const [node, id] of targets) {
        if (next.get(node) === id) continue
        targets.delete(node)
        retained.delete(id)
        observer.unobserve(node)
      }
      publish(retained)
      for (const [node, id] of next) {
        if (targets.get(node) === id) continue
        targets.set(node, id)
        observer.observe(node)
      }
    },
    dispose() { alive = false; observer.disconnect(); targets.clear(); visible = new Set() },
  }
}
