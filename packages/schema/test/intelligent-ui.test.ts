import { describe, expect, test } from "bun:test"
import { Schema, SchemaAST } from "effect"
import { IntelligentUi } from "../src/index.js"

const validSpec = {
  version: 1 as const,
  title: "Desktop release readiness",
  summary: "Core build and renderer checks for the current candidate.",
  fallback: "Desktop release readiness: 142/142 checks passing.",
  blocks: [
    {
      id: "kpis",
      kind: "metrics" as const,
      items: [
        { label: "Tests passing", value: "142 / 142", detail: "All selected checks", tone: "positive" as const },
        { label: "Bundle size", value: "418 KiB", tone: "default" as const },
        { label: "Warnings", value: "2", tone: "warning" as const },
      ],
    },
    {
      id: "note",
      kind: "callout" as const,
      tone: "default" as const,
      title: "Fallback preserved",
      body: "Plain fallback stays readable in text transcripts.",
    },
    {
      id: "checks",
      kind: "table" as const,
      title: "Verification summary",
      columns: [
        { key: "check", label: "Check", sortable: true },
        { key: "duration", label: "Duration", align: "right" as const, sortable: true },
      ],
      rows: [
        { id: "r1", cells: { check: "Schema", duration: "133ms" } },
        { id: "r2", cells: { check: "Tokens", duration: "20ms" } },
      ],
    },
  ],
}

