export * as ContextManifest from "./context-manifest"

import { createHash } from "crypto"
import { Event, NonNegativeInt, SessionMessage } from "@ycoding-ai/schema"
import { Schema } from "effect"
import { Token } from "../util/token"

const strictDecodeOptions = { errors: "all", onExcessProperty: "error" } as const
const nonempty = Schema.String.check(Schema.isMinLength(1))

export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export type Digest = typeof Digest.Type

export const CoveredThrough = Schema.Struct({
  messageID: SessionMessage.ID,
  seq: Event.Seq,
})
export type CoveredThrough = typeof CoveredThrough.Type

export const MessageSelector = Schema.Struct({
  kind: Schema.tag("message"),
  messageID: SessionMessage.ID,
  digest: Digest,
})
export type MessageSelector = typeof MessageSelector.Type

export const PartSelector = Schema.Struct({
  kind: Schema.tag("part"),
  messageID: SessionMessage.ID,
  ordinal: NonNegativeInt,
  partKind: nonempty,
  digest: Digest,
})
export type PartSelector = typeof PartSelector.Type

export const TargetSelector = Schema.Union([MessageSelector, PartSelector], { mode: "oneOf" }).pipe(
  Schema.toTaggedUnion("kind"),
)
export type TargetSelector = typeof TargetSelector.Type

export const ProviderStateSelector = Schema.Struct({
  kind: Schema.tag("provider_state"),
  messageID: SessionMessage.ID,
  ordinal: NonNegativeInt,
  partKind: nonempty,
  digest: Digest,
})
export type ProviderStateSelector = typeof ProviderStateSelector.Type

export const ExactDuplicate = Schema.Struct({
  reason: Schema.tag("exact_duplicate"),
  target: TargetSelector,
  evidence: TargetSelector,
})
export type ExactDuplicate = typeof ExactDuplicate.Type

export const SupersededAuthority = Schema.Struct({
  reason: Schema.tag("superseded_authority"),
  target: TargetSelector,
  authorityKind: nonempty,
  authorityKey: nonempty,
  targetRevision: NonNegativeInt,
  evidence: TargetSelector,
  evidenceRevision: NonNegativeInt,
})
export type SupersededAuthority = typeof SupersededAuthority.Type

export const TerminalIntermediate = Schema.Struct({
  reason: Schema.tag("terminal_intermediate"),
  target: TargetSelector,
  terminalEventID: Event.ID,
})
export type TerminalIntermediate = typeof TerminalIntermediate.Type

export const StaleToolResult = Schema.Struct({
  reason: Schema.tag("stale_tool_result"),
  target: TargetSelector,
  tool: nonempty,
  resourceKey: nonempty,
  targetRevision: NonNegativeInt,
  evidence: TargetSelector,
  evidenceRevision: NonNegativeInt,
})
export type StaleToolResult = typeof StaleToolResult.Type

export const Exclusion = Schema.Union([ExactDuplicate, SupersededAuthority, TerminalIntermediate, StaleToolResult], {
  mode: "oneOf",
}).pipe(Schema.toTaggedUnion("reason"))
export type Exclusion = typeof Exclusion.Type

export const ProtectedStateSource = Schema.Literals([
  "instructions",
  "todos",
  "goal",
  "autonomy",
  "permissions",
  "guardrails",
  "project_artifacts",
  "pending_work",
  "orchestration",
])
export type ProtectedStateSource = typeof ProtectedStateSource.Type

export const ProtectedStateEntry = Schema.Struct({
  source: ProtectedStateSource,
  revision: NonNegativeInt,
  digest: Digest,
})
export type ProtectedStateEntry = typeof ProtectedStateEntry.Type

export const Candidate = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  baseContextRevision: NonNegativeInt,
  coveredThrough: CoveredThrough,
  protectedState: Schema.Array(ProtectedStateEntry),
  exclusions: Schema.Array(Exclusion),
})
export type Candidate = typeof Candidate.Type

export const RollingSummary = Schema.Struct({
  text: nonempty,
  coveredThrough: CoveredThrough,
  digest: Digest,
})
export type RollingSummary = typeof RollingSummary.Type

export const ProviderCompaction = Schema.Struct({
  provider: nonempty,
  modelID: nonempty,
  output: Schema.Array(Schema.Json),
})
export type ProviderCompaction = typeof ProviderCompaction.Type

const decodeJSON = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)
const decodeCandidateValue = Schema.decodeUnknownSync(Candidate, strictDecodeOptions)

export function decodeCandidate(input: string): Candidate {
  return deepFreeze(decodeCandidateValue(decodeJSON(input)))
}

export type IntermediateKind =
  | "assistant_reasoning"
  | "tool_progress"
  | "retry_notice"
  | "failed_partial_provider_output"

export type ToolProtocolEvidence = {
  readonly callID: string
  readonly role: "call" | "result"
}

