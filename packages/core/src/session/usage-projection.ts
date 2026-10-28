export * as SessionUsageProjection from "./usage-projection"

import { DateTime, Schema } from "effect"
import { Money } from "@ycoding-ai/schema/money"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Agent } from "../agent"
import { CatalogModel } from "../model"
import { Project } from "../project"
import { Provider } from "../provider"
import { SessionMessage } from "./message"
import type { SessionProviderRequest } from "./provider-request"
import { SessionSchema } from "./schema"
import type { Aggregate } from "./usage-read"

export function usageReportGroup(
  group: ProviderRequest.ReportGroup,
  item: {
    readonly record: Pick<SessionProviderRequest.CostedRecord, "model" | "agent" | "time" | "usageAnchor">
    readonly session: Pick<SessionSchema.Info, "id" | "title" | "projectID">
    readonly taskID?: SessionSchema.ID
  },
  projects: ReadonlyArray<Project.Info>,
  formatter?: Intl.DateTimeFormat,
) {
  if (group === "provider")
    return { key: JSON.stringify([group, item.record.model.providerID]), label: item.record.model.providerID }
  if (group === "provider-profile-model")
    return {
      key: JSON.stringify([
        group,
        item.record.model.providerID,
        item.record.model.profile ?? null,
        item.record.model.id,
      ]),
      label: `${item.record.model.providerID}/${item.record.model.id} · ${item.record.model.profile ?? "Provider default"}`,
    }
  if (group === "provider-model")
    return {
      key: JSON.stringify([group, item.record.model.providerID, item.record.model.id]),
      label: `${item.record.model.providerID}/${item.record.model.id}`,
    }
  if (group === "model-id") return { key: JSON.stringify([group, item.record.model.id]), label: item.record.model.id }
  if (group === "profile")
    return {
      key: JSON.stringify([group, item.record.model.providerID, item.record.model.profile ?? null]),
      label: `${item.record.model.providerID} · ${item.record.model.profile ?? "Provider default"}`,
    }
  if (group === "prompt")
    return {
      key: JSON.stringify([
        group,
        item.record.usageAnchor?.sessionID ?? null,
        item.record.usageAnchor?.inputID ?? null,
      ]),
      label: item.record.usageAnchor?.inputID ?? "Unattributed",
    }
  if (group === "task")
    return { key: JSON.stringify([group, item.taskID ?? null]), label: item.taskID ?? "Main Session / unattributed" }
  if (group === "model") {
    const variant = item.record.model.variant
    return {
      key: [item.record.model.providerID, item.record.model.id, variant, item.record.model.profile]
        .flatMap((part) => (part === undefined ? [] : [part]))
        .map((part) => encodeURIComponent(part))
        .join("/"),
      label: `${item.record.model.providerID}/${item.record.model.id}${variant ? ` (${variant})` : ""}${item.record.model.profile ? ` · ${item.record.model.profile}` : ""}`,
    }
  }
  if (group === "session") return { key: item.session.id, label: item.session.title }
  if (group === "project") {
    if (item.session.projectID === Project.ID.global)
      return { key: item.session.projectID, label: "Global (no project)" }
    const project = projects.find((project) => project.id === item.session.projectID)
    return {
      key: item.session.projectID,
      label: project
        ? project.name
          ? `${project.name} · ${project.worktree}`
          : project.worktree
        : item.session.projectID,
    }
  }
  if (group === "agent") return { key: item.record.agent, label: item.record.agent }
  const iso = new Date(DateTime.toEpochMillis(item.record.time)).toISOString()
  if (formatter) {
    const parts = formatter.formatToParts(DateTime.toEpochMillis(item.record.time))
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? ""
    const date = `${part("year")}-${part("month")}-${part("day")}`
    if (group === "day") return { key: date, label: date }
    if (group === "month") return { key: date.slice(0, 7), label: date.slice(0, 7) }
    const offset = part("timeZoneName").replace("GMT", "") || "+00:00"
    return { key: `${date}T${part("hour")}:00:00${offset}`, label: `${date}T${part("hour")}:00 ${offset}` }
  }
  if (group === "hour") return { key: `${iso.slice(0, 13)}:00:00.000Z`, label: `${iso.slice(0, 13)}:00 UTC` }
  if (group === "day") return { key: iso.slice(0, 10), label: iso.slice(0, 10) }
  return { key: iso.slice(0, 7), label: iso.slice(0, 7) }
}

