import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { YCoding } from "@ycoding-ai/client/promise"
import { createRunMetrics, readRunUsage } from "../../src/run/metrics"

const tokens = (input: number, read = 0, write = 0) => ({
  input,
  output: 1,
  reasoning: 0,
  cache: { read, write },
})
const metrics = { logical: 1, physical: 1, helpers: 0, tokens: tokens(1) }
const row = (key: string) => ({ key, label: key, ...metrics })

afterEach(() => {
  mock.restore()
})

describe("createRunMetrics", () => {
  test("sums settled steps, tracks the largest input and the last reported limit, and dedupes models", () => {
    const run = createRunMetrics()
    run.started({ providerID: "p", id: "m", variant: "high" })
    run.settled({ tokens: tokens(100, 50, 5), cost: 0.5, contextLimit: 1000 })
    run.started({ providerID: "p", id: "m", variant: "high" })
    run.started({ providerID: "p", id: "m" })
    run.settled({ tokens: tokens(20, 300), cost: 0.25 })
    run.settled({})

    expect(run.summary()).toEqual({
      steps: 3,
      tokens: { input: 120, output: 2, reasoning: 0, cache: { read: 350, write: 5 } },
      cost: 0.75,
      context: { limit: 1000, peakInput: 320 },
      models: [{ providerID: "p", id: "m", variant: "high" }, { providerID: "p", id: "m" }],
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

describe("readRunUsage", () => {
  test("pages every report row and every subagent page inside the window", async () => {
    const sdk = YCoding.make({ baseUrl: "https://ycoding.test" })
    const reports = spyOn(sdk.session, "usageReport").mockImplementation(((input: { offset?: number }) =>
      Promise.resolve(
        input.offset === undefined
          ? { group: "session", rows: [row("ses_root"), row("ses_a")], total: metrics, rowCount: 3, nextOffset: 2 }
          : { group: "session", rows: [row("ses_b")], total: metrics, rowCount: 3 },
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
            : [],
        summary: { total: 0, active: 0, running: 0, waiting: 0 },
        cursor: input.parentID === "ses_root" && input.cursor === undefined ? { next: "next-page" } : {},
      })) as never)
    spyOn(sdk.session, "get").mockImplementation((() => Promise.reject(new Error("unexpected helper read"))) as never)

    const usage = await readRunUsage(sdk, "ses_root", { from: 100, to: 200 })

    expect(reports.mock.calls.map(([input]) => input)).toEqual([
      { sessionID: "ses_root", group: "session", from: 100, to: 200, limit: 200, offset: undefined },
      { sessionID: "ses_root", group: "session", from: 100, to: 200, limit: 200, offset: 2 },
    ])
    expect(lists.mock.calls.filter(([input]) => input.parentID === "ses_root").map(([input]) => input.cursor)).toEqual([
      undefined,
      "next-page",
    ])
    expect(usage.total.requests).toEqual({ logical: 1, physical: 1, helpers: 0 })
    expect(usage.children.map((child) => [child.sessionID, child.kind, "status" in child && child.status])).toEqual([
      ["ses_a", "subagent", "completed"],
      ["ses_b", "subagent", "running"],
    ])
  })

  test("widens an empty window so the report accepts it", async () => {
    const sdk = YCoding.make({ baseUrl: "https://ycoding.test" })
    const reports = spyOn(sdk.session, "usageReport").mockImplementation((() =>
      Promise.resolve({ group: "session", rows: [], total: metrics, rowCount: 0 })) as never)
    spyOn(sdk.session.subagent, "list").mockImplementation((() =>
      Promise.resolve({ data: [], summary: {}, cursor: {} })) as never)

    await readRunUsage(sdk, "ses_root", { from: 100, to: 100 })

    expect(reports.mock.calls[0]![0]).toMatchObject({ from: 100, to: 101 })
  })
})
