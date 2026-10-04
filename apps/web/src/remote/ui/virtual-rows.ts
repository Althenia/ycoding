import { createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { createVirtualizer, defaultRangeExtractor, measureElement, type Range, type Virtualizer } from "@tanstack/solid-virtual"

export function sameKeys(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length === next.length && previous.every((key, index) => key === next[index])
}

export function withPinnedIndex(range: Range, pinned: number | undefined): number[] {
  const indexes = defaultRangeExtractor(range)
  if (pinned === undefined || pinned < 0 || pinned >= range.count || indexes.includes(pinned)) return indexes
  return [...indexes, pinned].sort((left, right) => left - right)
}

export function scrollParent(element: HTMLElement): HTMLElement | undefined {
  for (let parent = element.parentElement; parent; parent = parent.parentElement)
    if (/auto|scroll|overlay/.test(getComputedStyle(parent).overflowY)) return parent
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : undefined
}

export type RowVirtualizerInput = {
  readonly list: () => HTMLElement | undefined
  readonly scroller: () => HTMLElement | undefined
  readonly keys: () => readonly string[]
  readonly estimate: (index: number) => number
  /** Rows of one list share a height, so unmeasured rows take the latest measured one and the total stays put as rows mount. */
  readonly typicalSize?: boolean
  readonly overscan: number
  readonly scrollPaddingStart?: number
  readonly scrollEndThreshold?: number
  readonly layout?: () => unknown
  readonly compensate?: () => boolean
  readonly onChange?: (instance: Virtualizer<HTMLElement, HTMLElement>) => void
}

/**
 * Windows one keyed list inside its nearest scroller. Keys, not indexes, own row identity and
 * measurements, so a prepend, trim or reorder keeps mounted rows and their sizes.
 */
export function createRowVirtualizer(input: RowVirtualizerInput) {
  const [margin, setMargin] = createSignal(0)
  const [gap, setGap] = createSignal(0)
  const [revealed, setRevealed] = createSignal<string>()
  const [thaws, setThaws] = createSignal(0)
  const indexByKey = createMemo(() => new Map(input.keys().map((key, index) => [key, index])))
  const keyAt = createMemo(() => {
    const keys = input.keys()
    return (index: number) => keys[index] ?? index
  })
  let measuredMargin = false
  let wasFrozen = false
  let typical: number | undefined
  let writing = false
  let attached: HTMLElement | undefined

  // The virtualizer writes its offset when it first sees a scroller, so it must start from the real one.
  const scroller = () => {
    const root = input.scroller()
    if (root !== undefined && root !== attached) {
      attached = root
      virtualizer.scrollOffset = null
    }
    return root
  }

  // The virtualizer learns the scroll offset from scroll events, which arrive a frame later. Its own
  // size corrections write from that stale offset, so a write made here is announced synchronously.
  const write = (root: HTMLElement, top: number) => {
    if (Math.abs(root.scrollTop - top) < 0.5) return
    root.scrollTop = top
    writing = true
    root.dispatchEvent(new Event("scroll"))
    writing = false
  }

  const focusedIndex = () => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !input.list()?.contains(active)) return undefined
    const row = active.closest<HTMLElement>("[data-index]")
    return row ? Number(row.dataset.index) : undefined
  }

  const virtualizer = createVirtualizer<HTMLElement, HTMLElement>({
    get count() { return input.keys().length },
    get getItemKey() { return keyAt() },
    get scrollMargin() { return margin() },
    get gap() { return gap() },
    getScrollElement: () => scroller() ?? null,
    initialOffset: () => input.scroller()?.scrollTop ?? 0,
    estimateSize: (index) => typical ?? input.estimate(index),
    overscan: input.overscan,
    scrollPaddingStart: input.scrollPaddingStart ?? 0,
    get scrollEndThreshold() { return input.compensate?.() === false ? input.scrollEndThreshold ?? 1 : -1 },
    anchorTo: "end",
    rangeExtractor: (range) => withPinnedIndex(range, focusedIndex()),
    measureElement: (element, entry, instance) => {
      if (element.offsetParent !== null) {
        const size = measureElement(element, entry, instance)
        if (input.typicalSize) typical = size
        return size
      }
      const index = instance.indexFromElement(element)
      return instance.itemSizeCache.get(instance.options.getItemKey(index)) ?? instance.measurementsCache[index]?.size ?? typical ?? input.estimate(index)
    },
    onChange: (instance) => input.onChange?.(instance),
  })

  // A list inside an inert panel is off screen while a shared scroller shows another page; its window must not follow that scroller.
  const frozen = () => input.list()?.offsetParent === null || input.list()?.closest("[inert]") != null

  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (frozen() || input.compensate?.() === false) return false
    const offset = input.scroller()?.scrollTop ?? instance.scrollOffset ?? 0
    return instance.itemSizeCache.has(item.key) ? item.end <= offset : item.start < offset
  }

  const measureLayout = () => {
    const list = input.list()
    const root = input.scroller()
    if (!list || !root) return
    const inert = frozen()
    if (inert !== wasFrozen) {
      wasFrozen = inert
      setThaws((count) => count + 1)
    }
    if (inert) return
    const rowGap = Number.parseFloat(getComputedStyle(list).rowGap)
    setGap(Number.isFinite(rowGap) ? rowGap : 0)
    const next = Math.round(list.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop)
    const previous = untrack(margin)
    if (next === previous) return
    setMargin(next)
    if (measuredMargin && root.scrollTop > previous && input.compensate?.() !== false) write(root, root.scrollTop + next - previous)
    measuredMargin = true
  }

  onMount(() => {
    const list = input.list()
    const root = input.scroller()
    if (!list || !root) return
    virtualizer._willUpdate()
    measureLayout()
    let scheduled: number | undefined
    const observer = new ResizeObserver(() => {
      if (scheduled !== undefined) return
      scheduled = requestAnimationFrame(() => {
        scheduled = undefined
        measureLayout()
      })
    })
    observer.observe(list)
    observer.observe(root)
    if (list.parentElement) observer.observe(list.parentElement)
    onCleanup(() => {
      observer.disconnect()
      if (scheduled !== undefined) cancelAnimationFrame(scheduled)
    })
  })

  createEffect(() => {
    input.layout?.()
    measureLayout()
  })

  // The virtualizer anchors a front change before the list's new height reaches the DOM, where the
  // browser clamps the write; repeat it once the DOM has caught up.
  let previousKeys = untrack(input.keys)
  createEffect(() => {
    const next = input.keys()
    const previous = previousKeys
    previousKeys = next
    const root = input.scroller()
    const anchored = untrack(() => virtualizer.scrollOffset)
    if (!root || anchored === null || previous.length === 0 || previous[0] === next[0]) return
    write(root, anchored)
  })

  const rendered = createMemo<readonly string[]>((previous) => {
    thaws()
    const items = virtualizer.getVirtualItems()
    const held = previous.length > 0 && frozen() || items.length === 0 && input.keys().length > 0
    const windowed = (held ? previous : items.map((item) => String(item.key))).filter((key) => indexByKey().has(key))
    const extra = revealed()
    if (extra === undefined || windowed.includes(extra) || !indexByKey().has(extra)) return windowed
    return [...windowed, extra].sort((left, right) => indexByKey().get(left)! - indexByKey().get(right)!)
  }, [], { equals: sameKeys })

  createEffect(() => {
    const extra = revealed()
    if (extra !== undefined && virtualizer.getVirtualItems().some((item) => item.key === extra)) setRevealed(undefined)
  })

  return {
    virtualizer,
    rendered,
    indexByKey,
    margin,
    write,
    writing: () => writing,
    reveal: setRevealed,
    release: (key: string) => setRevealed((current) => current === key ? undefined : current),
    row(key: string) {
      const index = createMemo(() => indexByKey().get(key) ?? -1)
      const top = createMemo((previous: number) => {
        const item = virtualizer.getVirtualItems().find((entry) => entry.key === key) ?? virtualizer.measurementsCache[index()]
        return item === undefined ? previous : item.start - margin()
      }, 0)
      onCleanup(() => virtualizer.measureElement(null))
      const measure = (element: HTMLElement) => createEffect(() => {
        index()
        virtualizer.measureElement(element)
      })
      return { index, top, measure }
    },
  }
}
