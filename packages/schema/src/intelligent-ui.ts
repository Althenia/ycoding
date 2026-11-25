export * as IntelligentUi from "./intelligent-ui.js"

import { Schema } from "effect"
import { PositiveInt, optional } from "./schema.js"
import { ToolInvocation } from "./tool-invocation.js"

export const MAX_SPEC_BYTES = 16_384
export const DESKTOP_EVENT_FORWARD_LIMIT_BYTES = 16_384
export const DESKTOP_EVENT_ENVELOPE_OVERHEAD_BYTES = 2_048
export const INLINE_EVENT_SPEC_BUDGET_BYTES =
  DESKTOP_EVENT_FORWARD_LIMIT_BYTES - DESKTOP_EVENT_ENVELOPE_OVERHEAD_BYTES
export const DESKTOP_RESYNC_CEILING_BYTES = 1_048_576

export const MAX_BLOCKS = 8
export const MAX_METRIC_ITEMS = 8
export const MAX_CHART_POINTS = 24
export const MAX_CHART_SERIES = 8
export const MAX_TABLE_COLUMNS = 12
export const MAX_TABLE_ROWS = 32
export const MAX_CONTROLS = 12
export const MAX_SELECT_OPTIONS = 24
export const MAX_VARIANTS = 6

export const MIN_RESERVED_HEIGHT_PX = 120
export const MAX_RESERVED_HEIGHT_PX = 720
export const DEFAULT_STREAMING_HEIGHT_PX = 220

export const Tone = Schema.Literals(["default", "positive", "warning", "danger"]).annotate({
  identifier: "IntelligentUi.Tone",
})
export type Tone = typeof Tone.Type

export const Align = Schema.Literals(["left", "center", "right"]).annotate({
  identifier: "IntelligentUi.Align",
})
export type Align = typeof Align.Type

export interface MetricItem extends Schema.Schema.Type<typeof MetricItem> {}
export const MetricItem = Schema.Struct({
  label: Schema.NonEmptyString,
  value: Schema.NonEmptyString,
  detail: Schema.String.pipe(optional),
  tone: Tone.pipe(optional),
}).annotate({ identifier: "IntelligentUi.MetricItem" })

export interface MetricsBlock extends Schema.Schema.Type<typeof MetricsBlock> {}
export const MetricsBlock = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.tag("metrics"),
  title: Schema.String.pipe(optional),
  items: Schema.Array(MetricItem).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_METRIC_ITEMS)),
}).annotate({ identifier: "IntelligentUi.MetricsBlock" })

export interface CalloutBlock extends Schema.Schema.Type<typeof CalloutBlock> {}
export const CalloutBlock = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.tag("callout"),
  tone: Tone.pipe(optional),
  title: Schema.String.pipe(optional),
  body: Schema.NonEmptyString,
}).annotate({ identifier: "IntelligentUi.CalloutBlock" })

export interface TableColumn extends Schema.Schema.Type<typeof TableColumn> {}
export const TableColumn = Schema.Struct({
  key: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  align: Align.pipe(optional),
  sortable: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "IntelligentUi.TableColumn" })

export const TableCellValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])
export type TableCellValue = typeof TableCellValue.Type

export interface TableRow extends Schema.Schema.Type<typeof TableRow> {}
export const TableRow = Schema.Struct({
  id: Schema.NonEmptyString,
  cells: Schema.Record(Schema.String, TableCellValue),
}).annotate({ identifier: "IntelligentUi.TableRow" })

export interface TableBlock extends Schema.Schema.Type<typeof TableBlock> {}
export const TableBlock = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.tag("table"),
  title: Schema.String.pipe(optional),
  columns: Schema.Array(TableColumn).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TABLE_COLUMNS)),
  rows: Schema.Array(TableRow).check(Schema.isMaxLength(MAX_TABLE_ROWS)),
}).annotate({ identifier: "IntelligentUi.TableBlock" })

export const ChartKind = Schema.Literals(["bar", "line", "area", "pie", "sparkline"]).annotate({
  identifier: "IntelligentUi.ChartKind",
})
export type ChartKind = typeof ChartKind.Type

export interface ChartPoint extends Schema.Schema.Type<typeof ChartPoint> {}
export const ChartPoint = Schema.Struct({
  label: Schema.NonEmptyString,
  value: Schema.Finite,
}).annotate({ identifier: "IntelligentUi.ChartPoint" })