type ContextItemBase = {
  readonly messageID: SessionMessage.ID
  readonly position: number
  readonly terminalSeq: Event.Seq
  readonly inputKind: string
  readonly payload: Schema.Json
  readonly tokens: number
  readonly dependencyGroup?: string
  readonly toolCall?: ToolProtocolEvidence
}

export type MessageItem = ContextItemBase & {
  readonly kind: "message"
}

export type PartItem = ContextItemBase & {
  readonly kind: "part"
  readonly ordinal: number
  readonly partKind: string
  readonly executionGroup: string
  readonly intermediateKind?: IntermediateKind
}

export type ContextItem = MessageItem | PartItem

export type SettlementEvidence =
  | {
      readonly executionGroup: string
      readonly status: "running"
    }
  | {
      readonly executionGroup: string
      readonly status: "terminal"
      readonly terminalEventID: Event.ID
      readonly outcome: "succeeded" | "failed"
      readonly successfulToolEffect: boolean
      readonly fileChange: boolean
    }

export type AuthorityEvidence = {
  readonly selector: TargetSelector
  readonly authorityKind: string
  readonly authorityKey: string
  readonly revision: number
  readonly tool?: string
}

export type ToolResourceAuthority = {
  readonly tool: string
  readonly authorityKind: string
}

export type ToolResultEvidence = {
  readonly selector: TargetSelector
  readonly tool: string
  readonly resourceKey: string
  readonly revision: number
  readonly status: "succeeded" | "failed"
}

export type ProviderLinkEvidence = {
  readonly messageID: SessionMessage.ID
  readonly ordinal: number
  readonly partKind: string
  readonly digest: string
  readonly terminalSeq: Event.Seq
}

export type RuntimeEvidence = {
  readonly baseContextRevision: number
  readonly coveredThrough: CoveredThrough
  readonly items: ReadonlyArray<ContextItem>
  readonly settlements: ReadonlyArray<SettlementEvidence>
  readonly authorities: ReadonlyArray<AuthorityEvidence>
  readonly resourceAuthorities: ReadonlyArray<ToolResourceAuthority>
  readonly toolResults: ReadonlyArray<ToolResultEvidence>
  readonly protectedTargets: ReadonlyArray<TargetSelector>
  readonly providerLinks: ReadonlyArray<ProviderLinkEvidence>
  readonly protectedState: ReadonlyArray<ProtectedStateEntry>
}

export type ValidationInput = {
  readonly candidate: Candidate
  readonly evidence: RuntimeEvidence
  readonly summary?: RollingSummary
  readonly providerCompaction?: ProviderCompaction
  readonly modelTokens?: {
    readonly before: number
    readonly after: number
  }
}

export type ValidationIssueCode =
  | "base_revision_changed"
  | "covered_boundary_changed"
  | "duplicate_target"
  | "evidence_after_boundary"
  | "evidence_excluded"
  | "empty_retained_history"
  | "invalid_exact_duplicate"
  | "invalid_runtime_evidence"
  | "invalid_stale_tool_result"
  | "invalid_superseded_authority"
  | "invalid_terminal_intermediate"
  | "no_token_reduction"
  | "non_chronological_lowering"
  | "part_unsettled"
  | "protected_state_changed"
  | "protected_target"
  | "selector_mismatch"
  | "target_after_boundary"
  | "dependency_closure"
  | "undeclared_tool_authority"

export type ValidationIssue = {
  readonly code: ValidationIssueCode
  readonly message: string
}

export type ValidatedLocalExclusion = Exclusion & {
  readonly targetKey: string
  readonly dependencyGroup?: string
}

export type ProviderRebaseExclusion = {
  readonly reason: "provider_rebase"
  readonly target: ProviderStateSelector
  readonly targetKey: string
}

export type ValidatedExclusion = ValidatedLocalExclusion | ProviderRebaseExclusion

export type Manifest = {
  readonly schemaVersion: 1
  readonly baseContextRevision: number
  readonly coveredThrough: CoveredThrough
  readonly protectedState: ReadonlyArray<ProtectedStateEntry>
  readonly exclusions: ReadonlyArray<ValidatedExclusion>
  readonly summary?: RollingSummary
  readonly providerCompaction?: ProviderCompaction
  readonly inputTokens: number
  readonly retainedTokens: number
}

export type ValidationResult =
  | { readonly valid: true; readonly manifest: Manifest }
  | { readonly valid: false; readonly issues: ReadonlyArray<ValidationIssue> }

type IndexedEvidence = {
  readonly items: ReadonlyMap<string, ContextItem>
  readonly settlements: ReadonlyMap<string, SettlementEvidence>
  readonly authorities: ReadonlyMap<string, AuthorityEvidence>
  readonly toolResults: ReadonlyMap<string, ToolResultEvidence>
  readonly boundaryPosition: number | undefined
}

