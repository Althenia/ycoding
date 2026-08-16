import { createHash } from "crypto"
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, LayerMap, Schema } from "effect"
import { Event, SessionMessage } from "@ycoding-ai/schema"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { EventSequenceTable, EventTable } from "../src/event/sql"
import { LocationServiceMap } from "../src/location-service-map"
import type { LocationServices } from "../src/location-services"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionCompactionJob } from "../src/session/compaction-job"
import { SessionHistory } from "../src/session/history"
import { SessionSchema } from "../src/session/schema"
import { SessionSummaryToon } from "../src/session/summary-toon"
import {
  InstructionStateTable,
  SessionCompactionJobTable,
  SessionContextExclusionTable,
  SessionContextRevisionTable,
  SessionContextStateTable,
  SessionMessageTable,
  SessionProviderContinuationGenerationTable,
  SessionProviderContinuationTable,
  SessionProviderStateBlobTable,
  SessionProviderStateLinkTable,
  SessionTable,
} from "../src/session/sql"
import { ContextManifest } from "../src/session/context-manifest"
import { SessionGuardrail } from "../src/session/guardrail"
import { SessionLiveState } from "../src/session/live-state"
import { asc, eq } from "drizzle-orm"

/** Task 5 owns this service; dynamic loading keeps Stage A executable until its implementation lands. */
const contextStateModule = () => import("../src/session/context-state")
const decodeJSON = Schema.decodeUnknownSync(Schema.Json)
const guardrailSnapshots = new Map<SessionSchema.ID, SessionGuardrail.Snapshot>()
const guardrailBeforeUse = new Map<SessionSchema.ID, Effect.Effect<void>>()
const guardrails = Layer.mock(SessionGuardrail.Service, {
  withSnapshot: (sessionID, use) =>
    (guardrailBeforeUse.get(sessionID) ?? Effect.void).pipe(
      Effect.andThen(
        use(guardrailSnapshots.get(sessionID) ?? { sequence: 0, digest: ContextManifest.payloadDigest(null) }),
      ),
    ),
})
const contextLocations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () =>
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      guardrails as unknown as Layer.Layer<LocationServices>,
  ),
)

const IDs = {
  old: SessionMessage.ID.make("msg_old"),
  kept: SessionMessage.ID.make("msg_kept"),
  newer: SessionMessage.ID.make("msg_newer"),
  boundary: SessionMessage.ID.make("msg_boundary"),
  call: SessionMessage.ID.make("msg_call"),
  result: SessionMessage.ID.make("msg_result"),
  laterCall: SessionMessage.ID.make("msg_later_call"),
} as const

const protectedState = [
  {
    source: "todos",
    revision: 3,
    digest: ContextManifest.payloadDigest({ todos: [{ id: "one", status: "pending" }] }),
  },
  {
    source: "instructions",
    revision: 8,
    digest: ContextManifest.payloadDigest({ project: "instructions-v8" }),
  },
] as const

function message(input: {
  readonly messageID: SessionMessage.ID
  readonly position: number
  readonly terminalSeq: number
  readonly payload: Schema.Json
  readonly tokens: number
  readonly inputKind?: string
  readonly dependencyGroup?: string
  readonly toolCall?: ContextManifest.ToolProtocolEvidence
}): ContextManifest.ContextItem {
  return {
    kind: "message",
    messageID: input.messageID,
    position: input.position,
    terminalSeq: Event.Seq.make(input.terminalSeq),
    payload: input.payload,
    tokens: input.tokens,
    inputKind: input.inputKind ?? "message",
    ...(input.dependencyGroup === undefined ? {} : { dependencyGroup: input.dependencyGroup }),
    ...(input.toolCall === undefined ? {} : { toolCall: input.toolCall }),
  }
}

function part(input: {
  readonly messageID: SessionMessage.ID
  readonly ordinal: number
  readonly partKind: string
  readonly executionGroup: string
  readonly position: number
  readonly terminalSeq: number
  readonly payload: Schema.Json
  readonly tokens: number
  readonly inputKind?: string
  readonly dependencyGroup?: string
  readonly intermediateKind?: ContextManifest.IntermediateKind
  readonly toolCall?: ContextManifest.ToolProtocolEvidence
}): ContextManifest.ContextItem {
  return {
    kind: "part",
    messageID: input.messageID,
    ordinal: input.ordinal,
    partKind: input.partKind,
    executionGroup: input.executionGroup,
    position: input.position,
    terminalSeq: Event.Seq.make(input.terminalSeq),
    payload: input.payload,
    tokens: input.tokens,
    inputKind: input.inputKind ?? input.partKind,
    ...(input.dependencyGroup === undefined ? {} : { dependencyGroup: input.dependencyGroup }),
    ...(input.intermediateKind === undefined ? {} : { intermediateKind: input.intermediateKind }),
    ...(input.toolCall === undefined ? {} : { toolCall: input.toolCall }),
  }
}

function terminal(
  executionGroup: string,
  eventID: string,
  outcome: "succeeded" | "failed" = "succeeded",
): ContextManifest.SettlementEvidence {
  return {
    executionGroup,
    status: "terminal",
    terminalEventID: Event.ID.make(eventID),
    outcome,
    successfulToolEffect: false,
    fileChange: false,
  }
}

function duplicateItems(): ReadonlyArray<ContextManifest.ContextItem> {
  const duplicatePayload = { role: "system", text: "stable fact" } as const
  return [
    message({
      messageID: IDs.old,
      position: 0,
      terminalSeq: 1,
      payload: duplicatePayload,
      tokens: 6,
      inputKind: "system",
    }),
    message({
      messageID: IDs.kept,
      position: 1,
      terminalSeq: 2,
      payload: { role: "user", text: "keep me" },
      tokens: 8,
      inputKind: "user",
    }),
    message({
      messageID: IDs.newer,
      position: 2,
      terminalSeq: 3,
      payload: duplicatePayload,
      tokens: 6,
      inputKind: "system",
    }),
  ]
}

function candidateValue(
  exclusions: ReadonlyArray<unknown>,
  coveredThrough: ContextManifest.CoveredThrough = {
    messageID: IDs.newer,
    seq: Event.Seq.make(3),
  },
) {
  return {
    schemaVersion: 1,
    baseContextRevision: 2,
    coveredThrough,
    protectedState,
    exclusions,
  }
}

function decodeCandidate(
  exclusions: ReadonlyArray<unknown>,
  coveredThrough?: ContextManifest.CoveredThrough,
): ContextManifest.Candidate {
  return ContextManifest.decodeCandidate(JSON.stringify(candidateValue(exclusions, coveredThrough)))
}

