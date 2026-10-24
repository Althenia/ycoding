import { expect, test } from "bun:test"
import type { YCodingEvent } from "@ycoding-ai/client"
import { directory, json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_chrono_screen01"
const step = "msg_chrono_step0001"
const next = "msg_chrono_step0002"
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const model = { providerID: "fixture", id: "fixture" }
const info = {
  id: sessionID,
  title: "Chronology",
  projectID: "proj_test",
  location: { directory },
  agent: "build",
  cost: 0,
  tokens,
  time: { created: 1, updated: 1 },
}
const prompt = {
  id: "msg_chrono_prompt01",
  type: "user",
  text: "Run the release check.",
  files: [],
  agents: [],
  time: { created: 900, consumed: 901 },
}

type Screen = Awaited<ReturnType<typeof renderScreen>>
let durableSequence = 0

async function mount(messages: readonly unknown[] = [prompt]) {
  durableSequence = 0
  return renderScreen({
    width: 120,
    height: 40,
    args: { sessionID },
    settle: "Run the release check.",
    config: { animations: false, session: { sidebar: "hide" } },
    sessionReady: true,
    route: (url, request) => {
      if (url.pathname === `/api/session/${sessionID}/wait` && request.method === "POST") return new Response(null, { status: 204 })
      if (request.method !== "GET") return undefined
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: info })
      if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, messages, { session: info })
      return undefined
    },
  })
}

const sequence = { value: 0 }
function emit(screen: Screen, type: string, created: number, data: Record<string, unknown>, id = `evt_chrono_${++sequence.value}`) {
  screen.events.emit({
    id,
    type,
    created,
    location: { directory },
    ...(type.endsWith(".delta") ? {} : { durable: { aggregateID: sessionID, seq: ++durableSequence, version: 1 } }),
    data: { sessionID, ...data },
  } as unknown as YCodingEvent)
}

async function until(screen: Screen, check: () => boolean, label: string) {
  for (let i = 0; i < 300 && !check(); i++) {
    await screen.renderOnce()
    await Bun.sleep(10)
  }
  if (!check()) throw new Error(`Timed out waiting for ${label}:\n${screen.frame()}`)
}

function order(screen: Screen, texts: string[]) {
  const lines = screen.frame().split("\n")
  return texts.map((text) => lines.findIndex((line) => line.includes(text)))
}

function count(screen: Screen, text: string) {
  return screen.frame().split(text).length - 1
}

function text(screen: Screen, created: number, ordinal: number, value: string) {
  emit(screen, "session.text.started", created, { assistantMessageID: step, ordinal })
  emit(screen, "session.text.delta", created + 1, { assistantMessageID: step, ordinal, delta: value })
  emit(screen, "session.text.ended", created + 2, { assistantMessageID: step, ordinal, text: value })
}

function notice(screen: Screen, created: number, description: string, id: string) {
  emit(screen, "session.synthetic", created, { text: description, description }, id)
}

test("a text part started after a mid-step notice streams below it and stays there through reconcile and completion", async () => {
  const screen = await mount()
  try {
    await screen.waitForEventStream()
    emit(screen, "session.execution.started", 999, {})
    emit(screen, "session.step.started", 1_000, { assistantMessageID: step, agent: "build", model })
    text(screen, 1_001, 0, "Alpha older text")
    notice(screen, 1_010, "Docs check finished", "evt_chrono_notice01")
    text(screen, 1_020, 1, "Bravo fresh text")
    await until(screen, () => screen.frame().includes("Bravo fresh text"), "fresh text")
    notice(screen, 1_030, "Lint sweep finished", "evt_chrono_notice02")
    await until(screen, () => screen.frame().includes("Lint sweep finished"), "second notice")
    const live = order(screen, ["Alpha older text", "Docs check finished", "Bravo fresh text", "Lint sweep finished"])
    expect(live.every((index) => index > -1)).toBe(true)
    expect(live).toEqual(live.toSorted((left, right) => left - right))
    emit(screen, "session.step.ended", 1_040, { assistantMessageID: step, finish: "stop", cost: 0, tokens })
    await until(screen, () => screen.frame().includes("fixture/fixture"), "completion footer")
    const settled = order(screen, ["Alpha older text", "Docs check finished", "Bravo fresh text", "Lint sweep finished"])
    expect(settled).toEqual(settled.toSorted((left, right) => left - right))
    emit(screen, "session.step.started", 1_050, { assistantMessageID: next, agent: "build", model })
    emit(screen, "session.text.started", 1_051, { assistantMessageID: next, ordinal: 0 })
    emit(screen, "session.text.delta", 1_052, { assistantMessageID: next, ordinal: 0, delta: "Charlie next step" })
    await until(screen, () => screen.frame().includes("Charlie next step"), "next step text")
    const all = order(screen, ["Alpha older text", "Docs check finished", "Bravo fresh text", "Lint sweep finished", "Charlie next step"])
    expect(all).toEqual(all.toSorted((left, right) => left - right))
    await until(screen, () => screen.frame().includes("⋯ Typing"), "live-tail typing indicator")
    expect(order(screen, ["Charlie next step", "⋯ Typing"])[1]).toBeGreaterThan(order(screen, ["Charlie next step", "⋯ Typing"])[0])
    emit(screen, "session.execution.succeeded", 1_060, {})
    await until(screen, () => !screen.frame().includes("⋯ Typing"), "settled indicator removal")
  } finally {
    await screen.dispose()
  }
}, 40_000)