const builtInAuthorityKinds = new Set([
  "instructions",
  "todos",
  "goals",
  "autonomy",
  "permissions",
  "guardrails",
  "project_artifacts",
])

export function payloadDigest(value: Schema.Json): string {
  return createHash("sha256").update(canonicalJSON(value)).digest("hex")
}

export function selector(item: ContextItem): TargetSelector {
  const digest = Digest.make(payloadDigest(item.payload))
  if (item.kind === "message") return { kind: "message", messageID: item.messageID, digest }
  return {
    kind: "part",
    messageID: item.messageID,
    ordinal: NonNegativeInt.make(item.ordinal),
    partKind: item.partKind,
    digest,
  }
}

export function targetKey(target: TargetSelector | ProviderStateSelector): string {
  return createHash("sha256").update(canonicalJSON(target)).digest("hex")
}

export function validate(input: ValidationInput): ValidationResult {
  const issues: ValidationIssue[] = []
  const indexed = indexEvidence(input.evidence, issues)
  const candidateProtectedState = normalizeProtectedState(input.candidate.protectedState, issues)
  const currentProtectedState = normalizeProtectedState(input.evidence.protectedState, issues)

  if (input.candidate.baseContextRevision !== input.evidence.baseContextRevision)
    addIssue(issues, "base_revision_changed", "The candidate base context revision is no longer active")
  if (!sameBoundary(input.candidate.coveredThrough, input.evidence.coveredThrough))
    addIssue(issues, "covered_boundary_changed", "The candidate covered boundary no longer matches runtime evidence")
  if (canonicalJSON(candidateProtectedState) !== canonicalJSON(currentProtectedState))
    addIssue(issues, "protected_state_changed", "The protected-state snapshot changed after candidate generation")

  const protectedTargets = new Set(input.evidence.protectedTargets.map(selectorIdentity))
  const summarized = validateSummary(input.summary, input.evidence, indexed, protectedTargets, issues)
  const providerCompaction = validateProviderCompaction(input.providerCompaction, issues)
  if (summarized.summary !== undefined && providerCompaction !== undefined)
    addIssue(issues, "invalid_runtime_evidence", "A compaction manifest cannot contain both summary and provider output")
  const providerItems =
    providerCompaction === undefined
      ? []
      : input.evidence.items.filter((item) => item.terminalSeq <= input.evidence.coveredThrough.seq)
  const targetIdentities = new Set([...summarized.items, ...providerItems].map(itemIdentity))
  const resolved = input.candidate.exclusions.flatMap((exclusion) => {
    const identity = selectorIdentity(exclusion.target)
    if (targetIdentities.has(identity))
      addIssue(issues, "duplicate_target", `Target ${identity} appears more than once`)
    targetIdentities.add(identity)
    const item = resolveSelector(exclusion.target, indexed, issues)
    if (!item) return []
    validateItemBoundary(item, indexed.boundaryPosition, input.evidence.coveredThrough, "target", issues)
    validatePartSettlement(item, indexed, issues)
    if (protectedTargets.has(identity))
      addIssue(issues, "protected_target", `Target ${identity} is protected live state`)
    validateReason(exclusion, item, input, indexed, targetIdentities, issues)
    return [{ exclusion, item, identity }]
  })

  validateEvidenceRetention(input.candidate.exclusions, targetIdentities, indexed, issues)
  validateDependencyClosure(input.evidence.items, targetIdentities, issues)

  const canonicalInputTokens = input.evidence.items.reduce((sum, item) => sum + validTokens(item, issues), 0)
  const excludedItems = new Map([
    ...summarized.items.map((item) => [itemIdentity(item), item] as const),
    ...providerItems.map((item) => [itemIdentity(item), item] as const),
    ...resolved.map((entry) => [entry.identity, entry.item] as const),
  ])
  const canonicalRetainedTokens =
    canonicalInputTokens -
    [...excludedItems.values()].reduce((sum, item) => sum + validTokens(item, issues), 0) +
    (summarized.summary ? Token.estimate(summarized.summary.text) : 0) +
    (providerCompaction ? Token.estimate(canonicalJSON(providerCompaction.output)) : 0)
  if (
    input.modelTokens &&
    (!Number.isInteger(input.modelTokens.before) ||
      input.modelTokens.before < 0 ||
      !Number.isInteger(input.modelTokens.after) ||
      input.modelTokens.after < 0)
  )
    addIssue(issues, "invalid_runtime_evidence", "Model-view token evidence must be non-negative integers")
  const inputTokens = input.modelTokens?.before ?? canonicalInputTokens
  const retainedTokens = input.modelTokens?.after ?? canonicalRetainedTokens
  if (retainedTokens >= inputTokens)
    addIssue(issues, "no_token_reduction", "The candidate does not reduce the measured model-input tokens")
  if (excludedItems.size >= input.evidence.items.length && summarized.summary === undefined && providerCompaction === undefined)
    addIssue(issues, "empty_retained_history", "The candidate would leave no retained chronological history")

  if (issues.length > 0) return deepFreeze({ valid: false, issues: deduplicateIssues(issues) })

  const localExclusions = resolved
    .toSorted(
      (left, right) =>
        left.item.position - right.item.position ||
        compareStrings(targetKey(left.exclusion.target), targetKey(right.exclusion.target)),
    )
    .map(({ exclusion, item }) => validatedLocalExclusion(exclusion, item))
  const providerExclusions = deriveProviderRebase(input.evidence.providerLinks, input.evidence.coveredThrough)
  const manifest: Manifest = {
    schemaVersion: 1,
    baseContextRevision: input.candidate.baseContextRevision,
    coveredThrough: copyBoundary(input.candidate.coveredThrough),
    protectedState: candidateProtectedState.map(copyProtectedState),
    exclusions: [...localExclusions, ...providerExclusions],
    ...(summarized.summary === undefined ? {} : { summary: copyRollingSummary(summarized.summary) }),
    ...(providerCompaction === undefined ? {} : { providerCompaction: copyProviderCompaction(providerCompaction) }),
    inputTokens,
    retainedTokens,
  }
  return deepFreeze({ valid: true, manifest })
}