function evidence(input: {
  readonly items: ReadonlyArray<ContextManifest.ContextItem>
  readonly coveredThrough?: ContextManifest.CoveredThrough
  readonly settlements?: ReadonlyArray<ContextManifest.SettlementEvidence>
  readonly authorities?: ReadonlyArray<ContextManifest.AuthorityEvidence>
  readonly resourceAuthorities?: ReadonlyArray<ContextManifest.ToolResourceAuthority>
  readonly toolResults?: ReadonlyArray<ContextManifest.ToolResultEvidence>
  readonly protectedTargets?: ReadonlyArray<ContextManifest.TargetSelector>
  readonly providerLinks?: ReadonlyArray<ContextManifest.ProviderLinkEvidence>
  readonly currentProtectedState?: ReadonlyArray<ContextManifest.ProtectedStateEntry>
}): ContextManifest.RuntimeEvidence {
  return {
    baseContextRevision: 2,
    coveredThrough: input.coveredThrough ?? { messageID: IDs.newer, seq: Event.Seq.make(3) },
    items: input.items,
    settlements: input.settlements ?? [],
    authorities: input.authorities ?? [],
    resourceAuthorities: input.resourceAuthorities ?? [],
    toolResults: input.toolResults ?? [],
    protectedTargets: input.protectedTargets ?? [],
    providerLinks: input.providerLinks ?? [],
    protectedState: input.currentProtectedState ?? protectedState,
  }
}

function duplicateFixture() {
  const items = duplicateItems()
  const target = ContextManifest.selector(items[0]!)
  const retained = ContextManifest.selector(items[2]!)
  return {
    items,
    target,
    retained,
    candidate: decodeCandidate([{ reason: "exact_duplicate", target, evidence: retained }]),
    evidence: evidence({ items }),
  }
}

function issueCodes(result: ContextManifest.ValidationResult) {
  if (result.valid) throw new Error("Expected manifest validation to fail")
  return result.issues.map((issue) => issue.code)
}

function deepFreeze<Input>(input: Input): Input {
  if (input === null || typeof input !== "object" || Object.isFrozen(input)) return input
  Object.values(input as Record<string, unknown>).forEach(deepFreeze)
  return Object.freeze(input)
}

function expectDeeplyFrozen(input: unknown): void {
  if (input === null || typeof input !== "object") return
  expect(Object.isFrozen(input)).toBe(true)
  Object.values(input as Record<string, unknown>).forEach(expectDeeplyFrozen)
}

describe("ContextManifest candidate decoding", () => {
  test("rejects unknown reasons and fields through the strict JSON candidate schema", () => {
    const fixture = duplicateFixture()

    expect(() =>
      ContextManifest.decodeCandidate(
        JSON.stringify(candidateValue([{ reason: "semantic_summary", target: fixture.target }])),
      ),
    ).toThrow()
    expect(() => ContextManifest.decodeCandidate(JSON.stringify({ ...candidateValue([]), unexpected: true }))).toThrow()
    expect(() =>
      ContextManifest.decodeCandidate(
        JSON.stringify(
          candidateValue([
            {
              reason: "exact_duplicate",
              target: { ...fixture.target, unexpected: true },
              evidence: fixture.retained,
            },
          ]),
        ),
      ),
    ).toThrow()
    expect(() => ContextManifest.decodeCandidate("not-json")).toThrow()
  })
})

describe("ContextManifest selector identity and canonical manifests", () => {
  test("uses canonical selector SHA-256 keys and returns stable immutable output without mutating inputs", () => {
    const fixture = duplicateFixture()
    const frozenCandidate = deepFreeze(fixture.candidate)
    const frozenEvidence = deepFreeze(fixture.evidence)
    const beforeCandidate = JSON.stringify(frozenCandidate)
    const beforeEvidence = JSON.stringify(frozenEvidence)
    const result = ContextManifest.validate({ candidate: frozenCandidate, evidence: frozenEvidence })

    expect(result.valid).toBe(true)
    if (!result.valid) return

    const expectedSelectorJSON = `{"digest":"${fixture.target.digest}","kind":"message","messageID":"msg_old"}`
    expect(ContextManifest.targetKey(fixture.target)).toBe(
      createHash("sha256").update(expectedSelectorJSON).digest("hex"),
    )
    expect(result.manifest.inputTokens).toBe(20)
    expect(result.manifest.retainedTokens).toBe(14)
    expect(result.manifest.exclusions).toHaveLength(1)
    expect(result.manifest.exclusions[0]?.targetKey).toBe(ContextManifest.targetKey(fixture.target))
    expect(JSON.stringify(frozenCandidate)).toBe(beforeCandidate)
    expect(JSON.stringify(frozenEvidence)).toBe(beforeEvidence)
    expectDeeplyFrozen(result)

    const repeated = ContextManifest.validate({
      candidate: ContextManifest.decodeCandidate(
        JSON.stringify(
          candidateValue([{ evidence: fixture.retained, target: fixture.target, reason: "exact_duplicate" }]),
        ),
      ),
      evidence: fixture.evidence,
    })
    expect(repeated.valid).toBe(true)
    if (!repeated.valid) return
    expect(ContextManifest.manifestJSON(repeated.manifest)).toBe(ContextManifest.manifestJSON(result.manifest))
    expect(ContextManifest.manifestDigest(repeated.manifest)).toBe(ContextManifest.manifestDigest(result.manifest))
  })

  test("accepts a trusted summary that replaces the complete selected boundary", () => {
    const items = duplicateItems().map((item) => ({ ...item, tokens: 1_000 }))
    const boundary = items.at(-1)!
    const text = SessionSummaryToon.encode({
      version: 1,
      through_sequence: boundary.terminalSeq,
      objective: "Continue the session",
      current_state: "The selected boundary is checkpointed",
      facts: [],
      decisions: [],
      preferences: [],
      constraints: [],
      completed: [],
      pending: [],
      blockers: [],
      unresolved: [],
      important_identifiers: [],
      continuation: "Use the checkpoint for earlier history",
    })
    const runtime = evidence({ items })
    const result = ContextManifest.validate({
      candidate: decodeCandidate([]),
      summary: {
        text,
        coveredThrough: runtime.coveredThrough,
        digest: ContextManifest.selector(boundary).digest,
      },
      evidence: runtime,
    })

    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.manifest.summary?.coveredThrough).toEqual(result.manifest.coveredThrough)
    expect(result.manifest.retainedTokens).toBeLessThan(result.manifest.inputTokens)
  })

  test("accepts opaque provider compaction without a local checkpoint", () => {
    const items = duplicateItems().map((item) => ({ ...item, tokens: 1_000 }))
    const runtime = evidence({ items })
    const result = ContextManifest.validate({
      candidate: decodeCandidate([]),
      providerCompaction: {
        provider: "openai",
        modelID: "gpt-5.6",
        output: [{ type: "compaction", encrypted_content: "opaque" }],
      },
      evidence: runtime,
    })

    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.manifest.summary).toBeUndefined()
    expect(result.manifest.providerCompaction).toEqual({
      provider: "openai",
      modelID: "gpt-5.6",
      output: [{ type: "compaction", encrypted_content: "opaque" }],
    })
    expect(result.manifest.retainedTokens).toBeLessThan(result.manifest.inputTokens)
  })

  test("rejects selector kind, digest, part ordinal, and part-kind mutations", () => {
    const payload = { type: "text", text: "same" } as const
    const items = [
      part({
        messageID: IDs.old,
        ordinal: 0,
        partKind: "text",
        executionGroup: "step-old",
        position: 0,
        terminalSeq: 1,
        payload,
        tokens: 4,
      }),
      part({
        messageID: IDs.newer,
        ordinal: 0,
        partKind: "text",
        executionGroup: "step-new",
        position: 1,
        terminalSeq: 2,
        payload,
        tokens: 4,
      }),
      message({
        messageID: IDs.kept,
        position: 2,
        terminalSeq: 3,
        payload: { role: "user", text: "retained" },
        tokens: 5,
      }),
    ] as const
    const target = ContextManifest.selector(items[0])
    const retained = ContextManifest.selector(items[1])
    const runtime = evidence({
      items,
      settlements: [terminal("step-old", "evt_step_old"), terminal("step-new", "evt_step_new")],
    })
    const mutations = [
      { kind: "message", messageID: target.messageID, digest: target.digest },
      { ...target, digest: "0".repeat(64) },
      { ...target, ordinal: 9 },
      { ...target, partKind: "reasoning" },
    ] as const

    for (const mutated of mutations) {
      const result = ContextManifest.validate({
        candidate: decodeCandidate([{ reason: "exact_duplicate", target: mutated, evidence: retained }]),
        evidence: runtime,
      })
      expect(issueCodes(result)).toContain("selector_mismatch")
    }
  })

  test("accepts part selectors only after terminal Step settlement", () => {
    const payload = { type: "reasoning", text: "same" } as const
    const items = [
      part({
        messageID: IDs.old,
        ordinal: 0,
        partKind: "reasoning",
        executionGroup: "step-old",
        position: 0,
        terminalSeq: 1,
        payload,
        tokens: 3,
      }),
      part({
        messageID: IDs.newer,
        ordinal: 0,
        partKind: "reasoning",
        executionGroup: "step-new",
        position: 1,
        terminalSeq: 2,
        payload,
        tokens: 3,
      }),
      message({ messageID: IDs.kept, position: 2, terminalSeq: 3, payload: { text: "keep" }, tokens: 4 }),
    ] as const
    const result = ContextManifest.validate({
      candidate: decodeCandidate([
        {
          reason: "exact_duplicate",
          target: ContextManifest.selector(items[0]),
          evidence: ContextManifest.selector(items[1]),
        },
      ]),
      evidence: evidence({
        items,
        settlements: [{ executionGroup: "step-old", status: "running" }, terminal("step-new", "evt_step_new")],
      }),
    })

    expect(issueCodes(result)).toContain("part_unsettled")
  })
})

