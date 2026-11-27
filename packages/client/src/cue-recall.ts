import { escapeDisplayText } from "./tool-display"

export type RecallMethod = "explicit" | "cue" | "exact" | "bm25" | "semantic" | "rrf"
export type RecallStage = "candidate" | "rejected" | "selected" | "injected" | "restored"
export type RecallKind = "memory" | "skill"
export type RecallOutcome = "injected" | "abstained" | "restored"

export type RecallCue = {
  readonly id: string
  readonly kind: string
  readonly subject?: string
}

export type RecallItem = {
  readonly kind: RecallKind
  readonly id: string
  readonly stage: RecallStage
  readonly method: RecallMethod
  readonly scores?: {
    readonly bm25?: number
    readonly semantic?: number
    readonly rrf?: number
    readonly rank?: number
  }
  readonly reason: string
  readonly rejection?: string
  readonly source: { readonly id: string; readonly revision: string }
  readonly okf?: {
    readonly type: string
    readonly trust: string
    readonly freshness: string
    readonly lifecycle: string
  }
  readonly artifact?: {
    readonly kind: string
    readonly id: string
    readonly sourceScope: string
    readonly scopeID: string
    readonly versionID: string
  }
  readonly tokens?: number
}

export type RecallEntry = {
  readonly id: string
  readonly key: string
  readonly created: number
  readonly trigger: string
  readonly cue?: RecallCue
  readonly methods: readonly RecallMethod[]
  readonly outcome: RecallOutcome
  readonly abstention?: string
  readonly items: readonly RecallItem[]
  readonly elapsedMs: number
  readonly injectedTokens: number
  readonly budgetTokens?: number
}

export type RecallState = {
  readonly cues: Readonly<Record<string, RecallCue>>
  readonly entries: readonly RecallEntry[]
}

export const emptyRecall: RecallState = { cues: {}, entries: [] }

export type RecallRow = { readonly label: string; readonly value: string }

export type RecallTarget = {
  readonly kind: RecallKind
  readonly id: string
  readonly sourceID: string
  readonly revision: string
}

export type RecallItemDetail = {
  readonly title: string
  readonly rows: readonly RecallRow[]
  readonly target: RecallTarget
}

export type RecallDetails = {
  readonly header: readonly RecallRow[]
  readonly items: readonly RecallItemDetail[]
  readonly withheld: readonly RecallItemDetail[]
  readonly counts: { readonly candidates: number; readonly selected: number; readonly injected: number }
}

export type RecallSummary = {
  readonly label: string
  readonly title: string
  readonly meta: string
  readonly memories: number
  readonly skills: number
  readonly elapsed: string
  readonly tokens: string
}

const methods: readonly string[] = ["explicit", "cue", "exact", "bm25", "semantic", "rrf"]
const stages: readonly string[] = ["candidate", "rejected", "selected", "injected", "restored"]
const delivered = new Set<RecallStage>(["injected", "restored"])
const chosen = new Set<RecallStage>(["selected", "injected", "restored"])
const cueLimit = 256

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined)
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined)
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

function readScores(value: unknown): RecallItem["scores"] {
  const scores = record(value)
  if (!scores) return undefined
  const read = {
    ...(finite(scores.bm25) === undefined ? {} : { bm25: finite(scores.bm25)! }),
    ...(finite(scores.semantic) === undefined ? {} : { semantic: finite(scores.semantic)! }),
    ...(finite(scores.rrf) === undefined ? {} : { rrf: finite(scores.rrf)! }),
    ...(count(scores.rank) === undefined ? {} : { rank: count(scores.rank)! }),
  }
  return Object.keys(read).length === 0 ? undefined : read
}