export function usageSummary(
  groups: Iterable<{ readonly metrics: ProviderRequest.ReportMetrics; readonly model: ProviderRequest.Record["model"] }>,
  total: ProviderRequest.ReportMetrics,
  latest: { readonly invalidation: ProviderRequest.Invalidation; readonly namespace: string; readonly timing: string | null } | undefined,
): ProviderRequest.Summary {
  const models = [...groups]
    .map((group) => ({
      model: group.model,
      requests: group.metrics.logical,
      tokens: group.metrics.tokens,
      cacheReadReported: group.metrics.cacheReadReported,
      ...(group.metrics.cost === undefined
        ? {}
        : { cost: group.metrics.cost, costProvenance: group.metrics.costProvenance }),
    }))
    .sort(
      (left, right) =>
        (left.cost === undefined
          ? right.cost === undefined
            ? 0
            : 1
          : right.cost === undefined
            ? -1
            : right.cost - left.cost) ||
        left.model.providerID.localeCompare(right.model.providerID) ||
        left.model.id.localeCompare(right.model.id) ||
        (left.model.variant ?? "").localeCompare(right.model.variant ?? "") ||
        (left.model.profile ?? "").localeCompare(right.model.profile ?? ""),
    )
  return {
    logical: total.logical,
    physical: total.physical,
    helpers: total.helpers,
    continued: total.continued,
    fallback: total.fallback,
    tokens: total.tokens,
    ...(total.cacheReadReported === undefined ? {} : { cacheReadReported: total.cacheReadReported }),
    ...(total.cost === undefined ? {} : { cost: total.cost }),
    ...(models.length === 0 ? {} : { models }),
    ...(latest
      ? {
          latestInvalidation: latest.invalidation,
          latestNamespace: latest.namespace,
          ...(latest.timing === null
            ? {}
            : {
                latestTiming: Schema.decodeUnknownSync(Schema.fromJsonString(ProviderRequest.Timing))(
                  latest.timing,
                ),
              }),
        }
      : {}),
  }
}

export function reportFormatter(input: Pick<ProviderRequest.ReportInput, "group" | "timeZone">) {
  return input.timeZone && ["hour", "day", "month"].includes(input.group)
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: input.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
        timeZoneName: "longOffset",
      })
    : undefined
}

const hourMs = 3_600_000

export function localDate(time: number, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(time)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value)
  return { year: part("year"), month: part("month"), day: part("day") }
}

export function localMidnight(year: number, month: number, date: number, formatter: Intl.DateTimeFormat) {
  const target = Date.UTC(year, month - 1, date)
  const start = target - 48 * hourMs
  const ordinal = (time: number) => {
    const value = localDate(time, formatter)
    return Date.UTC(value.year, value.month - 1, value.day)
  }
  for (let end = start + hourMs; end <= target + 48 * hourMs; end += hourMs) {
    if (ordinal(end - hourMs) >= target || ordinal(end) < target) continue
    let low = end - hourMs
    let high = end
    while (high - low > 1) {
      const middle = low + Math.floor((high - low) / 2)
      if (ordinal(middle) >= target) high = middle
      else low = middle
    }
    return high
  }
  return target
}

function bucketLength(group: "day" | "month", key: string, formatter: Intl.DateTimeFormat | undefined) {
  const [year = 0, month = 1, date = 1] = key.split("-").map(Number)
  const midnight = (day: number, offset: number) =>
    formatter ? localMidnight(year, month + offset, day, formatter) : Date.UTC(year, month - 1 + offset, day)
  return group === "day" ? midnight(date + 1, 0) - midnight(date, 0) : midnight(1, 1) - midnight(1, 0)
}

function concurrency(group: ProviderRequest.ReportGroup, key: string, busy: number, formatter: Intl.DateTimeFormat | undefined) {
  if (group === "hour") return busy / hourMs
  if (group === "day" || group === "month") return busy / bucketLength(group, key, formatter)
  return undefined
}

export function reportRow(
  group: ProviderRequest.ReportGroup,
  item: Aggregate & { readonly speed?: ProviderRequest.Speed; readonly busy?: number },
  projectInfos: ReadonlyArray<Project.Info>,
  formatter: Intl.DateTimeFormat | undefined,
) {
  const model = Schema.decodeUnknownSync(Schema.fromJsonString(CatalogModel.Ref))(item.model)
  const shape = usageReportGroup(
    group,
    {
      record: { model, agent: Agent.ID.make(item.agent), time: DateTime.makeUnsafe(item.time) },
      session: { id: SessionSchema.ID.make(item.sessionID), title: item.title, projectID: Project.ID.make(item.projectID) },
    },
    projectInfos,
    formatter,
  )
  const dimensions = reportDimensions(group, item.key)
  const concurrent = item.busy === undefined ? undefined : concurrency(group, item.key, item.busy, formatter)
  return {
    key: item.key,
    label: dimensions ? dimensionLabel(dimensions) : shape.label,
    ...(group === "model" ? { model } : {}),
    ...(dimensions ? { dimensions } : {}),
    ...usageMetrics(item),
    ...(item.speed === undefined ? {} : { speed: item.speed }),
    ...(concurrent === undefined ? {} : { concurrency: concurrent }),
  }
}