export interface ChartSeries extends Schema.Schema.Type<typeof ChartSeries> {}
export const ChartSeries = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  points: Schema.Array(ChartPoint).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CHART_POINTS)),
}).annotate({ identifier: "IntelligentUi.ChartSeries" })

export interface ChartBlock extends Schema.Schema.Type<typeof ChartBlock> {}
export const ChartBlock = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.tag("chart"),
  chartKind: ChartKind,
  title: Schema.String.pipe(optional),
  series: Schema.Array(ChartSeries).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CHART_SERIES)),
}).annotate({ identifier: "IntelligentUi.ChartBlock" })

export const Block = Schema.Union([MetricsBlock, CalloutBlock, TableBlock, ChartBlock])
  .pipe(Schema.toTaggedUnion("kind"))
  .annotate({ identifier: "IntelligentUi.Block" })
export type Block = MetricsBlock | CalloutBlock | TableBlock | ChartBlock

export interface ToggleControl extends Schema.Schema.Type<typeof ToggleControl> {}
export const ToggleControl = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.tag("toggle"),
  label: Schema.NonEmptyString,
  defaultValue: Schema.Boolean,
}).annotate({ identifier: "IntelligentUi.ToggleControl" })

export interface SelectOption extends Schema.Schema.Type<typeof SelectOption> {}
export const SelectOption = Schema.Struct({
  value: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
}).annotate({ identifier: "IntelligentUi.SelectOption" })

export interface SelectControl extends Schema.Schema.Type<typeof SelectControl> {}
export const SelectControl = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.tag("select"),
  label: Schema.NonEmptyString,
  options: Schema.Array(SelectOption).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SELECT_OPTIONS)),
  defaultValue: Schema.NonEmptyString,
}).annotate({ identifier: "IntelligentUi.SelectControl" })

export interface RangeControl extends Schema.Schema.Type<typeof RangeControl> {}
export const RangeControl = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.tag("range"),
  label: Schema.NonEmptyString,
  min: Schema.Finite,
  max: Schema.Finite,
  step: Schema.Finite.pipe(optional),
  unit: Schema.String.pipe(optional),
  defaultValue: Schema.Finite,
}).annotate({ identifier: "IntelligentUi.RangeControl" })

export const Control = Schema.Union([ToggleControl, SelectControl, RangeControl])
  .pipe(Schema.toTaggedUnion("kind"))
  .annotate({ identifier: "IntelligentUi.Control" })
export type Control = ToggleControl | SelectControl | RangeControl

export interface Variant extends Schema.Schema.Type<typeof Variant> {}
export const Variant = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  summary: Schema.String.pipe(optional),
  overrides: Schema.Array(Block).check(Schema.isMaxLength(MAX_BLOCKS)).pipe(optional),
  blocks: Schema.Array(Block).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BLOCKS)).pipe(optional),
}).annotate({ identifier: "IntelligentUi.Variant" })

const SpecStruct = Schema.Struct({
  version: Schema.Literal(1),
  title: Schema.String.pipe(optional),
  summary: Schema.String.pipe(optional),
  fallback: Schema.NonEmptyString,
  reservedHeight: PositiveInt.pipe(optional),
  blocks: Schema.Array(Block).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BLOCKS)),
  controls: Schema.Array(Control).check(Schema.isMaxLength(MAX_CONTROLS)).pipe(optional),
  variants: Schema.Array(Variant).check(Schema.isMaxLength(MAX_VARIANTS)).pipe(optional),
  defaultVariant: Schema.NonEmptyString.pipe(optional),
})

export interface Spec extends Schema.Schema.Type<typeof SpecStruct> {}
export const Spec = SpecStruct.annotate({ identifier: "IntelligentUi.Spec" }).check(
  Schema.makeFilter((spec) => {
    const bytes = serializedByteLength(spec)
    if (bytes === undefined) return "spec must be JSON-serializable"
    if (bytes > MAX_SPEC_BYTES) return `spec exceeds maximum size of ${MAX_SPEC_BYTES} bytes (${bytes} bytes)`
    const errors = validateCrossFields(spec)
    return errors.length > 0 ? errors.join("; ") : undefined
  }),
)