function readItem(value: unknown): RecallItem | undefined {
  const item = record(value)
  const id = text(item?.id)
  const stage = text(item?.stage)
  const method = text(item?.method)
  const source = record(item?.source)
  const sourceID = text(source?.id)
  const revision = text(source?.revision)
  if (!item || !id || !sourceID || !revision) return undefined
  if (item.kind !== "memory" && item.kind !== "skill") return undefined
  if (!stage || !stages.includes(stage) || !method || !methods.includes(method)) return undefined
  const okf = record(item.okf)
  const artifact = record(item.artifact)
  const scores = readScores(item.scores)
  return {
    kind: item.kind,
    id,
    stage: stage as RecallStage,
    method: method as RecallMethod,
    ...(scores ? { scores } : {}),
    reason: typeof item.reason === "string" ? item.reason : "",
    ...(text(item.rejection) ? { rejection: text(item.rejection)! } : {}),
    source: { id: sourceID, revision },
    ...(okf && text(okf.type) && text(okf.trust) && text(okf.freshness) && text(okf.lifecycle)
      ? { okf: { type: text(okf.type)!, trust: text(okf.trust)!, freshness: text(okf.freshness)!, lifecycle: text(okf.lifecycle)! } }
      : {}),
    ...(artifact && text(artifact.kind) && text(artifact.id) && text(artifact.sourceScope) && text(artifact.scopeID) && text(artifact.versionID)
      ? {
          artifact: {
            kind: text(artifact.kind)!,
            id: text(artifact.id)!,
            sourceScope: text(artifact.sourceScope)!,
            scopeID: text(artifact.scopeID)!,
            versionID: text(artifact.versionID)!,
          },
        }
      : {}),
    ...(count(item.tokens) === undefined ? {} : { tokens: count(item.tokens)! }),
  }
}

function readCue(data: Record<string, unknown>): RecallCue | undefined {
  const id = text(data.cueID)
  const kind = text(data.kind)
  if (!id || !kind) return undefined
  return { id, kind, ...(text(data.subject) ? { subject: text(data.subject)! } : {}) }
}

function readRecall(event: Record<string, unknown>, data: Record<string, unknown>, cues: RecallState["cues"]): RecallEntry | undefined {
  const id = text(event.id)
  const key = text(data.key)
  const trigger = text(data.trigger)
  const outcome = text(data.outcome)
  const elapsedMs = count(data.elapsedMs)
  const injectedTokens = count(data.injectedTokens)
  if (!id || !key || !trigger || elapsedMs === undefined || injectedTokens === undefined) return undefined
  if (outcome !== "injected" && outcome !== "abstained" && outcome !== "restored") return undefined
  if (typeof event.created !== "number" || !Array.isArray(data.items) || !Array.isArray(data.methods)) return undefined
  const cueID = text(data.cueID)
  const cue = cueID === undefined ? undefined : cues[cueID]
  return {
    id,
    key,
    created: event.created,
    trigger,
    ...(cue ? { cue } : {}),
    methods: data.methods.filter((method): method is RecallMethod => typeof method === "string" && methods.includes(method)),
    outcome,
    ...(text(data.abstention) ? { abstention: text(data.abstention)! } : {}),
    items: data.items.flatMap((item) => readItem(item) ?? []),
    elapsedMs,
    injectedTokens,
    ...(count(data.budgetTokens) === undefined ? {} : { budgetTokens: count(data.budgetTokens)! }),
  }
}

export function foldRecallEvent(state: RecallState, value: unknown): RecallState {
  const event = record(value)
  const data = record(event?.data)
  if (!event || !data) return state
  if (event.type === "session.cue.detected") {
    const cue = readCue(data)
    if (!cue) return state
    const kept = Object.entries(state.cues).filter(([id]) => id !== cue.id).slice(-(cueLimit - 1))
    return { ...state, cues: Object.fromEntries([...kept, [cue.id, cue]]) }
  }
  if (event.type !== "session.recall.recorded") return state
  const entry = readRecall(event, data, state.cues)
  if (!entry) return state
  const entries = [...state.entries.filter((item) => item.id !== entry.id && item.key !== entry.key), entry].toSorted(
    (a, b) => a.created - b.created || a.id.localeCompare(b.id),
  )
  return { ...state, entries }
}

export const foldRecallEvents = (events: readonly unknown[], state: RecallState = emptyRecall) =>
  events.reduce<RecallState>(foldRecallEvent, state)