describe("ContextManifest closed exclusion predicates", () => {
  test("rejects duplicate evidence with a different input kind, earlier position, or excluded evidence", () => {
    const fixture = duplicateFixture()
    const differentKind = fixture.items.map((item, index) => (index === 2 ? { ...item, inputKind: "assistant" } : item))
    expect(
      issueCodes(
        ContextManifest.validate({
          candidate: fixture.candidate,
          evidence: evidence({ items: differentKind }),
        }),
      ),
    ).toContain("invalid_exact_duplicate")

    const earlierEvidence = decodeCandidate([
      { reason: "exact_duplicate", target: fixture.retained, evidence: fixture.target },
    ])
    expect(issueCodes(ContextManifest.validate({ candidate: earlierEvidence, evidence: fixture.evidence }))).toContain(
      "invalid_exact_duplicate",
    )

    const excludedEvidence = decodeCandidate([
      { reason: "exact_duplicate", target: fixture.target, evidence: fixture.retained },
      { reason: "exact_duplicate", target: fixture.retained, evidence: fixture.target },
    ])
    expect(issueCodes(ContextManifest.validate({ candidate: excludedEvidence, evidence: fixture.evidence }))).toContain(
      "evidence_excluded",
    )
  })

  test("validates exact authority kind, key, and strictly increasing durable revisions", () => {
    const items = duplicateItems()
    const target = ContextManifest.selector(items[0]!)
    const retained = ContextManifest.selector(items[2]!)
    const runtime = evidence({
      items,
      authorities: [
        { selector: target, authorityKind: "todos", authorityKey: "session-todos", revision: 4 },
        { selector: retained, authorityKind: "todos", authorityKey: "session-todos", revision: 5 },
      ],
    })
    const valid = ContextManifest.validate({
      candidate: decodeCandidate([
        {
          reason: "superseded_authority",
          target,
          authorityKind: "todos",
          authorityKey: "session-todos",
          targetRevision: 4,
          evidence: retained,
          evidenceRevision: 5,
        },
      ]),
      evidence: runtime,
    })
    expect(valid.valid).toBe(true)

    for (const mismatch of [
      { authorityKey: "other", targetRevision: 4, evidenceRevision: 5 },
      { authorityKey: "session-todos", targetRevision: 3, evidenceRevision: 5 },
      { authorityKey: "session-todos", targetRevision: 4, evidenceRevision: 4 },
    ]) {
      const result = ContextManifest.validate({
        candidate: decodeCandidate([
          {
            reason: "superseded_authority",
            target,
            authorityKind: "todos",
            authorityKey: mismatch.authorityKey,
            targetRevision: mismatch.targetRevision,
            evidence: retained,
            evidenceRevision: mismatch.evidenceRevision,
          },
        ]),
        evidence: runtime,
      })
      expect(issueCodes(result)).toContain("invalid_superseded_authority")
    }
  })

  test("requires the exact terminal event for allowlisted intermediate execution groups", () => {
    const targetItem = part({
      messageID: IDs.old,
      ordinal: 0,
      partKind: "tool",
      executionGroup: "step-old",
      intermediateKind: "tool_progress",
      position: 0,
      terminalSeq: 1,
      payload: { status: "running", output: "partial" },
      tokens: 4,
    })
    const kept = message({
      messageID: IDs.kept,
      position: 1,
      terminalSeq: 2,
      payload: { role: "user", text: "keep" },
      tokens: 5,
    })
    const target = ContextManifest.selector(targetItem)
    const terminalEventID = Event.ID.make("evt_terminal_step")
    const manifestCandidate = decodeCandidate([{ reason: "terminal_intermediate", target, terminalEventID }], {
      messageID: IDs.kept,
      seq: Event.Seq.make(2),
    })

    const valid = ContextManifest.validate({
      candidate: manifestCandidate,
      evidence: evidence({
        items: [targetItem, kept],
        coveredThrough: { messageID: IDs.kept, seq: Event.Seq.make(2) },
        settlements: [terminal("step-old", terminalEventID)],
      }),
    })
    expect(valid.valid).toBe(true)

    const running = ContextManifest.validate({
      candidate: manifestCandidate,
      evidence: evidence({
        items: [targetItem, kept],
        coveredThrough: { messageID: IDs.kept, seq: Event.Seq.make(2) },
        settlements: [{ executionGroup: "step-old", status: "running" }],
      }),
    })
    expect(issueCodes(running)).toContain("invalid_terminal_intermediate")

    const wrongTerminal = ContextManifest.validate({
      candidate: manifestCandidate,
      evidence: evidence({
        items: [targetItem, kept],
        coveredThrough: { messageID: IDs.kept, seq: Event.Seq.make(2) },
        settlements: [terminal("step-old", "evt_different_terminal")],
      }),
    })
    expect(issueCodes(wrongTerminal)).toContain("invalid_terminal_intermediate")
  })

  test("does not omit failed partial output after a successful tool effect or file change", () => {
    const targetItem = part({
      messageID: IDs.old,
      ordinal: 0,
      partKind: "reasoning",
      executionGroup: "failed-step",
      intermediateKind: "failed_partial_provider_output",
      position: 0,
      terminalSeq: 1,
      payload: { text: "partial" },
      tokens: 2,
    })
    const kept = message({ messageID: IDs.kept, position: 1, terminalSeq: 2, payload: { text: "keep" }, tokens: 4 })
    const terminalEventID = Event.ID.make("evt_failed_step")
    const result = ContextManifest.validate({
      candidate: decodeCandidate(
        [{ reason: "terminal_intermediate", target: ContextManifest.selector(targetItem), terminalEventID }],
        { messageID: IDs.kept, seq: Event.Seq.make(2) },
      ),
      evidence: evidence({
        items: [targetItem, kept],
        coveredThrough: { messageID: IDs.kept, seq: Event.Seq.make(2) },
        settlements: [
          {
            executionGroup: "failed-step",
            status: "terminal",
            terminalEventID,
            outcome: "failed",
            successfulToolEffect: true,
            fileChange: false,
          },
        ],
      }),
    })

    expect(issueCodes(result)).toContain("invalid_terminal_intermediate")
  })

  test("requires declared versioned resource authority and successful increasing tool-result revisions", () => {
    const oldResult = part({
      messageID: IDs.old,
      ordinal: 0,
      partKind: "tool",
      executionGroup: "tool-old",
      position: 0,
      terminalSeq: 1,
      payload: { resource: "one", revision: 1 },
      tokens: 4,
    })
    const newResult = part({
      messageID: IDs.newer,
      ordinal: 0,
      partKind: "tool",
      executionGroup: "tool-new",
      position: 1,
      terminalSeq: 2,
      payload: { resource: "one", revision: 2 },
      tokens: 4,
    })
    const kept = message({ messageID: IDs.kept, position: 2, terminalSeq: 3, payload: { text: "keep" }, tokens: 5 })
    const target = ContextManifest.selector(oldResult)
    const retained = ContextManifest.selector(newResult)
    const manifestCandidate = decodeCandidate([
      {
        reason: "stale_tool_result",
        target,
        tool: "read_resource",
        resourceKey: "resource:one",
        targetRevision: 1,
        evidence: retained,
        evidenceRevision: 2,
      },
    ])
    const runtime = evidence({
      items: [oldResult, newResult, kept],
      settlements: [terminal("tool-old", "evt_tool_old"), terminal("tool-new", "evt_tool_new")],
      resourceAuthorities: [{ tool: "read_resource", authorityKind: "resource" }],
      toolResults: [
        { selector: target, tool: "read_resource", resourceKey: "resource:one", revision: 1, status: "succeeded" },
        { selector: retained, tool: "read_resource", resourceKey: "resource:one", revision: 2, status: "succeeded" },
      ],
    })
    expect(ContextManifest.validate({ candidate: manifestCandidate, evidence: runtime }).valid).toBe(true)

    const undeclared = ContextManifest.validate({
      candidate: manifestCandidate,
      evidence: { ...runtime, resourceAuthorities: [] },
    })
    expect(issueCodes(undeclared)).toContain("undeclared_tool_authority")

    const wrongKey = ContextManifest.validate({
      candidate: decodeCandidate([
        {
          reason: "stale_tool_result",
          target,
          tool: "read_resource",
          resourceKey: "resource:two",
          targetRevision: 1,
          evidence: retained,
          evidenceRevision: 2,
        },
      ]),
      evidence: runtime,
    })
    expect(issueCodes(wrongKey)).toContain("invalid_stale_tool_result")
  })
})