export interface ForwardingDelivery {
  readonly bytes: number
  readonly withinSpecLimit: boolean
  readonly inlineForwardable: boolean
  readonly requiresResync: boolean
  readonly withinResyncCeiling: boolean
}

export type ValidationResult =
  | {
      readonly ok: true
      readonly spec: Spec
      readonly bytes: number
      readonly delivery: ForwardingDelivery
    }
  | {
      readonly ok: false
      readonly errors: readonly string[]
      readonly fallback?: string
    }

export type ControlValue = boolean | string | number

export interface DraftState {
  readonly variantId?: string
  readonly values?: Readonly<Record<string, ControlValue>>
  readonly note?: string
}

export interface ResolvedVariantView {
  readonly variantId?: string
  readonly summary?: string
  readonly blocks: readonly Block[]
}

export type UiCardEntry =
  | {
      readonly status: "streaming"
      readonly id: string
      readonly reservedHeight: number
      readonly fallback?: string
    }
  | {
      readonly status: "ready"
      readonly id: string
      readonly spec: Spec
      readonly reservedHeight: number
      readonly bytes: number
      readonly delivery: ForwardingDelivery
    }
  | {
      readonly status: "fallback"
      readonly id: string
      readonly fallback: string
      readonly reason: "invalid" | "error"
      readonly errors: readonly string[]
    }

const encoder = new TextEncoder()
const UNSAFE_DISPLAY_CHAR = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length
}

export function serializedByteLength(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? undefined : utf8ByteLength(serialized)
  } catch {
    return undefined
  }
}

export function classifyForwardingDelivery(
  specBytes: number,
  envelopeOverheadBytes = DESKTOP_EVENT_ENVELOPE_OVERHEAD_BYTES,
): ForwardingDelivery {
  const bytes = Math.max(0, Math.trunc(specBytes))
  const withinSpecLimit = bytes <= MAX_SPEC_BYTES
  const inlineForwardable = withinSpecLimit && bytes + envelopeOverheadBytes <= DESKTOP_EVENT_FORWARD_LIMIT_BYTES
  return {
    bytes,
    withinSpecLimit,
    inlineForwardable,
    requiresResync: !inlineForwardable,
    withinResyncCeiling: bytes <= DESKTOP_RESYNC_CEILING_BYTES,
  }
}

export function classifySerializedEventDelivery(event: unknown): {
  readonly bytes: number | undefined
  readonly inlineForwardable: boolean
  readonly requiresResync: boolean
} {
  const bytes = serializedByteLength(event)
  if (bytes === undefined) {
    return { bytes: undefined, inlineForwardable: false, requiresResync: true }
  }
  const inlineForwardable = bytes <= DESKTOP_EVENT_FORWARD_LIMIT_BYTES
  return { bytes, inlineForwardable, requiresResync: !inlineForwardable }
}