function validateProviderCompaction(providerCompaction: ProviderCompaction | undefined, issues: ValidationIssue[]) {
  if (providerCompaction === undefined) return undefined
  if (!Schema.is(ProviderCompaction)(providerCompaction) || providerCompaction.output.length === 0) {
    addIssue(issues, "invalid_runtime_evidence", "The provider compaction output is invalid")
    return undefined
  }
  return providerCompaction
}

function copyProviderCompaction(providerCompaction: ProviderCompaction): ProviderCompaction {
  return {
    provider: providerCompaction.provider,
    modelID: providerCompaction.modelID,
    output: providerCompaction.output.map(cloneJson),
  }
}

export function summarySelector(summary: RollingSummary): MessageSelector {
  return {
    kind: "message",
    messageID: summary.coveredThrough.messageID,
    digest: summary.digest,
  }
}

function validateSummary(
  summary: RollingSummary | undefined,
  evidence: RuntimeEvidence,
  indexed: IndexedEvidence,
  protectedTargets: ReadonlySet<string>,
  issues: ValidationIssue[],
): { readonly summary?: RollingSummary; readonly items: ReadonlyArray<ContextItem> } {
  if (summary === undefined) return { items: [] }
  if (!Schema.is(RollingSummary)(summary)) {
    addIssue(issues, "invalid_runtime_evidence", "The rolling summary metadata is invalid")
    return { items: [] }
  }
  const boundary = resolveSelector(summarySelector(summary), indexed, issues)
  if (!boundary) return { items: [] }
  if (boundary.terminalSeq !== summary.coveredThrough.seq)
    addIssue(issues, "selector_mismatch", "The rolling summary boundary sequence does not match canonical history")
  validateItemBoundary(boundary, indexed.boundaryPosition, evidence.coveredThrough, "target", issues)
  const items = evidence.items.filter((item) => item.position <= boundary.position)
  items.forEach((item) => {
    const identity = itemIdentity(item)
    if (protectedTargets.has(identity))
      addIssue(issues, "protected_target", `Summary target ${identity} is protected live state`)
  })
  return { summary: copyRollingSummary(summary), items }
}

function indexEvidence(evidence: RuntimeEvidence, issues: ValidationIssue[]): IndexedEvidence {
  const items = new Map<string, ContextItem>()
  evidence.items.forEach((item, index) => {
    if (
      !Number.isInteger(item.position) ||
      item.position < 0 ||
      !Number.isInteger(item.terminalSeq) ||
      item.terminalSeq < 0
    )
      addIssue(issues, "invalid_runtime_evidence", "Context item ordering evidence must be non-negative integers")
    const previous = evidence.items[index - 1]
    if (previous && (previous.position >= item.position || previous.terminalSeq > item.terminalSeq))
      addIssue(issues, "non_chronological_lowering", "Runtime context items are not in canonical chronological order")
    const identity = itemIdentity(item)
    if (items.has(identity))
      addIssue(issues, "invalid_runtime_evidence", `Runtime item ${identity} appears more than once`)
    items.set(identity, item)
  })
  const settlements = indexUnique(evidence.settlements, (value) => value.executionGroup, "settlement", issues)
  const authorities = indexUnique(
    evidence.authorities,
    (value) => selectorIdentity(value.selector),
    "authority",
    issues,
  )
  const toolResults = indexUnique(
    evidence.toolResults,
    (value) => selectorIdentity(value.selector),
    "tool result",
    issues,
  )
  const boundaryItems = evidence.items.filter(
    (item) => item.messageID === evidence.coveredThrough.messageID && item.terminalSeq <= evidence.coveredThrough.seq,
  )
  if (boundaryItems.length === 0)
    addIssue(
      issues,
      "covered_boundary_changed",
      "The covered complete-message boundary is absent from runtime evidence",
    )
  return {
    items,
    settlements,
    authorities,
    toolResults,
    boundaryPosition: boundaryItems.length === 0 ? undefined : Math.max(...boundaryItems.map((item) => item.position)),
  }
}