describe("ContextManifest safety and lowering checks", () => {
  test("rejects broken dependency groups and tool call/result closure", () => {
    const sameCall = { call: "read", arguments: { path: "one" } } as const
    const oldCall = part({
      messageID: IDs.call,
      ordinal: 0,
      partKind: "tool_call",
      executionGroup: "step-old",
      dependencyGroup: "tool:old",
      toolCall: { callID: "call-old", role: "call" },
      position: 0,
      terminalSeq: 1,
      payload: sameCall,
      tokens: 3,
      inputKind: "tool_call",
    })
    const oldResult = part({
      messageID: IDs.result,
      ordinal: 0,
      partKind: "tool_result",
      executionGroup: "step-old",
      dependencyGroup: "tool:old",
      toolCall: { callID: "call-old", role: "result" },
      position: 1,
      terminalSeq: 2,
      payload: { result: "one" },
      tokens: 3,
    })
    const newCall = part({
      messageID: IDs.laterCall,
      ordinal: 0,
      partKind: "tool_call",
      executionGroup: "step-new",
      dependencyGroup: "tool:new",
      toolCall: { callID: "call-new", role: "call" },
      position: 2,
      terminalSeq: 3,
      payload: sameCall,
      tokens: 3,
      inputKind: "tool_call",
    })
    const newResult = part({
      messageID: IDs.newer,
      ordinal: 0,
      partKind: "tool_result",
      executionGroup: "step-new",
      dependencyGroup: "tool:new",
      toolCall: { callID: "call-new", role: "result" },
      position: 3,
      terminalSeq: 4,
      payload: { result: "one" },
      tokens: 3,
    })
    const kept = message({ messageID: IDs.kept, position: 4, terminalSeq: 5, payload: { text: "keep" }, tokens: 5 })
    const result = ContextManifest.validate({
      candidate: decodeCandidate(
        [
          {
            reason: "exact_duplicate",
            target: ContextManifest.selector(oldCall),
            evidence: ContextManifest.selector(newCall),
          },
        ],
        { messageID: IDs.kept, seq: Event.Seq.make(5) },
      ),
      evidence: evidence({
        items: [oldCall, oldResult, newCall, newResult, kept],
        coveredThrough: { messageID: IDs.kept, seq: Event.Seq.make(5) },
        settlements: [terminal("step-old", "evt_step_old"), terminal("step-new", "evt_step_new")],
      }),
    })

    expect(issueCodes(result)).toContain("dependency_closure")
  })

  test("rejects protected, post-boundary, and changed protected-state targets", () => {
    const fixture = duplicateFixture()
    expect(
      issueCodes(
        ContextManifest.validate({
          candidate: fixture.candidate,
          evidence: { ...fixture.evidence, protectedTargets: [fixture.target] },
        }),
      ),
    ).toContain("protected_target")

    const boundaryItem = message({
      messageID: IDs.boundary,
      position: 0,
      terminalSeq: 0,
      payload: { text: "boundary" },
      tokens: 2,
    })
    const shifted = fixture.items.map((item) => ({
      ...item,
      position: item.position + 1,
      terminalSeq: Event.Seq.make(item.terminalSeq + 1),
    }))
    const afterBoundary = ContextManifest.validate({
      candidate: decodeCandidate([{ reason: "exact_duplicate", target: fixture.target, evidence: fixture.retained }], {
        messageID: IDs.boundary,
        seq: Event.Seq.make(0),
      }),
      evidence: evidence({
        items: [boundaryItem, ...shifted],
        coveredThrough: { messageID: IDs.boundary, seq: Event.Seq.make(0) },
      }),
    })
    expect(issueCodes(afterBoundary)).toContain("target_after_boundary")

    const changedState = protectedState.map((entry, index) =>
      index === 0 ? { ...entry, revision: entry.revision + 1 } : entry,
    )
    const staleSnapshot = ContextManifest.validate({
      candidate: fixture.candidate,
      evidence: { ...fixture.evidence, protectedState: changedState },
    })
    expect(issueCodes(staleSnapshot)).toContain("protected_state_changed")
  })

  test("rejects non-chronological runtime lowering and candidates that reduce no tokens", () => {
    const fixture = duplicateFixture()
    const nonChronological = ContextManifest.validate({
      candidate: fixture.candidate,
      evidence: { ...fixture.evidence, items: fixture.items.toReversed() },
    })
    expect(issueCodes(nonChronological)).toContain("non_chronological_lowering")

    const zeroTokenItems = fixture.items.map((item, index) => (index === 0 ? { ...item, tokens: 0 } : item))
    const noReduction = ContextManifest.validate({
      candidate: fixture.candidate,
      evidence: evidence({ items: zeroTokenItems }),
    })
    expect(issueCodes(noReduction)).toContain("no_token_reduction")
  })

  test("derives every covered provider-only link as provider_rebase and rejects model-proposed rebases", () => {
    const fixture = duplicateFixture()
    const providerLinks = [
      {
        messageID: IDs.old,
        ordinal: 0,
        partKind: "reasoning",
        digest: ContextManifest.payloadDigest({ encrypted: "one" }),
        terminalSeq: Event.Seq.make(1),
      },
      {
        messageID: IDs.newer,
        ordinal: 1,
        partKind: "compaction",
        digest: ContextManifest.payloadDigest({ opaque: "two" }),
        terminalSeq: Event.Seq.make(3),
      },
      {
        messageID: SessionMessage.ID.make("msg_after"),
        ordinal: 0,
        partKind: "reasoning",
        digest: ContextManifest.payloadDigest({ encrypted: "after" }),
        terminalSeq: Event.Seq.make(4),
      },
    ] as const
    const result = ContextManifest.validate({
      candidate: fixture.candidate,
      evidence: { ...fixture.evidence, providerLinks },
    })
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.manifest.exclusions.map((exclusion) => exclusion.reason)).toEqual([
      "exact_duplicate",
      "provider_rebase",
      "provider_rebase",
    ])
    expect(result.manifest.exclusions.slice(1).map((exclusion) => exclusion.target.kind)).toEqual([
      "provider_state",
      "provider_state",
    ])

    expect(() =>
      ContextManifest.decodeCandidate(
        JSON.stringify(
          candidateValue([
            {
              reason: "provider_rebase",
              target: {
                kind: "provider_state",
                messageID: IDs.old,
                ordinal: 0,
                partKind: "reasoning",
                digest: providerLinks[0].digest,
              },
            },
          ]),
        ),
      ),
    ).toThrow()
  })
})

