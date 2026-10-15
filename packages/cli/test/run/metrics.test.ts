import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { YCoding, type EventSubscribeOutput } from "@ycoding-ai/client/promise"
import { createRunActivity, createRunMetrics, readRunUsage } from "../../src/run/metrics"

const tokens = (input: number, read = 0, write = 0) => ({
  input,
  output: 1,
  reasoning: 0,
  cache: { read, write },
})
const metrics = { logical: 1, physical: 1, helpers: 0, tokens: tokens(1) }
const row = (key: string) => ({ key, label: key, ...metrics })
const event = (type: string, sessionID: string) => ({ type, data: { sessionID } }) as unknown as EventSubscribeOutput

afterEach(() => mock.restore())

describe("createRunMetrics", () => {
  test("sums settled steps, tracks the largest input and the last reported limit, and dedupes models", () => {
    const run = createRunMetrics()
    run.started({ providerID: "p", id: "m", variant: "high" })
    run.settled({ tokens: tokens(100, 50, 5), cost: 0.5, contextLimit: 1000 })
    run.started({ providerID: "p", id: "m", variant: "high" })
    run.started({ providerID: "p", id: "m" })
    run.started({ providerID: "p", id: "m", profile: "Work" })
    run.settled({ tokens: tokens(20, 300), cost: 0.25, contextLimit: 2000 })
    run.settled({ contextLimit: 0 })
    expect(run.summary()).toEqual({
      steps: 3,
      tokens: { input: 120, output: 2, reasoning: 0, cache: { read: 350, write: 5 } },
      cost: 0.75,
      context: { limit: 2000, peakInput: 320 },
      models: [
        { providerID: "p", id: "m", variant: "high" },
        { providerID: "p", id: "m" },
        { providerID: "p", id: "m", profile: "Work" },
      ],
    })
  })

  test("reports no context fields when no step reported them", () => {
    const run = createRunMetrics()
    run.settled({})
    run.settled({ contextLimit: 0 })
    expect(run.summary()).toMatchObject({ steps: 2, cost: 0 })
    expect(run.summary().context).toEqual({})
  })
})

describe("createRunActivity", () => {
  const observe = (activity: ReturnType<typeof createRunActivity>, sessionID: string, types: string[]) =>
    types.forEach((type) => activity.observe(event(type, sessionID)))

  test("counts one drain with a mid-drain steer as one turn", () => {
    const activity = createRunActivity()
    observe(activity, "ses_a", [
      "session.execution.started",
      "session.input.promoted",
      "session.step.ended",
      "session.input.promoted",
      "session.step.failed",
      "session.step.ended",
      "session.execution.succeeded",
    ])
    expect(activity.turns("ses_a")).toBe(1)
    expect(activity.steps("ses_a")).toBe(3)
  })

  test("counts a notice that wakes an idle session as a second turn", () => {
    const activity = createRunActivity()
    observe(activity, "ses_a", [
      "session.execution.started",
      "session.input.promoted",
      "session.step.ended",
      "session.execution.succeeded",
      "session.execution.started",
      "session.input.promoted",
      "session.step.ended",
      "session.execution.interrupted",
      "session.execution.started",
      "session.input.promoted",
      "session.step.ended",
      "session.execution.failed",
    ])
    expect(activity.turns("ses_a")).toBe(3)
    expect(activity.steps("ses_a")).toBe(3)
  })

  test("does not count a drain that promoted no input", () => {
    const activity = createRunActivity()
    observe(activity, "ses_a", ["session.execution.started", "session.execution.succeeded"])
    expect(activity.turns("ses_a")).toBe(0)
    expect(activity.steps("ses_a")).toBe(0)
  })

  test("keeps sessions apart and ignores unrelated events", () => {
    const activity = createRunActivity()
    observe(activity, "ses_a", ["session.execution.started", "session.input.promoted", "session.step.ended"])
    observe(activity, "ses_b", ["session.execution.started", "session.step.ended", "session.text.ended"])
    expect([activity.turns("ses_a"), activity.steps("ses_a")]).toEqual([1, 1])
    expect([activity.turns("ses_b"), activity.steps("ses_b")]).toEqual([0, 1])
    expect([activity.turns("ses_c"), activity.steps("ses_c")]).toEqual([0, undefined])
  })
})