function indexUnique<Value>(
  values: ReadonlyArray<Value>,
  key: (value: Value) => string,
  label: string,
  issues: ValidationIssue[],
): ReadonlyMap<string, Value> {
  return values.reduce((result, value) => {
    const identity = key(value)
    if (result.has(identity))
      addIssue(issues, "invalid_runtime_evidence", `Runtime ${label} ${identity} appears more than once`)
    result.set(identity, value)
    return result
  }, new Map<string, Value>())
}

function validateReason(
  exclusion: Exclusion,
  target: ContextItem,
  input: ValidationInput,
  indexed: IndexedEvidence,
  targetIdentities: ReadonlySet<string>,
  issues: ValidationIssue[],
) {
  if (exclusion.reason === "terminal_intermediate") {
    validateTerminalIntermediate(exclusion, target, indexed, issues)
    return
  }

  const retained = resolveSelector(exclusion.evidence, indexed, issues)
  if (!retained) return
  validateItemBoundary(retained, indexed.boundaryPosition, input.evidence.coveredThrough, "evidence", issues)
  validatePartSettlement(retained, indexed, issues)
  if (retained.position <= target.position) {
    const code = exclusion.reason === "exact_duplicate" ? "invalid_exact_duplicate" : predicateCode(exclusion.reason)
    addIssue(issues, code, `${exclusion.reason} evidence must be chronologically later than its target`)
  }
  if (targetIdentities.has(selectorIdentity(exclusion.evidence)))
    addIssue(issues, "evidence_excluded", "Predicate evidence must remain in the active context")

  if (exclusion.reason === "exact_duplicate") {
    if (
      target.inputKind !== retained.inputKind ||
      payloadDigest(target.payload) !== payloadDigest(retained.payload) ||
      itemIdentity(target) === itemIdentity(retained)
    )
      addIssue(
        issues,
        "invalid_exact_duplicate",
        "Exact-duplicate evidence must be a later retained item with the same lowerer kind and payload digest",
      )
    return
  }
  if (exclusion.reason === "superseded_authority") {
    validateSupersededAuthority(exclusion, target, retained, input.evidence, indexed, issues)
    return
  }
  validateStaleToolResult(exclusion, target, retained, input.evidence, indexed, issues)
}

function validateSupersededAuthority(
  exclusion: SupersededAuthority,
  target: ContextItem,
  retained: ContextItem,
  evidence: RuntimeEvidence,
  indexed: IndexedEvidence,
  issues: ValidationIssue[],
) {
  const targetFact = indexed.authorities.get(itemIdentity(target))
  const retainedFact = indexed.authorities.get(itemIdentity(retained))
  const declared = authorityDeclared(exclusion.authorityKind, targetFact?.tool, evidence.resourceAuthorities)
  if (
    !targetFact ||
    !retainedFact ||
    !declared ||
    targetFact.authorityKind !== exclusion.authorityKind ||
    retainedFact.authorityKind !== exclusion.authorityKind ||
    targetFact.authorityKey !== exclusion.authorityKey ||
    retainedFact.authorityKey !== exclusion.authorityKey ||
    targetFact.revision !== exclusion.targetRevision ||
    retainedFact.revision !== exclusion.evidenceRevision ||
    exclusion.evidenceRevision <= exclusion.targetRevision ||
    targetFact.tool !== retainedFact.tool
  )
    addIssue(
      issues,
      "invalid_superseded_authority",
      "Authority evidence must match the declared kind/key and have a strictly greater durable revision",
    )
}

function authorityDeclared(
  authorityKind: string,
  tool: string | undefined,
  declarations: ReadonlyArray<ToolResourceAuthority>,
) {
  if (!tool) return builtInAuthorityKinds.has(authorityKind)
  return declarations.some((entry) => entry.tool === tool && entry.authorityKind === authorityKind)
}

function validateTerminalIntermediate(
  exclusion: TerminalIntermediate,
  target: ContextItem,
  indexed: IndexedEvidence,
  issues: ValidationIssue[],
) {
  if (target.kind !== "part" || !target.intermediateKind) {
    addIssue(issues, "invalid_terminal_intermediate", "Terminal-intermediate targets must be allowlisted parts")
    return
  }
  const settlement = indexed.settlements.get(target.executionGroup)
  if (!settlement || settlement.status !== "terminal" || settlement.terminalEventID !== exclusion.terminalEventID) {
    addIssue(
      issues,
      "invalid_terminal_intermediate",
      "Terminal-intermediate evidence must be the exact terminal event for the target execution group",
    )
    return
  }
  if (
    target.intermediateKind === "failed_partial_provider_output" &&
    (settlement.outcome !== "failed" || settlement.successfulToolEffect || settlement.fileChange)
  )
    addIssue(
      issues,
      "invalid_terminal_intermediate",
      "Failed partial provider output is protected after a successful tool effect or file change",
    )
}

