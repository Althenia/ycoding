import { expect, test } from "bun:test"
import { createPromptVisibility, type PromptIntersection } from "../src/prompt-visibility"

function fixture() {
  const observed: Element[] = []
  const removed: Element[] = []
  const published: ReadonlySet<string>[] = []
  let notify: (entries: readonly PromptIntersection[]) => void = () => {}
  let disconnected = false
  const visibility = createPromptVisibility({ root: {} as Element, change: (value) => published.push(value), observer: (callback) => {
    notify = callback
    return { observe: (node) => { observed.push(node) }, unobserve: (node) => { removed.push(node) }, disconnect: () => { disconnected = true } }
  } })
  const rows = Array.from({ length: 240 }, (_, index) => ({ id: `msg_prompt_${index}`, node: {} as Element }))
  return { visibility, observed, removed, published, rows, notify: (rows: readonly PromptIntersection[]) => notify(rows), disconnected: () => disconnected }
}

test("visible prompts follow intersection delivery without reobserving retained history", () => {
  const owned = fixture()
  try {
    owned.visibility.sync(owned.rows)
    expect(owned.observed).toHaveLength(240)
    owned.notify([{ target: owned.rows[100]!.node, isIntersecting: true, intersectionRect: { height: 10 } }, { target: owned.rows[101]!.node, isIntersecting: true, intersectionRect: { height: 10 } }])
    expect([...owned.published.at(-1)!]).toEqual(["msg_prompt_100", "msg_prompt_101"])
    owned.visibility.sync(owned.rows)
    owned.notify([{ target: owned.rows[100]!.node, isIntersecting: false, intersectionRect: { height: 0 } }, { target: owned.rows[102]!.node, isIntersecting: true, intersectionRect: { height: 10 } }])
    expect([...owned.published.at(-1)!]).toEqual(["msg_prompt_101", "msg_prompt_102"])
    expect(owned.observed).toHaveLength(240)
    expect(owned.removed).toEqual([])
  } finally { owned.visibility.dispose() }
})

test("zero-area intersections, retired nodes and disposed callbacks cannot highlight prompts", () => {
  const owned = fixture()
  owned.visibility.sync(owned.rows.slice(0, 2))
  owned.notify([{ target: owned.rows[0]!.node, isIntersecting: true, intersectionRect: { height: 0 } }])
  expect(owned.published).toEqual([])
  owned.notify([{ target: owned.rows[0]!.node, isIntersecting: true, intersectionRect: { height: 10 } }])
  owned.visibility.sync(owned.rows.slice(1, 2))
  expect([...owned.published.at(-1)!]).toEqual([])
  expect(owned.removed).toEqual([owned.rows[0]!.node])
  const count = owned.published.length
  owned.notify([{ target: owned.rows[0]!.node, isIntersecting: true, intersectionRect: { height: 10 } }])
  owned.visibility.dispose()
  owned.notify([{ target: owned.rows[1]!.node, isIntersecting: true, intersectionRect: { height: 10 } }])
  owned.visibility.sync(owned.rows)
  expect(owned.published).toHaveLength(count)
  expect(owned.observed).toHaveLength(2)
  expect(owned.disconnected()).toBe(true)
})