describe("ContextManifest bounded packing", () => {
  test("packs oldest-first without splitting dependency groups and does not mutate inputs", () => {
    const candidates = deepFreeze([
      { dependencyGroup: "g2", order: 3, tokens: 4, content: { id: "g2" } },
      { dependencyGroup: "g1", order: 2, tokens: 2, content: { id: "g1-b" } },
      { dependencyGroup: "g3", order: 4, tokens: 5, content: { id: "g3" } },
      { dependencyGroup: "g1", order: 1, tokens: 2, content: { id: "g1-a" } },
    ] satisfies ReadonlyArray<ContextManifest.PackCandidate>)
    const before = JSON.stringify(candidates)
    const batches = ContextManifest.packCandidates({
      candidates,
      maxInputTokens: 10,
      fixedInputTokens: 2,
    })

    expect(batches.map((batch) => batch.candidates.map((item) => item.content))).toEqual([
      [{ id: "g1-a" }, { id: "g1-b" }, { id: "g2" }],
      [{ id: "g3" }],
    ])
    expect(batches.map((batch) => batch.inputTokens)).toEqual([10, 7])
    expect(JSON.stringify(candidates)).toBe(before)
    expectDeeplyFrozen(batches)
  })

  test("rejects a dependency-closed group that cannot fit the selected model budget", () => {
    expect(() =>
      ContextManifest.packCandidates({
        candidates: [
          { dependencyGroup: "too-large", order: 0, tokens: 9, content: { id: "one" } },
          { dependencyGroup: "too-large", order: 1, tokens: 2, content: { id: "two" } },
        ],
        maxInputTokens: 10,
        fixedInputTokens: 1,
      }),
    ).toThrow("dependency group too-large exceeds the selected model budget")
  })
})

