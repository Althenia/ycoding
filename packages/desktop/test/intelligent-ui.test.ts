import { describe, expect, mock, test } from "bun:test"
import path from "node:path"
import { IntelligentUi } from "../../schema/src/intelligent-ui"

const jsxRuntime = () => ({
  jsxDEV: (type: unknown, props: unknown) => ({ type, props }),
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
  Fragment: (props: { children?: unknown }) => props.children,
})
void mock.module("solid-js/jsx-dev-runtime", jsxRuntime)
void mock.module("solid-js/jsx-runtime", jsxRuntime)

const { nextTableSort, sortTableRows, assistantUiCards } = await import("../src/intelligent-ui")

const root = path.join(import.meta.dir, "..")
const read = (file: string) => Bun.file(path.join(root, file)).text()

describe("Desktop Intelligent UI projection, table sorting, and design contract", () => {
  test("extracts ready, streaming, and invalid-fallback cards from assistant tool parts", () => {
    const valid = {
      version: 1 as const,
      title: "Release readiness",
      fallback: "Release readiness: passing",
      blocks: [
        {
          id: "m1",
          kind: "metrics" as const,
          items: [{ label: "Passing", value: "142", tone: "positive" as const }],
        },
      ],
    }

    const cards = assistantUiCards([
      {
        id: "part_stream",
        type: "tool",
        name: "ui",
        state: { status: "streaming", input: '{"version":1,"reservedHeight":280' },
        time: { created: 1 },
      },
      {
        id: "part_valid",
        type: "tool",
        name: "ui",
        state: {
          status: "completed",
          input: valid,
          structured: { ui: valid },
          content: [{ type: "text", text: valid.fallback }],
        },
        time: { created: 2, completed: 3 },
      },
      {
        id: "part_invalid",
        type: "tool",
        name: "ui",
        state: {
          status: "completed",
          input: { version: 1, fallback: "Safe fallback\u202e text", blocks: [] },
          structured: { ui: { version: 1, fallback: "Safe fallback\u202e text", blocks: [] } },
          content: [{ type: "text", text: "Safe fallback\u202e text" }],
        },
        time: { created: 4, completed: 5 },
      },
    ])

    expect(cards).toHaveLength(3)
    expect(cards[0]?.status).toBe("streaming")
    if (cards[0]?.status === "streaming") expect(cards[0].reservedHeight).toBe(280)
    expect(cards[1]?.status).toBe("ready")
    expect(cards[2]?.status).toBe("fallback")
    if (cards[2]?.status === "fallback") {
      expect(IntelligentUi.escapeDisplayText(cards[2].fallback)).toBe("Safe fallback\\u202e text")
    }
  })

  test("cycles sort state and sorts table rows deterministically across strings and numbers", () => {
    expect(nextTableSort(undefined, "duration")).toEqual({ key: "duration", direction: "asc" })
    expect(nextTableSort({ key: "duration", direction: "asc" }, "duration")).toEqual({ key: "duration", direction: "desc" })
    expect(nextTableSort({ key: "duration", direction: "desc" }, "duration")).toBeUndefined()
    expect(nextTableSort({ key: "duration", direction: "asc" }, "check")).toEqual({ key: "check", direction: "asc" })

    const rows = [
      { id: "r1", cells: { check: "Typecheck", ms: 748 } },
      { id: "r2", cells: { check: "Tokens", ms: 20 } },
      { id: "r3", cells: { check: "Schema", ms: 133 } },
    ]
    expect(sortTableRows(rows, { key: "ms", direction: "asc" }).map((r) => r.id)).toEqual(["r2", "r3", "r1"])
    expect(sortTableRows(rows, { key: "ms", direction: "desc" }).map((r) => r.id)).toEqual(["r1", "r3", "r2"])
    expect(sortTableRows(rows, { key: "check", direction: "asc" }).map((r) => r.id)).toEqual(["r3", "r2", "r1"])
    expect(sortTableRows(rows, undefined).map((r) => r.id)).toEqual(["r1", "r2", "r3"])
  })

  test("Intelligent UI stylesheet uses only YCoding tokens with zero raw colors and no sub-1000px media queries", async () => {
    const css = await read("src/intelligent-ui.css")
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d/gi)
    const mediaWidths = [...css.matchAll(/(max|min)-width:\s*(\d+)px\)/g)]
      .filter((m) => !css.slice(Math.max(0, m.index - 40), m.index).includes("@container"))
      .map((m) => Number(m[2]))
    expect(mediaWidths.filter((w) => w < 1000)).toEqual([])
    expect(css).toContain("prefers-reduced-motion")
  })

  test("Intelligent UI component source never uses innerHTML, iframes, or turn submission APIs", async () => {
    const source = await read("src/intelligent-ui.tsx")
    expect(source).not.toContain("innerHTML")
    expect(source).not.toContain("<iframe")
    expect(source).not.toContain("<form")
    expect(source).not.toContain("api.send")
    expect(source).not.toContain("api.reply")
    expect(source).not.toContain("api.setAutonomy")
    expect(source).toContain("escapeDisplayText")
  })

  test("forwardDesktopEvent routes near-ceiling valid specs to resync when serialized event exceeds 16,384 bytes", async () => {
    const { forwardDesktopEvent } = await import("../src/rpc")
    const nearCeilingSpec = {
      version: 1 as const,
      fallback: "x".repeat(15_200),
      blocks: [{ id: "c1", kind: "callout" as const, body: "Near 16 KiB host boundary" }],
    }
    const validated = IntelligentUi.validateSpec(nearCeilingSpec)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    expect(validated.delivery.inlineForwardable).toBe(false)
    expect(validated.delivery.requiresResync).toBe(true)

    const forwarded: unknown[] = []
    let resyncCount = 0
    const send = { event: (value: unknown) => forwarded.push(value), resync: () => { resyncCount += 1 } }

    const basePayload = { id: "evt_exact", payload: "" }
    const baseBytes = IntelligentUi.serializedByteLength(basePayload)!
    const exact16384 = { id: "evt_exact", payload: "a".repeat(IntelligentUi.DESKTOP_EVENT_FORWARD_LIMIT_BYTES - baseBytes) }
    const over16385 = { id: "evt_exact", payload: "a".repeat(IntelligentUi.DESKTOP_EVENT_FORWARD_LIMIT_BYTES - baseBytes + 1) }

    expect(IntelligentUi.classifySerializedEventDelivery(exact16384)).toEqual({
      bytes: 16_384,
      inlineForwardable: true,
      requiresResync: false,
    })
    expect(IntelligentUi.classifySerializedEventDelivery(over16385)).toEqual({
      bytes: 16_385,
      inlineForwardable: false,
      requiresResync: true,
    })

    forwardDesktopEvent(exact16384, send)
    expect(forwarded).toHaveLength(1)
    expect(resyncCount).toBe(0)

    forwardDesktopEvent(over16385, send)
    expect(forwarded).toHaveLength(1)
    expect(resyncCount).toBe(1)

    forwardDesktopEvent(
      {
        id: "evt_near_ceiling",
        type: "message.part.updated",
        sessionID: "ses_test",
        payload: { spec: validated.spec, metadata: "m".repeat(1500) },
      },
      send,
    )
    expect(forwarded).toHaveLength(1)
    expect(resyncCount).toBe(2)
  })
})