describe("readRunUsage", () => {
  test("pages every report row and every subagent page inside the window", async () => {
    const sdk = YCoding.make({ baseUrl: "https://ycoding.test" })
    const reports = spyOn(sdk.session, "usageReport").mockImplementation(((input: { offset?: number }) =>
      Promise.resolve(
        input.offset === undefined
          ? { group: "session", rows: [row("ses_root"), row("ses_a")], total: metrics, rowCount: 4, nextOffset: 2 }
          : { group: "session", rows: [row("ses_b"), row("ses_nested")], total: metrics, rowCount: 4 },
      )) as never)
    const lists = spyOn(sdk.session.subagent, "list").mockImplementation(((input: {
      parentID: string
      cursor?: string
    }) =>
      Promise.resolve({
        data:
          input.parentID === "ses_root"
            ? [
                input.cursor === undefined
                  ? { sessionID: "ses_a", agent: "worker", state: "completed" }
                  : { sessionID: "ses_b", agent: "worker", state: "running" },
              ]
            : input.parentID === "ses_a"
              ? [
                  input.cursor === undefined
                    ? { sessionID: "ses_nested", agent: "worker", state: "completed" }
                    : { sessionID: "ses_idle", agent: "worker", state: "starting" },
                ]
              : [],
        summary: { total: 0, active: 0, running: 0, waiting: 0 },
        cursor:
          ["ses_root", "ses_a"].includes(input.parentID) && input.cursor === undefined ? { next: "next-page" } : {},
      })) as never)
    spyOn(sdk.session, "get").mockImplementation((() => Promise.reject(new Error("unexpected helper read"))) as never)
    const activity = createRunActivity()
    ;[
      ...["session.execution.started", "session.input.promoted", "session.step.ended", "session.step.ended"].map(
        (type) => event(type, "ses_root"),
      ),
      ...["session.execution.started", "session.input.promoted", "session.step.ended", "session.step.failed"].map(
        (type) => event(type, "ses_a"),
      ),
    ].forEach((item) => activity.observe(item))
    const usage = await readRunUsage(sdk, "ses_root", { from: 100, to: 200 }, activity)
    expect(reports.mock.calls.map(([input]) => input)).toEqual([
      { sessionID: "ses_root", group: "session", from: 100, to: 200, limit: 200, offset: undefined },
      { sessionID: "ses_root", group: "session", from: 100, to: 200, limit: 200, offset: 2 },
    ])
    for (const parentID of ["ses_root", "ses_a"])
      expect(lists.mock.calls.filter(([input]) => input.parentID === parentID).map(([input]) => input.cursor)).toEqual([
        undefined,
        "next-page",
      ])
    expect(lists.mock.calls.map(([input]) => input.parentID)).toEqual(
      expect.arrayContaining(["ses_b", "ses_nested", "ses_idle"]),
    )
    expect(usage.total.requests).toEqual({ logical: 1, physical: 1, helpers: 0 })
    expect(usage.total).toMatchObject({ steps: 4, turns: 2 })
    expect(usage.total).not.toHaveProperty("cost")
    expect(usage.total).not.toHaveProperty("costProvenance")
    expect(usage.children.map((child) => [child.sessionID, child.kind, "status" in child && child.status])).toEqual([
      ["ses_a", "subagent", "completed"],
      ["ses_b", "subagent", "running"],
      ["ses_nested", "subagent", "completed"],
      ["ses_idle", "subagent", "starting"],
    ])
    expect(usage.children.map((child) => [child.sessionID, child.steps, "turns" in child && child.turns])).toEqual([
      ["ses_a", 2, 1],
      ["ses_b", 0, 0],
      ["ses_nested", 0, 0],
      ["ses_idle", 0, 0],
    ])
    expect(usage.children[3]).toMatchObject({ requests: { logical: 0, physical: 0, helpers: 0 }, tokens: { input: 0 } })
    expect(usage.children[1]?.tokens).toEqual(tokens(1))
    expect(usage.children[2]?.tokens).toEqual(tokens(1))
  })

  test("reports helper steps only when the helper's steps were observed", async () => {
    const sdk = YCoding.make({ baseUrl: "https://ycoding.test" })
    spyOn(sdk.session, "usageReport").mockImplementation((() =>
      Promise.resolve({
        group: "session",
        rows: [row("ses_root"), row("ses_seen"), row("ses_unseen")],
        total: metrics,
        rowCount: 3,
      })) as never)
    spyOn(sdk.session.subagent, "list").mockImplementation((() =>
      Promise.resolve({ data: [], summary: {}, cursor: {} })) as never)
    const get = spyOn(sdk.session, "get").mockImplementation((() => Promise.resolve({ agent: "compaction" })) as never)
    const activity = createRunActivity()
    activity.observe(event("session.step.ended", "ses_seen"))
    activity.observe(event("session.execution.started", "ses_unseen"))
    activity.observe(event("session.execution.succeeded", "ses_unseen"))
    const usage = await readRunUsage(sdk, "ses_root", { from: 100, to: 200 }, activity)
    expect(usage.total).toMatchObject({ steps: 0, turns: 0 })
    expect(get.mock.calls.map(([input]) => input.sessionID)).toEqual(["ses_seen", "ses_unseen"])
    expect(usage.children.map((child) => [child.sessionID, child.kind, child.steps])).toEqual([
      ["ses_seen", "helper", 1],
      ["ses_unseen", "helper", undefined],
    ])
    for (const child of usage.children) {
      expect(child).toMatchObject({ agent: "compaction" })
      expect(child).not.toHaveProperty("turns")
      expect(child).not.toHaveProperty("cost")
      expect(child).not.toHaveProperty("costProvenance")
    }
    expect(usage.children[1]).not.toHaveProperty("steps")
  })

  test("widens an empty window so the report accepts it", async () => {
    const sdk = YCoding.make({ baseUrl: "https://ycoding.test" })
    const reports = spyOn(sdk.session, "usageReport").mockImplementation((() =>
      Promise.resolve({ group: "session", rows: [], total: metrics, rowCount: 0 })) as never)
    spyOn(sdk.session.subagent, "list").mockImplementation((() =>
      Promise.resolve({ data: [], summary: {}, cursor: {} })) as never)
    await readRunUsage(sdk, "ses_root", { from: 100, to: 100 }, createRunActivity())
    expect(reports.mock.calls[0]![0]).toMatchObject({ from: 100, to: 101 })
  })
})
