export * as AntigravityUsage from "./antigravity"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Option, Schema } from "effect"
import { Provider } from "../provider"

const weeklySeconds = 604_800
const fiveHourSeconds = 18_000
const Fraction = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))
const Bucket = Schema.Struct({
  bucketId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  window: Schema.optional(Schema.Unknown),
  remainingFraction: Schema.optional(Fraction),
  remaining: Schema.optional(Schema.Struct({ remainingFraction: Schema.optional(Fraction) })),
  disabled: Schema.optional(Schema.Boolean),
  resetTime: Schema.optional(Schema.String),
})
const Group = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  buckets: Schema.optional(Schema.Array(Schema.Unknown)),
})
const Summary = Schema.Struct({
  buckets: Schema.optional(Schema.Array(Schema.Unknown)),
  groups: Schema.optional(Schema.Array(Schema.Unknown)),
})
const Envelope = Schema.Struct({ ...Summary.fields, response: Schema.optional(Schema.Unknown) })
const decodeEnvelope = Schema.decodeUnknownOption(Envelope)
const decodeSummary = Schema.decodeUnknownOption(Summary)
const decodeGroup = Schema.decodeUnknownOption(Group)
const decodeBucket = Schema.decodeUnknownOption(Bucket)
const providerID = Provider.ID.make("antigravity")

type Entry = { readonly group: string | undefined; readonly bucket: typeof Bucket.Type }

function reportedSeconds(value: unknown) {
  if (typeof value === "number") return value
  if (typeof value !== "string") return undefined
  const match = /^(\d+)s?$/.exec(value.trim())
  return match ? Number(match[1]) : undefined
}

function namedPeriod(value: string | undefined) {
  if (!value) return undefined
  const words = ` ${value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `
  const weekly = / (weekly|week) /.test(words)
  const fiveHour = / (five|5) ?(h|hr|hrs|hour|hours) /.test(words)
  if (weekly === fiveHour) return undefined
  return weekly ? weeklySeconds : fiveHourSeconds
}

function bucketPeriod(bucket: typeof Bucket.Type) {
  const seconds = reportedSeconds(bucket.window)
  const periods = new Set(
    [
      seconds === weeklySeconds || seconds === fiveHourSeconds ? seconds : undefined,
      namedPeriod(typeof bucket.window === "string" ? bucket.window : undefined),
      namedPeriod(bucket.bucketId),
      namedPeriod(bucket.displayName),
    ].filter((period) => period !== undefined),
  )
  return periods.size === 1 ? [...periods][0] : undefined
}

function nonEmpty(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function summaryOf(payload: unknown) {
  const envelope = Option.getOrUndefined(decodeEnvelope(payload))
  if (!envelope) return undefined
  const summary = envelope.response === undefined ? envelope : Option.getOrUndefined(decodeSummary(envelope.response))
  return summary && (summary.buckets !== undefined || summary.groups !== undefined) ? summary : undefined
}

const fractionOf = (bucket: typeof Bucket.Type) => bucket.remainingFraction ?? bucket.remaining?.remainingFraction

function entries(payload: typeof Summary.Type): readonly Entry[] {
  const grouped = (payload.groups ?? []).flatMap((value) => {
    const group = Option.getOrUndefined(decodeGroup(value))
    return (group?.buckets ?? []).flatMap((item) => {
      const bucket = Option.getOrUndefined(decodeBucket(item))
      return bucket ? [{ group: nonEmpty(group?.displayName), bucket }] : []
    })
  })
  const ungrouped = (payload.buckets ?? []).flatMap((item) => {
    const bucket = Option.getOrUndefined(decodeBucket(item))
    return bucket ? [{ group: undefined, bucket }] : []
  })
  return [...ungrouped, ...grouped]
}

const kindRank = (period: number | undefined) =>
  period === weeklySeconds ? 0 : period === fiveHourSeconds ? 1 : 2

export function normalize(payload: unknown, updatedAt: number) {
  const decoded = summaryOf(payload)
  if (!decoded) return undefined
  const reported = entries(decoded)
    .filter(({ bucket }) => bucket.disabled !== true && fractionOf(bucket) !== undefined)
    .map((entry) => ({ ...entry, period: bucketPeriod(entry.bucket) }))
  const groups = [...new Set(reported.map((entry) => entry.group))]
  const usable = reported.toSorted(
    (left, right) =>
      groups.indexOf(left.group) - groups.indexOf(right.group) || kindRank(left.period) - kindRank(right.period),
  )
  const used = new Set<string>()
  const windows = usable.flatMap(({ group, bucket, period }) => {
    const remaining = fractionOf(bucket)
    if (remaining === undefined) return []
    const prefix = group === undefined ? "" : `${group}/`
    const named = nonEmpty(bucket.displayName) ?? nonEmpty(bucket.bucketId)
    const namedID = nonEmpty(bucket.bucketId) ?? named
    const kindID = `${prefix}${period === weeklySeconds ? "weekly" : "five-hour"}`
    const standard = period !== undefined && !used.has(kindID)
    const id = standard ? kindID : namedID === undefined ? undefined : `${prefix}${namedID}`
    const label = standard ? (period === weeklySeconds ? "Weekly limit" : "Five hour limit") : named
    if (id === undefined || label === undefined || used.has(id)) return []
    used.add(id)
    const resetAt = bucket.resetTime ? Date.parse(bucket.resetTime) : Number.NaN
    return [
      new ProviderUsage.Window({
        id,
        label,
        unit: "percent",
        used: (1 - remaining) * 100,
        ...(group === undefined ? {} : { group }),
        ...(Number.isFinite(resetAt) ? { resetAt } : {}),
        ...(standard ? { periodSeconds: period } : {}),
      }),
    ]
  })
  return new ProviderUsage.Snapshot({
    providerID,
    label: "Antigravity",
    status: "available",
    source: "provider_internal_api",
    stability: "client_contract",
    updatedAt: Math.max(0, Math.trunc(updatedAt)),
    windows,
  })
}