function validateStaleToolResult(
  exclusion: StaleToolResult,
  target: ContextItem,
  retained: ContextItem,
  evidence: RuntimeEvidence,
  indexed: IndexedEvidence,
  issues: ValidationIssue[],
) {
  if (!evidence.resourceAuthorities.some((entry) => entry.tool === exclusion.tool))
    addIssue(
      issues,
      "undeclared_tool_authority",
      `Tool ${exclusion.tool} does not declare a versioned resource authority`,
    )
  const targetFact = indexed.toolResults.get(itemIdentity(target))
  const retainedFact = indexed.toolResults.get(itemIdentity(retained))
  if (
    !targetFact ||
    !retainedFact ||
    targetFact.status !== "succeeded" ||
    retainedFact.status !== "succeeded" ||
    targetFact.tool !== exclusion.tool ||
    retainedFact.tool !== exclusion.tool ||
    targetFact.resourceKey !== exclusion.resourceKey ||
    retainedFact.resourceKey !== exclusion.resourceKey ||
    targetFact.revision !== exclusion.targetRevision ||
    retainedFact.revision !== exclusion.evidenceRevision ||
    exclusion.evidenceRevision <= exclusion.targetRevision
  )
    addIssue(
      issues,
      "invalid_stale_tool_result",
      "Stale tool-result evidence must be successful, resource-identical, and strictly newer",
    )
}

function validateEvidenceRetention(
  exclusions: ReadonlyArray<Exclusion>,
  targets: ReadonlySet<string>,
  indexed: IndexedEvidence,
  issues: ValidationIssue[],
) {
  exclusions.forEach((exclusion) => {
    if (exclusion.reason === "terminal_intermediate") return
    const identity = selectorIdentity(exclusion.evidence)
    if (targets.has(identity)) addIssue(issues, "evidence_excluded", `Evidence ${identity} is also excluded`)
    const item = indexed.items.get(identity)
    if (item && canonicalJSON(selector(item)) !== canonicalJSON(exclusion.evidence))
      addIssue(issues, "selector_mismatch", `Evidence selector ${identity} does not match canonical runtime content`)
  })
}

function validateDependencyClosure(
  items: ReadonlyArray<ContextItem>,
  targets: ReadonlySet<string>,
  issues: ValidationIssue[],
) {
  const groups = groupBy(
    items.filter((item) => item.dependencyGroup),
    (item) => item.dependencyGroup!,
  )
  groups.forEach((members, group) => {
    const excluded = members.filter((item) => targets.has(itemIdentity(item))).length
    if (excluded > 0 && excluded !== members.length)
      addIssue(issues, "dependency_closure", `Dependency group ${group} is only partially excluded`)
  })

  const toolCalls = groupBy(
    items.filter((item) => item.toolCall),
    (item) => item.toolCall!.callID,
  )
  toolCalls.forEach((members, callID) => {
    const excluded = members.filter((item) => targets.has(itemIdentity(item))).length
    const roles = new Set(members.map((item) => item.toolCall!.role))
    if (excluded > 0 && (excluded !== members.length || !roles.has("call") || !roles.has("result")))
      addIssue(issues, "dependency_closure", `Tool call ${callID} does not retain call/result closure`)
  })
}

function groupBy<Value>(values: ReadonlyArray<Value>, key: (value: Value) => string): ReadonlyMap<string, Value[]> {
  return values.reduce((result, value) => {
    const group = key(value)
    result.set(group, [...(result.get(group) ?? []), value])
    return result
  }, new Map<string, Value[]>())
}

function resolveSelector(
  target: TargetSelector,
  indexed: IndexedEvidence,
  issues: ValidationIssue[],
): ContextItem | undefined {
  const identity = selectorIdentity(target)
  const item = indexed.items.get(identity)
  if (!item || canonicalJSON(selector(item)) !== canonicalJSON(target)) {
    addIssue(issues, "selector_mismatch", `Selector ${identity} does not match canonical runtime content`)
    return item
  }
  return item
}

function validatePartSettlement(item: ContextItem, indexed: IndexedEvidence, issues: ValidationIssue[]) {
  if (item.kind !== "part") return
  if (indexed.settlements.get(item.executionGroup)?.status !== "terminal")
    addIssue(issues, "part_unsettled", `Part ${itemIdentity(item)} belongs to a nonterminal Step`)
}