export function combineUsage(
  left: ProviderRequest.ReportMetrics,
  right: ProviderRequest.ReportMetrics,
): ProviderRequest.ReportMetrics {
  return {
    logical: left.logical + right.logical,
    physical: left.physical + right.physical,
    helpers: left.helpers + right.helpers,
    continued: left.continued + right.continued,
    fallback: left.fallback + right.fallback,
    tokens: {
      input: left.tokens.input + right.tokens.input,
      output: left.tokens.output + right.tokens.output,
      reasoning: left.tokens.reasoning + right.tokens.reasoning,
      cache: {
        read: left.tokens.cache.read + right.tokens.cache.read,
        write: left.tokens.cache.write + right.tokens.cache.write,
      },
    },
    ...(left.cost === undefined && right.cost === undefined
      ? {}
      : {
          cost: Money.USD.make((left.cost ?? 0) + (right.cost ?? 0)),
          costProvenance:
            left.costProvenance === "current_catalog" || right.costProvenance === "current_catalog"
              ? "current_catalog"
              : "recorded",
        }),
    ...(left.logical + right.logical === 0
      ? {}
      : {
          cacheReadReported:
            (left.logical === 0 || left.cacheReadReported === true) &&
            (right.logical === 0 || right.cacheReadReported === true),
        }),
    ...(left.outcomes === undefined && right.outcomes === undefined
      ? {}
      : {
          outcomes: {
            completed: (left.outcomes?.completed ?? left.logical) + (right.outcomes?.completed ?? right.logical),
            failed: (left.outcomes?.failed ?? 0) + (right.outcomes?.failed ?? 0),
            cancelled: (left.outcomes?.cancelled ?? 0) + (right.outcomes?.cancelled ?? 0),
          },
        }),
  }
}

export function usageMetrics(item: Aggregate): ProviderRequest.ReportMetrics {
  return {
    costCoverage: { pricedRequests: item.priced, unpricedRequests: item.logical - item.priced },
    logical: item.logical,
    physical: item.physical,
    helpers: item.helpers,
    continued: item.continued,
    fallback: item.fallback,
    tokens: {
      input: item.input,
      output: item.output,
      reasoning: item.reasoning,
      cache: { read: item.cacheRead, write: item.cacheWrite },
    },
    ...(item.logical === 0 ? {} : { cacheReadReported: item.cacheReadReported === 1 }),
    ...(item.priced === 0
      ? {}
      : { cost: Money.USD.make(item.cost), costProvenance: item.currentCatalog ? "current_catalog" : "recorded" }),
    ...(item.outcomes > 0
      ? { outcomes: { completed: item.logical - item.failed - item.cancelled, failed: item.failed, cancelled: item.cancelled } }
      : {}),
  }
}

export function correctedUsage(
  metrics: ProviderRequest.ReportMetrics,
  cost: number,
  requests: number,
): ProviderRequest.ReportMetrics {
  if (requests === 0) return metrics
  return {
    ...metrics,
    cost: Money.USD.make((metrics.cost ?? 0) + cost),
    costProvenance: "current_catalog",
    ...(metrics.costCoverage
      ? {
          costCoverage: {
            pricedRequests: metrics.costCoverage.pricedRequests + requests,
            unpricedRequests: metrics.costCoverage.unpricedRequests - requests,
          },
        }
      : {}),
  }
}

export function reportDimensions(
  group: ProviderRequest.ReportGroup,
  key: string,
): ProviderRequest.ReportDimensions | undefined {
  if (
    !["provider", "provider-profile-model", "provider-model", "model-id", "profile", "prompt", "task"].includes(group)
  )
    return undefined
  const parts = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))))(key)
  const providerID = Provider.ID.make(parts[1] ?? "")
  if (group === "provider") return { group, providerID }
  if (group === "provider-model") return { group, providerID, modelID: CatalogModel.ID.make(parts[2]!) }
  if (group === "model-id") return { group, modelID: CatalogModel.ID.make(parts[1]!) }
  const profile = {
    providerID,
    ...(parts[2] === null
      ? { profileState: "provider-default" as const }
      : { profile: parts[2]!, profileState: "recorded" as const }),
  }
  if (group === "profile") return { group, ...profile }
  if (group === "provider-profile-model") return { group, ...profile, modelID: CatalogModel.ID.make(parts[3]!) }
  if (group === "prompt")
    return parts[1] === null
      ? { group, attribution: "unattributed" }
      : {
          group,
          attribution: "complete",
          anchor: { sessionID: SessionSchema.ID.make(parts[1]!), inputID: SessionMessage.ID.make(parts[2]!) },
        }
  return parts[1] === null
    ? { group: "task", attribution: "unattributed" }
    : { group: "task", attribution: "complete", sessionID: SessionSchema.ID.make(parts[1]!) }
}

export function dimensionLabel(dimensions: ProviderRequest.ReportDimensions) {
  if (dimensions.group === "provider") return dimensions.providerID
  if (dimensions.group === "model-id") return dimensions.modelID
  if (dimensions.group === "provider-model") return `${dimensions.providerID}/${dimensions.modelID}`
  if (dimensions.group === "profile") return `${dimensions.providerID} · ${dimensions.profile ?? "Provider default"}`
  if (dimensions.group === "provider-profile-model")
    return `${dimensions.providerID}/${dimensions.modelID} · ${dimensions.profile ?? "Provider default"}`
  if (dimensions.group === "prompt") return dimensions.anchor?.inputID ?? "Unattributed"
  return dimensions.sessionID ?? "Main Session / unattributed"
}