test("text that continues an open text part after a mid-step notice streams below the notice", async () => {
  const screen = await mount()
  try {
    await screen.waitForEventStream()
    emit(screen, "session.execution.started", 999, {})
    emit(screen, "session.step.started", 1_000, { assistantMessageID: step, agent: "build", model })
    emit(screen, "session.text.started", 1_001, { assistantMessageID: step, ordinal: 0 })
    emit(screen, "session.text.delta", 1_002, { assistantMessageID: step, ordinal: 0, delta: "Alpha older text" })
    notice(screen, 1_010, "Docs check finished", "evt_chrono_notice01")
    await until(screen, () => screen.frame().includes("Docs check finished"), "notice")
    emit(screen, "session.text.delta", 1_020, { assistantMessageID: step, ordinal: 0, delta: "\n\nCharlie continued" })
    await until(screen, () => screen.frame().includes("Charlie continued"), "continued text")
    const live = order(screen, ["Alpha older text", "Docs check finished", "Charlie continued"])
    expect(live.every((index) => index > -1)).toBe(true)
    expect(live).toEqual(live.toSorted((left, right) => left - right))
    expect(count(screen, "Alpha older text")).toBe(1)
    expect(count(screen, "Charlie continued")).toBe(1)
    emit(screen, "session.text.ended", 1_030, {
      assistantMessageID: step,
      ordinal: 0,
      text: "Alpha older text\n\nCharlie continued",
      breaks: [{ offset: 16, after: "msg_chrono_notice01" }],
    })
    emit(screen, "session.step.ended", 1_040, { assistantMessageID: step, finish: "stop", cost: 0, tokens })
    await until(screen, () => screen.frame().includes("fixture/fixture"), "completion footer")
    const settled = order(screen, ["Alpha older text", "Docs check finished", "Charlie continued", "fixture/fixture"])
    expect(settled).toEqual(settled.toSorted((left, right) => left - right))
    expect(count(screen, "Alpha older text")).toBe(1)
    expect(count(screen, "Charlie continued")).toBe(1)
  } finally {
    await screen.dispose()
  }
}, 40_000)

test("a notice preceding a text start in the same millisecond stays before that text on settlement", async () => {
  const screen = await mount()
  try {
    await screen.waitForEventStream()
    emit(screen, "session.execution.started", 999, {})
    emit(screen, "session.step.started", 1_000, { assistantMessageID: step, agent: "build", model })
    text(screen, 1_001, 0, "Alpha older text")
    notice(screen, 1_010, "Docs check finished", "evt_chrono_tie")
    emit(screen, "session.text.started", 1_010, { assistantMessageID: step, ordinal: 1 })
    emit(screen, "session.text.delta", 1_010, { assistantMessageID: step, ordinal: 1, delta: "Bravo same millisecond" })
    await until(screen, () => screen.frame().includes("Bravo same millisecond") && screen.frame().includes("Docs check finished"), "same-time text and notice")
    const live = order(screen, ["Alpha older text", "Docs check finished", "Bravo same millisecond"])
    expect(live.every((index) => index > -1), screen.frame()).toBe(true)
    expect(live).toEqual(live.toSorted((a, b) => a - b))
    emit(screen, "session.text.ended", 1_010, { assistantMessageID: step, ordinal: 1, text: "Bravo same millisecond", breaks: [{ offset: 0, after: "msg_chrono_tie" }] })
    emit(screen, "session.step.ended", 1_010, { assistantMessageID: step, finish: "stop", cost: 0, tokens })
    await until(screen, () => screen.frame().includes("fixture/fixture"), "same-time completion")
    const settled = order(screen, ["Alpha older text", "Docs check finished", "Bravo same millisecond"])
    expect(settled).toEqual(settled.toSorted((a, b) => a - b))
  } finally { await screen.dispose() }
}, 40_000)