function validateItemBoundary(
  item: ContextItem,
  boundaryPosition: number | undefined,
  boundary: CoveredThrough,
  kind: "target" | "evidence",
  issues: ValidationIssue[],
) {
  if (item.terminalSeq <= boundary.seq && (boundaryPosition === undefined || item.position <= boundaryPosition)) return
  addIssue(
    issues,
    kind === "target" ? "target_after_boundary" : "evidence_after_boundary",
    `${kind} ${itemIdentity(item)} falls after the covered complete-message boundary`,
  )
}

function validTokens(item: ContextItem, issues: ValidationIssue[]) {
  if (Number.isInteger(item.tokens) && item.tokens >= 0) return item.tokens
  addIssue(issues, "invalid_runtime_evidence", `Token count for ${itemIdentity(item)} is not a non-negative integer`)
  return 0
}

function validatedLocalExclusion(exclusion: Exclusion, item: ContextItem): ValidatedLocalExclusion {
  const base = copyExclusion(exclusion)
  return {
    ...base,
    targetKey: targetKey(exclusion.target),
    ...(item.dependencyGroup === undefined ? {} : { dependencyGroup: item.dependencyGroup }),
  }
}

function copyExclusion(exclusion: Exclusion): Exclusion {
  if (exclusion.reason === "exact_duplicate")
    return {
      reason: exclusion.reason,
      target: copySelector(exclusion.target),
      evidence: copySelector(exclusion.evidence),
    }
  if (exclusion.reason === "superseded_authority")
    return {
      reason: exclusion.reason,
      target: copySelector(exclusion.target),
      authorityKind: exclusion.authorityKind,
      authorityKey: exclusion.authorityKey,
      targetRevision: exclusion.targetRevision,
      evidence: copySelector(exclusion.evidence),
      evidenceRevision: exclusion.evidenceRevision,
    }
  if (exclusion.reason === "terminal_intermediate")
    return {
      reason: exclusion.reason,
      target: copySelector(exclusion.target),
      terminalEventID: exclusion.terminalEventID,
    }
  return {
    reason: exclusion.reason,
    target: copySelector(exclusion.target),
    tool: exclusion.tool,
    resourceKey: exclusion.resourceKey,
    targetRevision: exclusion.targetRevision,
    evidence: copySelector(exclusion.evidence),
    evidenceRevision: exclusion.evidenceRevision,
  }
}

function deriveProviderRebase(
  links: ReadonlyArray<ProviderLinkEvidence>,
  boundary: CoveredThrough,
): ReadonlyArray<ProviderRebaseExclusion> {
  const seen = new Set<string>()
  return links
    .filter((link) => link.terminalSeq <= boundary.seq)
    .toSorted(
      (left, right) =>
        left.terminalSeq - right.terminalSeq ||
        compareStrings(left.messageID, right.messageID) ||
        left.ordinal - right.ordinal ||
        compareStrings(left.partKind, right.partKind) ||
        compareStrings(left.digest, right.digest),
    )
    .flatMap((link) => {
      const target: ProviderStateSelector = {
        kind: "provider_state",
        messageID: link.messageID,
        ordinal: NonNegativeInt.make(link.ordinal),
        partKind: link.partKind,
        digest: Digest.make(link.digest),
      }
      const key = targetKey(target)
      if (seen.has(key)) return []
      seen.add(key)
      return [{ reason: "provider_rebase" as const, target, targetKey: key }]
    })
}

function normalizeProtectedState(
  values: ReadonlyArray<ProtectedStateEntry>,
  issues: ValidationIssue[],
): ReadonlyArray<ProtectedStateEntry> {
  const seen = new Set<ProtectedStateSource>()
  values.forEach((value) => {
    if (seen.has(value.source))
      addIssue(issues, "invalid_runtime_evidence", `Protected-state source ${value.source} appears more than once`)
    seen.add(value.source)
  })
  return values.toSorted((left, right) => compareStrings(left.source, right.source)).map(copyProtectedState)
}

function copyProtectedState(value: ProtectedStateEntry): ProtectedStateEntry {
  return { source: value.source, revision: value.revision, digest: value.digest }
}

function copyBoundary(value: CoveredThrough): CoveredThrough {
  return { messageID: value.messageID, seq: value.seq }
}

function copyRollingSummary(value: RollingSummary): RollingSummary {
  return {
    text: value.text,
    coveredThrough: copyBoundary(value.coveredThrough),
    digest: value.digest,
  }
}

function copySelector(value: TargetSelector): TargetSelector {
  if (value.kind === "message") return { kind: value.kind, messageID: value.messageID, digest: value.digest }
  return {
    kind: value.kind,
    messageID: value.messageID,
    ordinal: value.ordinal,
    partKind: value.partKind,
    digest: value.digest,
  }
}