describe("ContextManifest activation integration", () => {
  test("activates only accepted selectors without rewriting canonical rows", async () => {
    const { SessionContextState } = await contextStateModule()

    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* activationFixture(SessionSchema.ID.make("ses_manifest_activation"))
        const context = yield* SessionContextState.Service
        const beforeCanonical = yield* canonicalRows(fixture.sessionID)

        yield* context.activate({ sessionID: fixture.sessionID, manifest: fixture.manifest })

        const afterCanonical = yield* canonicalRows(fixture.sessionID)
        expect(afterCanonical.messages).toEqual(beforeCanonical.messages)
        expect(afterCanonical.events.slice(0, beforeCanonical.events.length)).toEqual(beforeCanonical.events)
        expect(afterCanonical.events.slice(beforeCanonical.events.length)).toEqual([
          expect.objectContaining({
            type: "session.compaction.ended.2",
            data: expect.objectContaining({
              sessionID: fixture.sessionID,
              revision: 1,
              boundary: { messageID: fixture.retained.id, seq: 2 },
            }),
          }),
        ])
        expect(
          (yield* context.filter(fixture.sessionID, fixture.messages)).map(
            (message: SessionMessage.Info) => message.id,
          ),
        ).toEqual([fixture.retained.id, fixture.afterBoundary.id])
        expect(
          yield* fixture.db
            .select()
            .from(SessionContextRevisionTable)
            .where(eq(SessionContextRevisionTable.session_id, fixture.sessionID))
            .orderBy(asc(SessionContextRevisionTable.revision))
            .all()
            .pipe(Effect.orDie),
        ).toMatchObject([
          { revision: 0, parent_revision: null },
          { revision: 1, parent_revision: 0, covered_through_message_id: fixture.retained.id },
        ])
        expect(
          yield* fixture.db
            .select()
            .from(SessionContextExclusionTable)
            .where(eq(SessionContextExclusionTable.session_id, fixture.sessionID))
            .orderBy(asc(SessionContextExclusionTable.target_key))
            .all()
            .pipe(Effect.orDie),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              target_key: ContextManifest.targetKey(fixture.target),
              reason: "exact_duplicate",
            }),
          ]),
        )
        expect(
          yield* fixture.db
            .select({ type: EventTable.type })
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, fixture.sessionID))
            .all()
            .pipe(Effect.orDie),
        ).not.toContainEqual({ type: "session.compaction.replaced.1" })
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionContextState.node]), [
            [LocationServiceMap.node, contextLocations],
          ]),
        ),
      ),
    )
  })

  test("keeps canonical history intact and prepends an activated summary only to model history", async () => {
    const { SessionContextState } = await contextStateModule()

    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* activationFixture(SessionSchema.ID.make("ses_manifest_model_checkpoint"))
        const summaryBoundary = fixture.items[0]!
        const text = SessionSummaryToon.encode({
          version: 1,
          through_sequence: summaryBoundary.terminalSeq,
          objective: "Continue the current task",
          current_state: "Earlier canonical messages are represented by this checkpoint",
          facts: [],
          decisions: [],
          preferences: [],
          constraints: [],
          completed: [],
          pending: [],
          blockers: [],
          unresolved: [],
          important_identifiers: [],
          continuation: "Continue from the later canonical messages",
        })
        const candidate = ContextManifest.decodeCandidate(
          JSON.stringify({
            schemaVersion: 1,
            baseContextRevision: 0,
            coveredThrough: { messageID: fixture.retained.id, seq: 2 },
            protectedState: fixture.protectedState,
            exclusions: [],
          }),
        )
        const validated = ContextManifest.validate({
          candidate,
          summary: {
            text,
            coveredThrough: {
              messageID: summaryBoundary.messageID,
              seq: summaryBoundary.terminalSeq,
            },
            digest: ContextManifest.selector(summaryBoundary).digest,
          },
          evidence: {
            baseContextRevision: 0,
            coveredThrough: candidate.coveredThrough,
            items: fixture.items.map((item) => ({ ...item, tokens: 1_000 })),
            settlements: [],
            authorities: [],
            resourceAuthorities: [],
            toolResults: [],
            protectedTargets: [],
            providerLinks: [],
            protectedState: fixture.protectedState,
          },
        })
        if (!validated.valid) return yield* Effect.die(validated.issues)
        const context = yield* SessionContextState.Service
        const activation = yield* context.activate({ sessionID: fixture.sessionID, manifest: validated.manifest })
        const current = yield* context.current(fixture.sessionID)

        const canonical = yield* SessionHistory.load(fixture.db, fixture.sessionID)
        const model = yield* SessionHistory.forModel(fixture.db, fixture.sessionID)
        const repeated = yield* SessionHistory.forModel(fixture.db, fixture.sessionID)

        expect(canonical.map((message) => message.id)).toEqual(fixture.messages.map((message) => message.id))
        expect(model[0]?.type).toBe("synthetic")
        expect(model[0]?.id).toBe(SessionMessage.ID.make(`msg_compaction_${activation.manifestDigest}`))
        expect(model[0]?.time.created).toEqual(DateTime.makeUnsafe(current.timeActivated!))
        expect(model[0]?.type === "synthetic" ? model[0].text : "").toContain(text)
        expect(model.slice(1).map((message) => message.id)).toEqual([
          fixture.retained.id,
          fixture.afterBoundary.id,
        ])
        expect(repeated[0]?.id).toBe(model[0]?.id)
        expect(repeated[0]?.time.created).toEqual(model[0]?.time.created)

        const durableCount = yield* SessionHistory.durableMessageCount(fixture.db, fixture.sessionID)
        expect(durableCount).toBe(canonical.length)
        expect(durableCount).toBeGreaterThan(
          model.filter((message) => canonical.some((canonicalMessage) => canonicalMessage.id === message.id)).length,
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionContextState.node]), [
            [LocationServiceMap.node, contextLocations],
          ]),
        ),
      ),
    )
  })

  test("rejects stale base revisions and protected-state changes without partial writes", async () => {
    const { SessionContextState } = await contextStateModule()

    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* activationFixture(SessionSchema.ID.make("ses_manifest_atomic_rejection"))
        const context = yield* SessionContextState.Service
        const before = yield* activationRows(fixture.sessionID)

        yield* context
          .activate({
            sessionID: fixture.sessionID,
            manifest: { ...fixture.manifest, baseContextRevision: 1 },
          })
          .pipe(Effect.flip)
        expect(yield* activationRows(fixture.sessionID)).toEqual(before)

        yield* context
          .activate({
            sessionID: fixture.sessionID,
            manifest: {
              ...fixture.manifest,
              protectedState: fixture.manifest.protectedState.map((entry, index) =>
                index === 0 ? { ...entry, revision: entry.revision + 1 } : entry,
              ),
            },
          })
          .pipe(Effect.flip)
        expect(yield* activationRows(fixture.sessionID)).toEqual(before)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionContextState.node]), [
            [LocationServiceMap.node, contextLocations],
          ]),
        ),
      ),
    )
  })

  test("recaptures database protected state in the activation transaction", async () => {
    const { SessionContextState } = await contextStateModule()

    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* activationFixture(SessionSchema.ID.make("ses_manifest_database_race"))
        const context = yield* SessionContextState.Service
        guardrailBeforeUse.set(
          fixture.sessionID,
          fixture.db
            .update(SessionTable)
            .set({ autonomy: { mode: "normal", yolo: 2 }, autonomy_revision: 1 })
            .where(eq(SessionTable.id, fixture.sessionID))
            .run()
            .pipe(Effect.orDie, Effect.asVoid),
        )
        const before = yield* activationRows(fixture.sessionID)

        const rejected = yield* context
          .activate({ sessionID: fixture.sessionID, manifest: fixture.manifest })
          .pipe(Effect.flip)

        expect(rejected).toMatchObject({ code: "protected_state_changed" })
        expect(yield* activationRows(fixture.sessionID)).toEqual(before)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionContextState.node]), [
            [LocationServiceMap.node, contextLocations],
          ]),
        ),
      ),
    )
  })

  test("fences process-local guardrail state through the activation transaction", async () => {
    const { SessionContextState } = await contextStateModule()

    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* activationFixture(SessionSchema.ID.make("ses_manifest_guardrail_race"))
        const context = yield* SessionContextState.Service
        const guardrail = guardrailSnapshots.get(fixture.sessionID)!
        guardrailSnapshots.set(fixture.sessionID, {
          sequence: guardrail.sequence + 1,
          digest: ContextManifest.payloadDigest({ sessionID: fixture.sessionID, guardrails: "changed" }),
        })
        const before = yield* activationRows(fixture.sessionID)

        const rejected = yield* context
          .activate({ sessionID: fixture.sessionID, manifest: fixture.manifest })
          .pipe(Effect.flip)

        expect(rejected).toMatchObject({ code: "protected_state_changed" })
        expect(yield* activationRows(fixture.sessionID)).toEqual(before)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionContextState.node]), [
            [LocationServiceMap.node, contextLocations],
          ]),
        ),
      ),
    )
  })

  test("rebases covered provider links, fences continuation, and advances the instruction epoch atomically", async () => {
    const { SessionContextState } = await contextStateModule()

    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* activationFixture(SessionSchema.ID.make("ses_manifest_provider_rebase"))
        const context = yield* SessionContextState.Service
        const beforeInstruction = yield* fixture.db
          .select()
          .from(InstructionStateTable)
          .where(eq(InstructionStateTable.session_id, fixture.sessionID))
          .get()
          .pipe(Effect.orDie)

        yield* context.activate({ sessionID: fixture.sessionID, manifest: fixture.manifest })

        expect(
          yield* fixture.db
            .select({ messageID: SessionProviderStateLinkTable.message_id })
            .from(SessionProviderStateLinkTable)
            .where(eq(SessionProviderStateLinkTable.session_id, fixture.sessionID))
            .orderBy(asc(SessionProviderStateLinkTable.message_id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([{ messageID: fixture.afterBoundary.id }])
        expect(
          yield* fixture.db
            .select()
            .from(SessionProviderContinuationTable)
            .where(eq(SessionProviderContinuationTable.session_id, fixture.sessionID))
            .get()
            .pipe(Effect.orDie),
        ).toBeUndefined()
        expect(
          yield* fixture.db
            .select()
            .from(SessionProviderContinuationGenerationTable)
            .where(eq(SessionProviderContinuationGenerationTable.session_id, fixture.sessionID))
            .get()
            .pipe(Effect.orDie),
        ).toMatchObject({ generation: 1, context_revision: 1 })
        expect(
          yield* fixture.db
            .select()
            .from(InstructionStateTable)
            .where(eq(InstructionStateTable.session_id, fixture.sessionID))
            .get()
            .pipe(Effect.orDie),
        ).toMatchObject({ epoch_start: expect.any(Number), through_seq: expect.any(Number) })
        expect(
          (yield* fixture.db
            .select()
            .from(InstructionStateTable)
            .where(eq(InstructionStateTable.session_id, fixture.sessionID))
            .get()
            .pipe(Effect.orDie))?.epoch_start,
        ).toBeGreaterThan(beforeInstruction?.epoch_start ?? 0)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionContextState.node]), [
            [LocationServiceMap.node, contextLocations],
          ]),
        ),
      ),
    )
  })

  test("rejects activation after another worker reclaims the expired job lease", async () => {
    const { SessionContextState } = await contextStateModule()

    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* activationFixture(SessionSchema.ID.make("ses_manifest_lease_reclaimed"))
        const context = yield* SessionContextState.Service
        const jobs = yield* SessionCompactionJob.Service
        const admitted = yield* jobs.admit({
          id: SessionCompaction.ID.make("cmp_manifest_lease_reclaimed"),
          sessionID: fixture.sessionID,
          trigger: "manual",
          requestedThrough: fixture.manifest.coveredThrough,
          baseContextRevision: fixture.manifest.baseContextRevision,
          targetMaxInputTokens: 100,
          configDigest: "a".repeat(64),
        })
        yield* jobs.claim({ jobID: admitted.id, owner: "worker-a", now: 10, expiresAt: 20 })
        yield* jobs.claim({ jobID: admitted.id, owner: "worker-b", now: 20, expiresAt: 40 })
        const before = yield* activationRows(fixture.sessionID)

        const rejected = yield* context
          .activate({
            sessionID: fixture.sessionID,
            manifest: fixture.manifest,
            jobID: admitted.id,
            leaseOwner: "worker-a",
          })
          .pipe(Effect.flip)

        expect(rejected).toMatchObject({ code: "job_conflict" })
        expect(yield* activationRows(fixture.sessionID)).toEqual(before)
        expect(
          yield* fixture.db
            .select()
            .from(SessionCompactionJobTable)
            .where(eq(SessionCompactionJobTable.id, admitted.id))
            .get()
            .pipe(Effect.orDie),
        ).toMatchObject({ status: "running", lease_owner: "worker-b" })

        yield* context.activate({
          sessionID: fixture.sessionID,
          manifest: fixture.manifest,
          jobID: admitted.id,
          leaseOwner: "worker-b",
        })
        expect(
          yield* fixture.db
            .select()
            .from(SessionCompactionJobTable)
            .where(eq(SessionCompactionJobTable.id, admitted.id))
            .get()
            .pipe(Effect.orDie),
        ).toMatchObject({ status: "ended", lease_owner: null })
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([Database.node, EventV2.node, SessionCompactionJob.node, SessionContextState.node]),
            [[LocationServiceMap.node, contextLocations]],
          ),
        ),
      ),
    )
  })
})