test("interleaved live text preserves a reader's scrollback and remains ordered when returning to the tail", async () => {
  const screen = await mount([
    { ...prompt, id: "msg_chrono_old_prompt", text: "Earlier work", time: { created: 1, consumed: 2 } },
    { id: "msg_chrono_old_reply", type: "assistant", agent: "build", model, content: [{ type: "text", text: Array.from({ length: 50 }, (_, index) => `Earlier paragraph ${index}`).join("\n\n") }], time: { created: 3, completed: 4 }, finish: "stop", cost: 0, tokens },
    prompt,
  ])
  try {
    await screen.waitForEventStream()
    emit(screen, "session.execution.started", 999, {})
    emit(screen, "session.step.started", 1_000, { assistantMessageID: step, agent: "build", model })
    emit(screen, "session.text.started", 1_001, { assistantMessageID: step, ordinal: 0 })
    emit(screen, "session.text.delta", 1_002, { assistantMessageID: step, ordinal: 0, delta: "Alpha older text" })
    await until(screen, () => screen.frame().includes("Alpha older text"), "initial tail")
    const scroll = screen.scrollbox()
    if (!scroll) throw new Error("Missing transcript scrollbox")
    scroll.scrollTo(0)
    await screen.renderOnce()
    const top = scroll.scrollTop
    const height = scroll.scrollHeight
    notice(screen, 1_010, "Docs check finished", "evt_chrono_scroll_notice")
    emit(screen, "session.text.delta", 1_020, { assistantMessageID: step, ordinal: 0, delta: "\n\nCharlie continued" })
    await until(screen, () => scroll.scrollHeight > height, "new tail layout")
    expect(scroll.scrollTop).toBe(top)
    expect(screen.frame()).not.toContain("Charlie continued")
    scroll.scrollTo(scroll.scrollHeight)
    await until(screen, () => screen.frame().includes("Charlie continued") && screen.frame().includes("Docs check finished"), "returned tail text and notice")
    const tail = order(screen, ["Alpha older text", "Docs check finished", "Charlie continued"])
    expect(tail.every((index) => index > -1), screen.frame()).toBe(true)
    expect(tail).toEqual(tail.toSorted((a, b) => a - b))
  } finally { await screen.dispose() }
}, 40_000)

test("a reconnected transcript replays a mid-step notice between the text parts it arrived between", async () => {
  const screen = await mount([
    prompt,
    { id: step, type: "assistant", agent: "build", model,
      content: [
        { type: "text", text: "Alpha older text", time: { created: 1001, completed: 1003 } },
        { type: "text", text: "Bravo fresh text", time: { created: 1020, completed: 1022 } },
      ], finish: "stop", cost: 0, tokens, time: { created: 1000, completed: 1040 } },
    { id: "msg_chrono_notice01", type: "synthetic", text: "Docs check finished", description: "Docs check finished", time: { created: 1010 } },
  ])
  try {
    await until(screen, () => screen.frame().includes("Docs check finished"), "replayed notice")
    const replayed = order(screen, ["Alpha older text", "Docs check finished", "Bravo fresh text"])
    expect(replayed.every((index) => index > -1)).toBe(true)
    expect(replayed).toEqual(replayed.toSorted((left, right) => left - right))
  } finally {
    await screen.dispose()
  }
}, 40_000)

test("a reconnected transcript splits an open text part at its recorded break around the notice", async () => {
  const screen = await mount([
    prompt,
    { id: step, type: "assistant", agent: "build", model,
      content: [{ type: "text", text: "Alpha older text\n\nCharlie continued", time: { created: 1001, completed: 1030 }, breaks: [{ offset: 16, after: "msg_chrono_notice01" }] }],
      finish: "stop", cost: 0, tokens, time: { created: 1000, completed: 1040 } },
    { id: "msg_chrono_notice01", type: "synthetic", text: "Docs check finished", description: "Docs check finished", time: { created: 1010 } },
  ])
  try {
    await until(screen, () => screen.frame().includes("Charlie continued"), "replayed continuation")
    const replayed = order(screen, ["Alpha older text", "Docs check finished", "Charlie continued", "fixture/fixture"])
    expect(replayed.every((index) => index > -1)).toBe(true)
    expect(replayed).toEqual(replayed.toSorted((left, right) => left - right))
    expect(count(screen, "Alpha older text")).toBe(1)
    expect(count(screen, "Charlie continued")).toBe(1)
  } finally {
    await screen.dispose()
  }
}, 40_000)