export function escapeDisplayText(value: string): string {
  return value.replace(
    UNSAFE_DISPLAY_CHAR,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

export function extractFallback(input: unknown, contentText?: string): string | undefined {
  if (isRecord(input) && typeof input.fallback === "string" && input.fallback.trim().length > 0) {
    return input.fallback
  }
  if (typeof contentText === "string" && contentText.trim().length > 0) {
    return contentText
  }
  return undefined
}

function validateBlockList(blocks: readonly Block[], scopeLabel: string, errors: string[]): void {
  const seenBlocks = new Set<string>()
  for (const block of blocks) {
    if (seenBlocks.has(block.id)) {
      errors.push(`${scopeLabel}: duplicate block identifier "${block.id}"`)
    }
    seenBlocks.add(block.id)

    if (block.kind === "table") {
      const seenColumns = new Set<string>()
      for (const column of block.columns) {
        if (seenColumns.has(column.key)) {
          errors.push(`${scopeLabel}: duplicate table column "${column.key}" in block "${block.id}"`)
        }
        seenColumns.add(column.key)
      }
      const seenRows = new Set<string>()
      for (const row of block.rows) {
        if (seenRows.has(row.id)) {
          errors.push(`${scopeLabel}: duplicate table row "${row.id}" in block "${block.id}"`)
        }
        seenRows.add(row.id)
      }
    }

    if (block.kind === "chart") {
      const seenSeries = new Set<string>()
      let totalPoints = 0
      for (const series of block.series) {
        if (seenSeries.has(series.id)) {
          errors.push(`${scopeLabel}: duplicate chart series "${series.id}" in block "${block.id}"`)
        }
        seenSeries.add(series.id)
        totalPoints += series.points.length
        if (block.chartKind === "pie") {
          for (const point of series.points) {
            if (point.value < 0) {
              errors.push(`${scopeLabel}: pie chart "${block.id}" contains negative value ${point.value} for "${point.label}"`)
            }
          }
        }
      }
      if (totalPoints > MAX_CHART_POINTS) {
        errors.push(`${scopeLabel}: chart "${block.id}" exceeds maximum ${MAX_CHART_POINTS} total points (${totalPoints})`)
      }
    }
  }
}

function validateCrossFields(spec: Spec): string[] {
  const errors: string[] = []
  validateBlockList(spec.blocks, "spec", errors)

  const baseBlocks = new Map(spec.blocks.map((block) => [block.id, block] as const))

  if (spec.controls) {
    const seenControls = new Set<string>()
    for (const control of spec.controls) {
      if (seenControls.has(control.id)) {
        errors.push(`spec: duplicate control identifier "${control.id}"`)
      }
      seenControls.add(control.id)

      if (control.kind === "select") {
        const optionValues = new Set<string>()
        for (const option of control.options) {
          if (optionValues.has(option.value)) {
            errors.push(`control "${control.id}": duplicate option value "${option.value}"`)
          }
          optionValues.add(option.value)
        }
        if (!optionValues.has(control.defaultValue)) {
          errors.push(`control "${control.id}": defaultValue "${control.defaultValue}" is not in options`)
        }
      }

      if (control.kind === "range") {
        if (control.min >= control.max) {
          errors.push(`control "${control.id}": range min (${control.min}) must be less than max (${control.max})`)
        }
        if (control.defaultValue < control.min || control.defaultValue > control.max) {
          errors.push(`control "${control.id}": defaultValue (${control.defaultValue}) is outside [${control.min}, ${control.max}]`)
        }
        if (control.step !== undefined && control.step <= 0) {
          errors.push(`control "${control.id}": range step (${control.step}) must be positive`)
        }
      }
    }
  }

  if (spec.variants) {
    const seenVariants = new Set<string>()
    for (const variant of spec.variants) {
      if (seenVariants.has(variant.id)) {
        errors.push(`spec: duplicate variant identifier "${variant.id}"`)
      }
      seenVariants.add(variant.id)

      if (variant.blocks && variant.overrides) {
        errors.push(`variant "${variant.id}": specify either blocks or overrides, not both`)
      }
      if (variant.blocks) {
        validateBlockList(variant.blocks, `variant "${variant.id}"`, errors)
      }
      if (variant.overrides) {
        validateBlockList(variant.overrides, `variant "${variant.id}" overrides`, errors)
        for (const override of variant.overrides) {
          const target = baseBlocks.get(override.id)
          if (!target) {
            errors.push(`variant "${variant.id}": override target "${override.id}" does not exist in primary blocks`)
          } else if (target.kind !== override.kind) {
            errors.push(`variant "${variant.id}": override "${override.id}" kind "${override.kind}" does not match primary block kind "${target.kind}"`)
          }
        }
      }
    }

    if (spec.defaultVariant !== undefined && !seenVariants.has(spec.defaultVariant)) {
      errors.push(`spec: defaultVariant "${spec.defaultVariant}" does not exist in variants`)
    }
  } else if (spec.defaultVariant !== undefined) {
    errors.push(`spec: defaultVariant "${spec.defaultVariant}" requires variants`)
  }

  return errors
}

export function validateSpec(input: unknown): ValidationResult {
  const fallback = extractFallback(input)
  const bytes = serializedByteLength(input)
  if (bytes === undefined) {
    return { ok: false, errors: ["spec must be JSON-serializable"], ...(fallback ? { fallback } : {}) }
  }
  if (bytes > MAX_SPEC_BYTES) {
    return {
      ok: false,
      errors: [`spec exceeds maximum size of ${MAX_SPEC_BYTES} bytes (${bytes} bytes)`],
      ...(fallback ? { fallback } : {}),
    }
  }

  let decoded: Spec
  try {
    decoded = Schema.decodeUnknownSync(SpecStruct)(input)
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      ...(fallback ? { fallback } : {}),
    }
  }

  const crossErrors = validateCrossFields(decoded)
  if (crossErrors.length > 0) {
    return { ok: false, errors: crossErrors, ...(fallback ? { fallback } : {}) }
  }

  return {
    ok: true,
    spec: decoded,
    bytes,
    delivery: classifyForwardingDelivery(bytes),
  }
}

export function resolveVariant(spec: Spec, variantId?: string): ResolvedVariantView {
  const effectiveId = variantId ?? spec.defaultVariant
  if (!effectiveId || !spec.variants) {
    return {
      ...(spec.summary === undefined ? {} : { summary: spec.summary }),
      blocks: spec.blocks,
    }
  }

  const variant = spec.variants.find((entry) => entry.id === effectiveId)
  if (!variant) {
    return {
      ...(spec.summary === undefined ? {} : { summary: spec.summary }),
      blocks: spec.blocks,
    }
  }

  const summary = variant.summary ?? spec.summary
  if (variant.blocks) {
    return {
      variantId: variant.id,
      ...(summary === undefined ? {} : { summary }),
      blocks: variant.blocks,
    }
  }

  const overrides = new Map((variant.overrides ?? []).map((block) => [block.id, block] as const))
  return {
    variantId: variant.id,
    ...(summary === undefined ? {} : { summary }),
    blocks: spec.blocks.map((block) => overrides.get(block.id) ?? block),
  }
}

export function formatComposerDraft(spec: Spec, state: DraftState): string {
  const lines: string[] = []
  const heading = spec.title ? escapeDisplayText(spec.title) : "UI adjustments"
  lines.push(`Update "${heading}":`)

  const selectedVariantId = state.variantId
  if (selectedVariantId && selectedVariantId !== spec.defaultVariant && spec.variants) {
    const variant = spec.variants.find((entry) => entry.id === selectedVariantId)
    if (variant) {
      lines.push(`- Variant: ${escapeDisplayText(variant.label)}`)
    }
  }

  if (spec.controls && state.values) {
    for (const control of spec.controls) {
      if (!Object.hasOwn(state.values, control.id)) continue
      const next = state.values[control.id]
      if (next === undefined || next === control.defaultValue) continue

      if (control.kind === "toggle" && typeof next === "boolean") {
        lines.push(`- ${escapeDisplayText(control.label)}: ${next ? "on" : "off"}`)
      } else if (control.kind === "select" && typeof next === "string") {
        const option = control.options.find((entry) => entry.value === next)
        lines.push(`- ${escapeDisplayText(control.label)}: ${escapeDisplayText(option?.label ?? next)}`)
      } else if (control.kind === "range" && typeof next === "number" && Number.isFinite(next)) {
        const unit = control.unit ? ` ${escapeDisplayText(control.unit)}` : ""
        lines.push(`- ${escapeDisplayText(control.label)}: ${next}${unit}`)
      }
    }
  }

  const trimmedNote = state.note?.trim()
  if (trimmedNote) {
    lines.push(`- Note: ${escapeDisplayText(trimmedNote)}`)
  }

  return lines.join("\n")
}

function clampReservedHeight(height: number): number {
  return Math.max(MIN_RESERVED_HEIGHT_PX, Math.min(MAX_RESERVED_HEIGHT_PX, Math.round(height)))
}

function estimateBlockHeight(block: Record<string, unknown>): number {
  const titleHeight = typeof block.title === "string" && block.title.length > 0 ? 28 : 0
  if (block.kind === "metrics") {
    const count = Array.isArray(block.items) ? block.items.length : 1
    const rows = Math.max(1, Math.ceil(count / 3))
    return titleHeight + rows * 102 + 12
  }
  if (block.kind === "callout") {
    const bodyLen = typeof block.body === "string" ? block.body.length : 40
    const lineEstimate = Math.max(1, Math.ceil(bodyLen / 76))
    return titleHeight + lineEstimate * 22 + 38
  }
  if (block.kind === "table") {
    const rowCount = Array.isArray(block.rows) ? block.rows.length : 1
    return titleHeight + 44 + Math.min(rowCount, 8) * 38 + 20
  }
  return titleHeight + 196
}

export function estimateReservedHeight(input: Spec | string | Record<string, unknown> | undefined): number {
  if (typeof input === "string") {
    const explicit = /"reservedHeight"\s*:\s*(\d{2,4})/.exec(input)
    if (explicit) return clampReservedHeight(Number(explicit[1]))
    const kinds = [...input.matchAll(/"kind"\s*:\s*"(metrics|callout|table|chart)"/g)].map((m) => m[1])
    if (kinds.length === 0) return DEFAULT_STREAMING_HEIGHT_PX
    const total = kinds.reduce(
      (sum, kind) => sum + (kind === "metrics" ? 96 : kind === "callout" ? 76 : kind === "table" ? 196 : 210),
      64,
    )
    return clampReservedHeight(total)
  }

  if (!input || !isRecord(input)) return DEFAULT_STREAMING_HEIGHT_PX

  if (typeof input.reservedHeight === "number" && Number.isFinite(input.reservedHeight)) {
    return clampReservedHeight(input.reservedHeight)
  }

  if (Array.isArray(input.blocks) && input.blocks.length > 0) {
    const header = (typeof input.title === "string" && input.title.length > 0 ? 32 : 0) +
      (typeof input.summary === "string" && input.summary.length > 0 ? 22 : 0) + 32
    const blocks = input.blocks.reduce((sum: number, block: unknown) => {
      if (isRecord(block) && (block.kind === "metrics" || block.kind === "callout" || block.kind === "table" || block.kind === "chart")) {
        return sum + estimateBlockHeight(block)
      }
      return sum + 88
    }, 0)
    return clampReservedHeight(Math.max(DEFAULT_STREAMING_HEIGHT_PX, header + blocks))
  }

  return DEFAULT_STREAMING_HEIGHT_PX
}

function contentFallbackText(part: unknown): string | undefined {
  if (!isRecord(part) || !isRecord(part.state) || !Array.isArray(part.state.content)) return undefined
  const text = part.state.content
    .flatMap((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("\n")
    .trim()
  return text.length > 0 ? text : undefined
}

function resolveCandidateSpec(input: unknown, structured: unknown): unknown {
  if (isRecord(structured)) {
    if (isRecord(structured.ui)) return structured.ui
    if (isRecord(structured.spec)) return structured.spec
  }
  if (isRecord(input)) {
    if (isRecord(input.ui)) return input.ui
    if (isRecord(input.spec)) return input.spec
    return input
  }
  return input
}

export function extractUiCardEntries(part: unknown): readonly UiCardEntry[] {
  const invocations = ToolInvocation.list(part).filter((call) => call.name === "ui")
  if (invocations.length === 0) return []
  const partText = contentFallbackText(part)

  return invocations.map((call, index): UiCardEntry => {
    const id = call.id ?? `${call.outerCallID ?? "ui"}:${index}`
    const status = call.status

    if (status === "streaming" || status === "running") {
      const candidate = resolveCandidateSpec(call.input, call.structured)
      const heightSource =
        typeof call.input === "string"
          ? call.input
          : isRecord(candidate)
            ? candidate
            : undefined
      const fallback = extractFallback(candidate, partText)
      return {
        status: "streaming",
        id,
        reservedHeight: estimateReservedHeight(heightSource),
        ...(fallback === undefined ? {} : { fallback }),
      }
    }

    if (status === "error") {
      const candidate = resolveCandidateSpec(call.input, call.structured)
      const fallback = extractFallback(candidate, partText) ?? "Interactive card failed to render."
      return {
        status: "fallback",
        id,
        fallback,
        reason: "error",
        errors: ["UI tool invocation failed"],
      }
    }

    const candidate = resolveCandidateSpec(call.input, call.structured)
    const validated = validateSpec(candidate)
    if (validated.ok) {
      return {
        status: "ready",
        id,
        spec: validated.spec,
        reservedHeight: estimateReservedHeight(validated.spec),
        bytes: validated.bytes,
        delivery: validated.delivery,
      }
    }

    const fallback = validated.fallback ?? extractFallback(candidate, partText) ?? "Interactive card spec was invalid."
    return {
      status: "fallback",
      id,
      fallback,
      reason: "invalid",
      errors: validated.errors,
    }
  })
}