const canonicalRows = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
  const db = (yield* Database.Service).db
  const messages = yield* db
    .select({
      id: SessionMessageTable.id,
      seq: SessionMessageTable.seq,
      type: SessionMessageTable.type,
      data: SessionMessageTable.data,
    })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const events = yield* db
    .select({ id: EventTable.id, seq: EventTable.seq, type: EventTable.type, data: EventTable.data })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  return {
    messages: messages.map((row) => ({ ...row, digest: ContextManifest.payloadDigest(decodeJSON(row.data)) })),
    events: events.map((row) => ({ ...row, digest: ContextManifest.payloadDigest(decodeJSON(row.data)) })),
  }
})

const activationRows = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
  const db = (yield* Database.Service).db
  const [canonical, revisions, state, exclusions, continuation, generation, links, instruction] = yield* Effect.all([
    canonicalRows(sessionID),
    db.select().from(SessionContextRevisionTable).where(eq(SessionContextRevisionTable.session_id, sessionID)).all(),
    db.select().from(SessionContextStateTable).where(eq(SessionContextStateTable.session_id, sessionID)).get(),
    db.select().from(SessionContextExclusionTable).where(eq(SessionContextExclusionTable.session_id, sessionID)).all(),
    db
      .select()
      .from(SessionProviderContinuationTable)
      .where(eq(SessionProviderContinuationTable.session_id, sessionID))
      .get(),
    db
      .select()
      .from(SessionProviderContinuationGenerationTable)
      .where(eq(SessionProviderContinuationGenerationTable.session_id, sessionID))
      .get(),
    db
      .select()
      .from(SessionProviderStateLinkTable)
      .where(eq(SessionProviderStateLinkTable.session_id, sessionID))
      .all(),
    db.select().from(InstructionStateTable).where(eq(InstructionStateTable.session_id, sessionID)).get(),
  ])
  return { canonical, revisions, state, exclusions, continuation, generation, links, instruction }
})