export const recallVisible = (entry: RecallEntry) =>
  entry.outcome !== "abstained" && entry.items.some((item) => delivered.has(item.stage))

const plural = (amount: number, singular: string, many: string) => `${amount} ${amount === 1 ? singular : many}`

const formatElapsed = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)

export function recallSummary(entry: RecallEntry): RecallSummary {
  const injected = entry.items.filter((item) => delivered.has(item.stage))
  const memories = injected.filter((item) => item.kind === "memory").length
  const skills = injected.filter((item) => item.kind === "skill").length
  const elapsed = formatElapsed(entry.elapsedMs)
  const tokens = `~${plural(entry.injectedTokens, "token", "tokens")}`
  const parts = [
    ...(memories > 0 ? [plural(memories, "memory", "memories")] : []),
    ...(skills > 0 ? [plural(skills, "skill", "skills")] : []),
  ]
  const verb = entry.outcome === "restored" ? "Restored" : "Recalled"
  const title = parts.length > 0 ? `${verb} ${parts.join(" · ")}` : verb
  const meta = `${elapsed} · ${tokens}`
  return { label: `${title} · ${meta}`, title, meta, memories, skills, elapsed, tokens }
}

function relevance(item: RecallItem) {
  const scores = item.scores
  if (!scores) return undefined
  const parts = [
    scores.bm25 === undefined ? undefined : `bm25 ${scores.bm25}`,
    scores.semantic === undefined ? undefined : `semantic ${scores.semantic}`,
    scores.rrf === undefined ? undefined : `rrf ${scores.rrf}`,
    scores.rank === undefined ? undefined : `rank ${scores.rank + 1}`,
  ].filter(Boolean)
  return parts.join(" · ")
}

function itemDetail(item: RecallItem, withheld: boolean): RecallItemDetail {
  const artifact = item.artifact
    ? `${item.artifact.kind} ${item.artifact.id} · ${item.artifact.sourceScope} · ${item.artifact.versionID}`
    : undefined
  const rows: [string, string | undefined][] = [
    ["outcome", withheld ? [item.stage, item.rejection].filter(Boolean).join(" · ") : undefined],
    ["method", item.method],
    ["relevance", relevance(item)],
    ["reason", item.reason || undefined],
    ["source", `${item.source.id} @ ${item.source.revision}`],
    ["artifact", artifact],
    ["type", item.okf?.type],
    ["trust", item.okf?.trust],
    ["freshness", item.okf?.freshness],
    ["lifecycle", item.okf?.lifecycle],
    ["tokens", item.tokens === undefined ? undefined : `~${item.tokens}`],
  ]
  return {
    title: escapeDisplayText(`${item.kind} ${item.id}`),
    rows: rows.flatMap(([label, value]) => (value === undefined ? [] : [{ label, value: escapeDisplayText(value) }])),
    target: { kind: item.kind, id: item.id, sourceID: item.source.id, revision: item.source.revision },
  }
}

export function recallDetails(entry: RecallEntry): RecallDetails {
  const cue = entry.cue ? [entry.cue.kind, entry.cue.subject].filter(Boolean).join(" · ") : undefined
  const used = entry.methods.join(", ")
  const header: [string, string | undefined][] = [
    ["trigger", entry.trigger],
    ["cue", cue],
    ["method", used || undefined],
    ["budget", entry.budgetTokens === undefined ? undefined : `${entry.injectedTokens} of ${entry.budgetTokens} tokens`],
  ]
  return {
    header: header.flatMap(([label, value]) => (value === undefined ? [] : [{ label, value: escapeDisplayText(value) }])),
    items: entry.items.filter((item) => delivered.has(item.stage)).map((item) => itemDetail(item, false)),
    withheld: entry.items.filter((item) => !delivered.has(item.stage)).map((item) => itemDetail(item, true)),
    counts: {
      candidates: entry.items.length,
      selected: entry.items.filter((item) => chosen.has(item.stage)).length,
      injected: entry.items.filter((item) => delivered.has(item.stage)).length,
    },
  }
}