for (const scenario of [
  { name: "notice clocks outside the Step", first: 950, second: 2000 },
  { name: "identical notice clocks and reversed message identities", first: 1000, second: 1000 },
]) test(`recorded notice anchors override ${scenario.name} after serialization and reload`, async () => {
  const messages = JSON.parse(JSON.stringify([
    prompt,
    { id: step, type: "assistant", agent: "build", model,
      content: [{ type: "text", text: "Alpha older text\n\nCharlie continued", time: { created: 1010, completed: 1030 },
        breaks: [{ offset: 16, after: "msg_chrono_z_first" }, { offset: 16, after: "msg_chrono_a_second" }] }],
      finish: "stop", cost: 0, tokens, time: { created: 1000, completed: 1040 } },
    { id: "msg_chrono_a_second", type: "synthetic", text: "Second anchored notice", description: "Second anchored notice", time: { created: scenario.second } },
    { id: "msg_chrono_z_first", type: "synthetic", text: "First anchored notice", description: "First anchored notice", time: { created: scenario.first } },
  ]))
  const screen = await mount(messages)
  try {
    await until(screen, () => screen.frame().includes("Charlie continued") && screen.frame().includes("Second anchored notice"), "anchored snapshot")
    const positions = order(screen, ["Alpha older text", "First anchored notice", "Second anchored notice", "Charlie continued", "fixture/fixture"])
    expect(positions.every((index) => index > -1)).toBe(true)
    expect(positions).toEqual(positions.toSorted((left, right) => left - right))
    for (const value of ["Alpha older text", "First anchored notice", "Second anchored notice", "Charlie continued"])
      expect(count(screen, value)).toBe(1)
  } finally {
    await screen.dispose()
  }
}, 40_000)

test("history without text timing keeps a mid-step notice after the step's text", async () => {
  const screen = await mount([
    prompt,
    { id: step, type: "assistant", agent: "build", model,
      content: [{ type: "text", text: "Alpha older text" }, { type: "text", text: "Bravo fresh text" }],
      finish: "stop", cost: 0, tokens, time: { created: 1000, completed: 1040 } },
    { id: "msg_chrono_notice01", type: "synthetic", text: "Docs check finished", description: "Docs check finished", time: { created: 1010 } },
  ])
  try {
    await until(screen, () => screen.frame().includes("Docs check finished"), "legacy notice")
    const legacyOrder = order(screen, ["Alpha older text", "Bravo fresh text", "fixture/fixture", "Docs check finished"])
    expect(legacyOrder.every((index) => index > -1)).toBe(true)
    expect(legacyOrder).toEqual(legacyOrder.toSorted((left, right) => left - right))
  } finally {
    await screen.dispose()
  }
}, 40_000)

test("an untimed snapshot text stays before its notice after live settlement", async () => {
  const screen = await mount([
    prompt,
    { id: step, type: "assistant", agent: "build", model, content: [{ type: "text", text: "Alpha older text" }], cost: 0, tokens, time: { created: 1000 } },
    { id: "msg_legacy_notice", type: "synthetic", text: "Docs check finished", description: "Docs check finished", time: { created: 1010 } },
  ])
  try {
    await screen.waitForEventStream()
    emit(screen, "session.text.ended", 1030, { assistantMessageID: step, ordinal: 0, text: "Alpha older text settled" })
    emit(screen, "session.step.ended", 1040, { assistantMessageID: step, agent: "build", model, cost: 0, tokens, finish: "stop" })
    await until(screen, () => screen.frame().includes("Alpha older text settled"), "legacy settlement")
    const positions = order(screen, ["Alpha older text settled", "fixture/fixture", "Docs check finished"])
    expect(positions.every((index) => index > -1)).toBe(true)
    expect(positions).toEqual(positions.toSorted((left, right) => left - right))
  } finally {
    await screen.dispose()
  }
}, 40_000)

test.each(["session-state", "team-view"] as const)("a hidden %s notice never splits one streaming text block", async (source) => {
  const screen = await mount()
  try {
    await screen.waitForEventStream()
    emit(screen, "session.execution.started", 999, {})
    emit(screen, "session.step.started", 1000, { assistantMessageID: step, agent: "build", model })
    emit(screen, "session.text.started", 1001, { assistantMessageID: step, ordinal: 0 })
    emit(screen, "session.text.delta", 1002, { assistantMessageID: step, ordinal: 0, delta: "Alpha" })
    emit(screen, "session.context.observed", 1010, { source, text: "Hidden state observation" })
    emit(screen, "session.text.delta", 1020, { assistantMessageID: step, ordinal: 0, delta: "Bravo" })
    await until(screen, () => screen.frame().includes("Bravo"), "continued text")
    expect(screen.frame()).toContain("AlphaBravo")
    expect(screen.frame()).not.toContain("Hidden state observation")
    emit(screen, "session.text.ended", 1030, { assistantMessageID: step, ordinal: 0, text: "AlphaBravo" })
    await until(screen, () => count(screen, "AlphaBravo") === 1, "settled contiguous text")
  } finally {
    await screen.dispose()
  }
}, 40_000)