describe("IntelligentUi schema and pure helpers", () => {
  test("accepts a valid spec with metrics, callout, and table blocks and reports delivery budget", () => {
    const result = IntelligentUi.validateSpec(validSpec)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.blocks).toHaveLength(3)
    expect(result.bytes).toBeLessThanOrEqual(IntelligentUi.MAX_SPEC_BYTES)
    expect(result.delivery.withinSpecLimit).toBe(true)
    expect(result.delivery.inlineForwardable).toBe(true)
    expect(result.delivery.requiresResync).toBe(false)
    expect(result.delivery.withinResyncCeiling).toBe(true)
  })

  test("models the live 16,384-byte Desktop host forwarding boundary and resync transition", () => {
    const inline = IntelligentUi.classifyForwardingDelivery(10_000)
    expect(inline).toEqual({
      bytes: 10_000,
      withinSpecLimit: true,
      inlineForwardable: true,
      requiresResync: false,
      withinResyncCeiling: true,
    })

    const nearCeiling = IntelligentUi.classifyForwardingDelivery(15_500)
    expect(nearCeiling).toEqual({
      bytes: 15_500,
      withinSpecLimit: true,
      inlineForwardable: false,
      requiresResync: true,
      withinResyncCeiling: true,
    })

    const overSpecLimit = IntelligentUi.classifyForwardingDelivery(IntelligentUi.MAX_SPEC_BYTES + 1)
    expect(overSpecLimit.withinSpecLimit).toBe(false)
    expect(overSpecLimit.inlineForwardable).toBe(false)
    expect(overSpecLimit.requiresResync).toBe(true)
    expect(overSpecLimit.withinResyncCeiling).toBe(true)

    const nearSpec = {
      version: 1 as const,
      fallback: "x".repeat(15_000),
      blocks: [{ id: "c1", kind: "callout" as const, body: "Near ceiling" }],
    }
    const validated = IntelligentUi.validateSpec(nearSpec)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    expect(validated.bytes).toBeLessThanOrEqual(IntelligentUi.MAX_SPEC_BYTES)
    expect(validated.delivery.inlineForwardable).toBe(false)
    expect(validated.delivery.requiresResync).toBe(true)
  })

  test("rejects missing fallback, duplicate block/control/variant IDs, negative pie values, and specs over 16 KiB", () => {
    const missingFallback = { ...validSpec, fallback: "" }
    const rMissing = IntelligentUi.validateSpec(missingFallback)
    expect(rMissing.ok).toBe(false)

    const duplicateBlocks = {
      ...validSpec,
      blocks: [
        { id: "dup", kind: "callout" as const, body: "First" },
        { id: "dup", kind: "callout" as const, body: "Second" },
      ],
    }
    const rDupBlock = IntelligentUi.validateSpec(duplicateBlocks)
    expect(rDupBlock.ok).toBe(false)
    if (!rDupBlock.ok) {
      expect(rDupBlock.errors.join(" ")).toContain("duplicate block")
      expect(rDupBlock.fallback).toBe(validSpec.fallback)
    }

    const negativePie = {
      version: 1 as const,
      fallback: "Pie fallback",
      blocks: [
        {
          id: "pie1",
          kind: "chart" as const,
          chartKind: "pie" as const,
          series: [
            {
              id: "s1",
              label: "Share",
              points: [
                { label: "A", value: 10 },
                { label: "B", value: -2 },
              ],
            },
          ],
        },
      ],
    }
    const rPie = IntelligentUi.validateSpec(negativePie)
    expect(rPie.ok).toBe(false)
    if (!rPie.ok) {
      expect(rPie.errors.join(" ")).toContain("pie")
      expect(rPie.fallback).toBe("Pie fallback")
    }

    const oversized = {
      ...validSpec,
      fallback: "a".repeat(IntelligentUi.MAX_SPEC_BYTES + 64),
    }
    const rOver = IntelligentUi.validateSpec(oversized)
    expect(rOver.ok).toBe(false)
    if (!rOver.ok) {
      expect(rOver.errors.join(" ")).toContain("16384")
      expect(rOver.fallback).toBe(oversized.fallback)
    }
  })

  test("enforces backlog element count ceilings and cross-field control constraints", () => {
    const tooManyBlocks = {
      version: 1 as const,
      fallback: "Fallback",
      blocks: Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, kind: "callout" as const, body: `Item ${i}` })),
    }
    expect(IntelligentUi.validateSpec(tooManyBlocks).ok).toBe(false)

    const tooManyRows = {
      version: 1 as const,
      fallback: "Fallback",
      blocks: [
        {
          id: "t1",
          kind: "table" as const,
          columns: [{ key: "name", label: "Name" }],
          rows: Array.from({ length: 33 }, (_, i) => ({ id: `r${i}`, cells: { name: `Row ${i}` } })),
        },
      ],
    }
    expect(IntelligentUi.validateSpec(tooManyRows).ok).toBe(false)

    const tooManyPoints = {
      version: 1 as const,
      fallback: "Fallback",
      blocks: [
        {
          id: "ch1",
          kind: "chart" as const,
          chartKind: "line" as const,
          series: [
            {
              id: "s1",
              label: "Latency",
              points: Array.from({ length: 25 }, (_, i) => ({ label: `P${i}`, value: i })),
            },
          ],
        },
      ],
    }
    expect(IntelligentUi.validateSpec(tooManyPoints).ok).toBe(false)

    const tooManyPointsAcrossSeries = {
      version: 1 as const,
      fallback: "Fallback",
      blocks: [
        {
          id: "ch2",
          kind: "chart" as const,
          chartKind: "line" as const,
          series: [
            { id: "s1", label: "Series 1", points: Array.from({ length: 13 }, (_, i) => ({ label: `A${i}`, value: i })) },
            { id: "s2", label: "Series 2", points: Array.from({ length: 12 }, (_, i) => ({ label: `B${i}`, value: i })) },
          ],
        },
      ],
    }
    expect(IntelligentUi.validateSpec(tooManyPointsAcrossSeries).ok).toBe(false)
    expect(Schema.is(IntelligentUi.Spec)(tooManyPointsAcrossSeries)).toBe(false)

    expect(Schema.is(IntelligentUi.Spec)({
      ...validSpec,
      blocks: [
        { id: "dup", kind: "callout" as const, body: "One" },
        { id: "dup", kind: "callout" as const, body: "Two" },
      ],
    })).toBe(false)

    const dupControls = {
      ...validSpec,
      controls: [
        { id: "c1", kind: "toggle" as const, label: "One", defaultValue: false },
        { id: "c1", kind: "toggle" as const, label: "Two", defaultValue: true },
      ],
    }
    expect(IntelligentUi.validateSpec(dupControls).ok).toBe(false)

    const badRange = {
      ...validSpec,
      controls: [{ id: "r1", kind: "range" as const, label: "Budget", min: 10, max: 5, defaultValue: 7 }],
    }
    expect(IntelligentUi.validateSpec(badRange).ok).toBe(false)

    const dupVariants = {
      ...validSpec,
      variants: [
        { id: "v1", label: "Compact", summary: "Compact summary" },
        { id: "v1", label: "Detailed", summary: "Detailed summary" },
      ],
    }
    expect(IntelligentUi.validateSpec(dupVariants).ok).toBe(false)
  })

  test("preserves primary blocks when a variant defines only a summary or metric override", () => {
    const withVariants = {
      ...validSpec,
      variants: [
        { id: "summary-only", label: "Summary view", summary: "Condensed release outlook." },
        {
          id: "strict-kpi",
          label: "Strict KPIs",
          overrides: [
            {
              id: "kpis",
              kind: "metrics" as const,
              items: [{ label: "Blocking issues", value: "0", tone: "positive" as const }],
            },
          ],
        },
      ],
    }
    const parsed = IntelligentUi.validateSpec(withVariants)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const summaryView = IntelligentUi.resolveVariant(parsed.spec, "summary-only")
    expect(summaryView.summary).toBe("Condensed release outlook.")
    expect(summaryView.blocks.map((b) => b.id)).toEqual(["kpis", "note", "checks"])

    const overrideView = IntelligentUi.resolveVariant(parsed.spec, "strict-kpi")
    expect(overrideView.blocks.map((b) => b.id)).toEqual(["kpis", "note", "checks"])
    expect(overrideView.blocks[0]?.kind).toBe("metrics")
    if (overrideView.blocks[0]?.kind === "metrics") {
      expect(overrideView.blocks[0].items[0]?.label).toBe("Blocking issues")
    }
  })

  test("escapes ASCII control and Unicode bidirectional characters deterministically", () => {
    const raw = "ok\u0000\u0007\r\u001b[31m\u202eRTL\u2066ISO\u200f\u061c\nline2\tcol2"
    const escaped = IntelligentUi.escapeDisplayText(raw)
    expect(escaped).toContain("\\u0000")
    expect(escaped).toContain("\\u0007")
    expect(escaped).toContain("\\u000d")
    expect(escaped).toContain("\\u001b")
    expect(escaped).toContain("\\u202e")
    expect(escaped).toContain("\\u2066")
    expect(escaped).toContain("\\u200f")
    expect(escaped).toContain("\\u061c")
    expect(escaped).toContain("\nline2\tcol2")
    expect(escaped).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/)
  })

  test("formats deterministic composer drafts from changed controls, variant, and note", () => {
    const specWithControls = {
      ...validSpec,
      defaultVariant: "base",
      variants: [
        { id: "base", label: "Baseline" },
        { id: "strict", label: "Strict", summary: "Strict mode" },
      ],
      controls: [
        { id: "strict-lint", kind: "toggle" as const, label: "Strict lint", defaultValue: false },
        {
          id: "target",
          kind: "select" as const,
          label: "Target",
          options: [
            { value: "local", label: "Local" },
            { value: "staging", label: "Staging" },
          ],
          defaultValue: "local",
        },
        { id: "budget", kind: "range" as const, label: "Max KiB", min: 100, max: 500, step: 50, unit: "KiB", defaultValue: 400 },
      ],
    }
    const validated = IntelligentUi.validateSpec(specWithControls)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return

    const draft = IntelligentUi.formatComposerDraft(validated.spec, {
      variantId: "strict",
      values: { "strict-lint": true, target: "staging", budget: 350 },
      note: "Keep rollback plan\u202e safe",
    })
    expect(draft).toContain("Desktop release readiness")
    expect(draft).toContain("Variant: Strict")
    expect(draft).toContain("Strict lint: on")
    expect(draft).toContain("Target: Staging")
    expect(draft).toContain("Max KiB: 350 KiB")
    expect(draft).toContain("Note: Keep rollback plan\\u202e safe")
  })

  test("computes deterministic height reservation from full specs and streaming partial strings", () => {
    const validated = IntelligentUi.validateSpec(validSpec)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return

    const fullHeight = IntelligentUi.estimateReservedHeight(validated.spec)
    expect(fullHeight).toBeGreaterThanOrEqual(160)
    expect(fullHeight).toBe(IntelligentUi.estimateReservedHeight(validated.spec))

    const explicit = IntelligentUi.estimateReservedHeight({ ...validated.spec, reservedHeight: 340 })
    expect(explicit).toBe(340)

    const partialJson = '{"version":1,"reservedHeight":340,"title":"Streaming'
    expect(IntelligentUi.estimateReservedHeight(partialJson)).toBe(340)
    expect(IntelligentUi.estimateReservedHeight('{"version":1,"title":"incomplete')).toBeGreaterThanOrEqual(160)
  })

  test("extracts UI cards from direct ui tool parts and CodeMode execute nested calls", () => {
    const directReady = IntelligentUi.extractUiCardEntries({
      id: "part_1",
      type: "tool",
      name: "ui",
      state: {
        status: "completed",
        input: validSpec,
        structured: { ui: validSpec },
        content: [{ type: "text", text: validSpec.fallback }],
      },
    })
    expect(directReady).toHaveLength(1)
    expect(directReady[0]?.status).toBe("ready")

    const executeNested = IntelligentUi.extractUiCardEntries({
      id: "part_exec",
      type: "tool",
      name: "execute",
      state: {
        status: "completed",
        input: { code: "return tools.ui(spec)" },
        structured: {
          toolCalls: [
            {
              id: "nested_ui_1",
              index: 0,
              name: "ui",
              tool: "ui",
              status: "completed",
              input: validSpec,
              structured: { ui: validSpec },
            },
          ],
        },
        content: [{ type: "text", text: validSpec.fallback }],
      },
    })
    expect(executeNested).toHaveLength(1)
    expect(executeNested[0]?.status).toBe("ready")

    const invalidDirect = IntelligentUi.extractUiCardEntries({
      id: "part_bad",
      type: "tool",
      name: "ui",
      state: {
        status: "completed",
        input: { ...validSpec, blocks: [] },
        structured: { ui: { ...validSpec, blocks: [] } },
        content: [{ type: "text", text: "Plain fallback text" }],
      },
    })
    expect(invalidDirect).toHaveLength(1)
    expect(invalidDirect[0]?.status).toBe("fallback")
    if (invalidDirect[0]?.status === "fallback") {
      expect(invalidDirect[0].fallback).toBe(validSpec.fallback)
    }

    const streamingDirect = IntelligentUi.extractUiCardEntries({
      id: "part_stream",
      type: "tool",
      name: "ui",
      state: {
        status: "streaming",
        input: '{"version":1,"reservedHeight":320,"title":"Loading',
      },
    })
    expect(streamingDirect).toHaveLength(1)
    expect(streamingDirect[0]?.status).toBe("streaming")
    if (streamingDirect[0]?.status === "streaming") {
      expect(streamingDirect[0].reservedHeight).toBe(320)
    }
  })

  test("preserves Schema hygiene: optional omits undefined, unique identifiers, no Any or mutable wrappers", () => {
    const decoded = Schema.decodeUnknownSync(IntelligentUi.Spec)(validSpec)
    const encoded = Schema.encodeSync(IntelligentUi.Spec)(decoded)
    expect(encoded).not.toHaveProperty("reservedHeight")
    expect(encoded).not.toHaveProperty("controls")
    expect(encoded).not.toHaveProperty("variants")
    expect(encoded).not.toHaveProperty("defaultVariant")

    const schemas = [
      IntelligentUi.Tone,
      IntelligentUi.Align,
      IntelligentUi.MetricItem,
      IntelligentUi.MetricsBlock,
      IntelligentUi.CalloutBlock,
      IntelligentUi.TableColumn,
      IntelligentUi.TableRow,
      IntelligentUi.TableBlock,
      IntelligentUi.ChartKind,
      IntelligentUi.ChartPoint,
      IntelligentUi.ChartSeries,
      IntelligentUi.ChartBlock,
      IntelligentUi.Block,
      IntelligentUi.ToggleControl,
      IntelligentUi.SelectOption,
      IntelligentUi.SelectControl,
      IntelligentUi.RangeControl,
      IntelligentUi.Control,
      IntelligentUi.Variant,
      IntelligentUi.Spec,
    ]
    const ids = schemas.map((s) => s.ast.annotations?.identifier)
    expect(ids.every((id) => typeof id === "string" && id.startsWith("IntelligentUi."))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)

    for (const s of schemas) {
      expect(SchemaAST.isAny(s.ast)).toBe(false)
    }
  })
})