const activationFixture = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
  const db = (yield* Database.Service).db
  const messageValue = (id: SessionMessage.ID, sequence: number, text: string) =>
    SessionMessage.User.make({
      id,
      type: "user",
      text,
      time: { created: DateTime.makeUnsafe(sequence) },
    })
  const old = messageValue(SessionMessage.ID.make(`msg_${sessionID}_old`), 1, "duplicate context")
  const retained = messageValue(SessionMessage.ID.make(`msg_${sessionID}_retained`), 1, "duplicate context")
  const afterBoundary = messageValue(SessionMessage.ID.make(`msg_${sessionID}_after`), 3, "post-boundary context")
  const messages = [old, retained, afterBoundary]
  const encoded = messages.map((value) => Schema.encodeSync(SessionMessage.Info)(value))
  const data = encoded.map(({ id, type, ...value }) => ({ id: SessionMessage.ID.make(id), type, value }))
  const items = data.map((entry, position) => ({
    kind: "message" as const,
    messageID: entry.id,
    position,
    terminalSeq: Event.Seq.make(position + 1),
    inputKind: "user",
    payload: decodeJSON(entry.value),
    tokens: 8,
  }))
  const target = ContextManifest.selector(items[0]!)
  const evidence = ContextManifest.selector(items[1]!)

  const digest = ContextManifest.payloadDigest({ opaque: "provider-state" })
  const fingerprintDigest = ContextManifest.payloadDigest({ stable: "fingerprint" })
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Manifest activation" })
    .run()
    .pipe(Effect.orDie)
  yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 3 }).run().pipe(Effect.orDie)
  yield* db
    .insert(SessionContextRevisionTable)
    .values({ session_id: sessionID, revision: 0, time_created: 0 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionContextStateTable)
    .values({ session_id: sessionID, status: "active", revision: 0 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(InstructionStateTable)
    .values({ session_id: sessionID, epoch_start: 0, through_seq: 0, initial_values: {}, current_values: {} })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionMessageTable)
    .values(
      data.map((entry, index) => ({
        id: entry.id,
        session_id: sessionID,
        type: entry.type,
        seq: index + 1,
        time_created: index + 1,
        time_updated: index + 1,
        data: entry.value,
      })),
    )
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(EventTable)
    .values(
      data.map((entry, index) => ({
        id: Event.ID.make(`evt_${sessionID}_event_${index + 1}`),
        aggregate_id: sessionID,
        seq: index + 1,
        created: index + 1,
        type: "session.input.promoted.1",
        data: { sessionID, inputID: entry.id },
      })),
    )
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionProviderStateBlobTable)
    .values({
      digest,
      provider: "openai",
      model_id: "gpt-5.6",
      item_type: "reasoning",
      content: { opaque: "provider-state" },
      time_created: 1,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionProviderStateLinkTable)
    .values(
      [old, afterBoundary].map((message, index) => ({
        session_id: sessionID,
        message_id: message.id,
        part_ordinal: 0,
        part_kind: "reasoning",
        provider: "openai",
        model_id: "gpt-5.6",
        blob_digest: digest,
        context_revision: 0,
        time_created: index + 1,
      })),
    )
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionProviderContinuationGenerationTable)
    .values({ session_id: sessionID, generation: 0, context_revision: 0, time_updated: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionProviderContinuationTable)
    .values({
      session_id: sessionID,
      response_id: "resp_manifest_activation",
      represented_through_message_id: retained.id,
      represented_message_count: 2,
      context_revision: 0,
      continuation_generation: 0,
      provider: "openai",
      route_id: "openai-responses",
      model_id: "gpt-5.6",
      connection_identity_digest: fingerprintDigest,
      prompt_cache_key: "manifest-activation",
      instructions_digest: fingerprintDigest,
      tools_digest: fingerprintDigest,
      options_digest: fingerprintDigest,
      volatile_context_digest: fingerprintDigest,
      continuation_fingerprint: fingerprintDigest,
      time_updated: 1,
    })
    .run()
    .pipe(Effect.orDie)

  const guardrail = { sequence: 0, digest: ContextManifest.payloadDigest({ sessionID, guardrails: "stable" }) }
  guardrailSnapshots.set(sessionID, guardrail)
  const captured = yield* SessionLiveState.captureDatabase(db, sessionID)
  const currentProtectedState = SessionLiveState.toProtectedState({ ...captured.sources, guardrails: guardrail })
  const candidate = ContextManifest.decodeCandidate(
    JSON.stringify({
      schemaVersion: 1,
      baseContextRevision: 0,
      coveredThrough: { messageID: retained.id, seq: 2 },
      protectedState: currentProtectedState,
      exclusions: [{ reason: "exact_duplicate", target, evidence }],
    }),
  )
  const result = ContextManifest.validate({
    candidate,
    evidence: {
      baseContextRevision: 0,
      coveredThrough: { messageID: retained.id, seq: Event.Seq.make(2) },
      items,
      settlements: [],
      authorities: [],
      resourceAuthorities: [],
      toolResults: [],
      protectedTargets: [],
      providerLinks: [
        {
          messageID: old.id,
          ordinal: 0,
          partKind: "reasoning",
          digest: ContextManifest.payloadDigest({ opaque: "covered" }),
          terminalSeq: Event.Seq.make(1),
        },
        {
          messageID: afterBoundary.id,
          ordinal: 0,
          partKind: "reasoning",
          digest: ContextManifest.payloadDigest({ opaque: "later" }),
          terminalSeq: Event.Seq.make(3),
        },
      ],
      protectedState: currentProtectedState,
    },
  })
  if (!result.valid) return yield* Effect.die(result.issues)

  return {
    db,
    sessionID,
    manifest: result.manifest,
    target,
    old,
    retained,
    afterBoundary,
    messages,
    items,
    protectedState: currentProtectedState,
  }
})