function sameBoundary(left: CoveredThrough, right: CoveredThrough) {
  return left.messageID === right.messageID && left.seq === right.seq
}

function selectorIdentity(value: TargetSelector): string {
  if (value.kind === "message") return `message\0${value.messageID}`
  return `part\0${value.messageID}\0${value.ordinal}\0${value.partKind}`
}

function itemIdentity(item: ContextItem): string {
  if (item.kind === "message") return `message\0${item.messageID}`
  return `part\0${item.messageID}\0${item.ordinal}\0${item.partKind}`
}

function predicateCode(reason: Exclusion["reason"]): ValidationIssueCode {
  if (reason === "superseded_authority") return "invalid_superseded_authority"
  if (reason === "stale_tool_result") return "invalid_stale_tool_result"
  if (reason === "terminal_intermediate") return "invalid_terminal_intermediate"
  return "invalid_exact_duplicate"
}

function addIssue(issues: ValidationIssue[], code: ValidationIssueCode, message: string) {
  issues.push({ code, message })
}

function deduplicateIssues(issues: ReadonlyArray<ValidationIssue>) {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.code}\0${issue.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export type PackCandidate = {
  readonly dependencyGroup: string
  readonly order: number
  readonly tokens: number
  readonly content: Schema.Json
}

export type PackInput = {
  readonly candidates: ReadonlyArray<PackCandidate>
  readonly maxInputTokens: number
  readonly fixedInputTokens: number
}

export type PackedBatch = {
  readonly candidates: ReadonlyArray<PackCandidate>
  readonly inputTokens: number
}

export function packCandidates(input: PackInput): ReadonlyArray<PackedBatch> {
  if (!Number.isInteger(input.maxInputTokens) || input.maxInputTokens <= 0)
    throw new RangeError("maxInputTokens must be a positive integer")
  if (
    !Number.isInteger(input.fixedInputTokens) ||
    input.fixedInputTokens < 0 ||
    input.fixedInputTokens > input.maxInputTokens
  )
    throw new RangeError("fixedInputTokens must fit the selected model budget")
  input.candidates.forEach((candidate) => {
    if (!candidate.dependencyGroup) throw new TypeError("Every pack candidate must name a dependency group")
    if (!Number.isInteger(candidate.order) || candidate.order < 0)
      throw new RangeError("Pack candidate order must be a non-negative integer")
    if (!Number.isInteger(candidate.tokens) || candidate.tokens < 0)
      throw new RangeError("Pack candidate tokens must be a non-negative integer")
  })

  const groups = [...groupBy(input.candidates, (candidate) => candidate.dependencyGroup).entries()]
    .map(([dependencyGroup, candidates]) => ({
      dependencyGroup,
      candidates: candidates.toSorted(
        (left, right) =>
          left.order - right.order || compareStrings(canonicalJSON(left.content), canonicalJSON(right.content)),
      ),
      order: Math.min(...candidates.map((candidate) => candidate.order)),
      tokens: candidates.reduce((sum, candidate) => sum + candidate.tokens, 0),
    }))
    .toSorted((left, right) => left.order - right.order || compareStrings(left.dependencyGroup, right.dependencyGroup))

  groups.forEach((group) => {
    if (input.fixedInputTokens + group.tokens > input.maxInputTokens)
      throw new RangeError(`dependency group ${group.dependencyGroup} exceeds the selected model budget`)
  })

  const batches: PackedBatch[] = []
  groups.forEach((group) => {
    const current = batches.at(-1)
    if (!current || current.inputTokens + group.tokens > input.maxInputTokens) {
      batches.push({
        candidates: group.candidates.map(copyPackCandidate),
        inputTokens: input.fixedInputTokens + group.tokens,
      })
      return
    }
    batches[batches.length - 1] = {
      candidates: [...current.candidates, ...group.candidates.map(copyPackCandidate)],
      inputTokens: current.inputTokens + group.tokens,
    }
  })
  return deepFreeze(batches)
}

function copyPackCandidate(candidate: PackCandidate): PackCandidate {
  return {
    dependencyGroup: candidate.dependencyGroup,
    order: candidate.order,
    tokens: candidate.tokens,
    content: cloneJson(candidate.content),
  }
}

function cloneJson(value: Schema.Json): Schema.Json {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(cloneJson)
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]))
}

export function manifestJSON(manifest: Manifest): string {
  return canonicalJSON(manifest)
}

export function manifestDigest(manifest: Manifest): string {
  return createHash("sha256").update(manifestJSON(manifest)).digest("hex")
}

export function canonicalJSON(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  if (!isPlainRecord(value)) throw new TypeError("Canonical JSON supports only JSON objects and arrays")
  return `{${Object.keys(value)
    .toSorted(compareStrings)
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
    .join(",")}}`
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compareStrings(left: string, right: string) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.values(value as Record<string, unknown>).forEach(deepFreeze)
  return Object.freeze(value)
}
