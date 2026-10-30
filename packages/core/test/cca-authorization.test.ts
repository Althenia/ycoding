import { describe, expect, test } from "bun:test"
import { Session } from "@ycoding-ai/schema/session"
import { Effect } from "effect"
import {
  createCcaAuthorization,
  CcaAuthorizationCloseError,
  CcaAuthorizationDeniedError,
} from "../src/cca/authorization"
import type { Permission } from "../src/permission"
import type { SessionGuardrail } from "../src/session/guardrail"

const sessionID = Session.ID.make("ses_cca_authorization")
type ObservedEvent = { readonly type: string; readonly data: Record<string, unknown> }

function harness(options: {
  currentOutcomes?: readonly boolean[]
  permissionFails?: boolean
  guardrailFails?: boolean
  permissionNever?: boolean
  currentNeverOnCall?: number
  timeoutMs?: number
  releaseFailOn?: number
  permissionEvents?: readonly ObservedEvent[]
  guardrailEvents?: readonly ObservedEvent[]
  withoutEvents?: boolean
  defer?: boolean
  permissionFailure?: unknown
  guardrailDefect?: unknown
} = {}) {
  const listeners = new Set<(event: ObservedEvent) => Effect.Effect<void>>()
  const emit = (items: readonly ObservedEvent[] | undefined) =>
    Effect.sync(() => { for (const item of items ?? []) for (const listener of listeners) Effect.runSync(listener(item)) })
  const events: string[] = []
  const permissionInputs: Permission.AssertInput[] = []
  const guardrailInputs: SessionGuardrail.EvaluateInput[] = []
  let currentCalls = 0
  let releases = 0
  let releaseAttempts = 0
  let holderSeq = 0

  const assertCurrent = (_id: Session.ID) => {
    const index = currentCalls++
    events.push("current")
    if (options.currentNeverOnCall === index + 1) return Effect.never
    const ok = options.currentOutcomes?.[index] ?? true
    return ok ? Effect.void : Effect.fail(new Error("session not current"))
  }
  const permission = {
    assert: (input: Permission.AssertInput) => {
      events.push("permission")
      permissionInputs.push(input)
      if (options.permissionNever)
        return emit(options.permissionEvents).pipe(Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              events.push("permission-cancelled")
            }),
          ),
        )
      if (options.permissionFailure !== undefined) return Effect.fail(options.permissionFailure)
      return emit(options.permissionEvents).pipe(Effect.andThen(options.permissionFails ? Effect.fail(new Error("permission denied")) : Effect.void))
    },
  } as unknown as Permission.Interface
  const guardrail = {
    assert: (input: SessionGuardrail.EvaluateInput) => {
      events.push("guardrail")
      guardrailInputs.push(input)
      const reservationOrdinal = guardrailInputs.length
      if (options.guardrailDefect !== undefined) return Effect.die(options.guardrailDefect)
      return emit(options.guardrailEvents).pipe(Effect.andThen(options.guardrailFails
        ? Effect.fail(new Error("guardrail denied"))
        : Effect.succeed({
            release: Effect.gen(function* () {
              releaseAttempts++
              events.push("release")
              if (options.releaseFailOn === reservationOrdinal)
                return yield* Effect.die(new Error("release-secret"))
              releases++
            }),
          })))
    },
  } as unknown as SessionGuardrail.Interface

  const authorization = createCcaAuthorization({
    sessionID,
    permission,
    guardrail,
    assertCurrent,
    ...(options.withoutEvents ? {} : { events: { listen: (listener: (event: ObservedEvent) => Effect.Effect<void>) => Effect.sync(() => {
      listeners.add(listener)
      return Effect.sync(() => { listeners.delete(listener) })
    }) } }),
    holderID: () => `synthetic-${++holderSeq}`,
    ...(options.defer === undefined ? {} : { defer: options.defer }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  return {
    authorization,
    events,
    permissionInputs,
    guardrailInputs,
    releases: () => releases,
    releaseAttempts: () => releaseAttempts,
    currentCalls: () => currentCalls,
  }
}

const request = { action: "shell", resources: ["echo synthetic"], metadata: { processId: "p1" } }

describe("createCcaAuthorization", () => {
  test("trusted Library operations use their own permission with mcp_execute guardrails", async () => {
    const f = harness({ guardrailEvents: [
      { type: "guardrail.asked", data: { sessionID, id: "grq_library", action: "mcp_execute", resources: ["connector_openai_library"] } },
      { type: "guardrail.replied", data: { sessionID, requestID: "grq_library", reply: "once", authority: "user" } },
    ] })
    const grant = await f.authorization.authorize({ action: "chatgpt_library_upload", guardrailAction: "mcp_execute", resources: ["connector_openai_library"] })
    expect(f.permissionInputs[0]!.action).toBe("chatgpt_library_upload")
    expect(f.guardrailInputs[0]!.action).toBe("mcp_execute")
    expect(grant.trace).toContainEqual({ kind: "guardrail", requestID: "grq_library", reply: "once", by: "user" })
    await grant.release()
    await f.authorization.close()
  })
  test.each(["permission", "guardrail"] as const)("a denied Library %s prevents dispatch under the real Session binding", async (kind) => {
    const f = harness({ permissionFails: kind === "permission", guardrailFails: kind === "guardrail" })
    let dispatched = 0
    const operation = async () => {
      const grant = await f.authorization.authorize({ action: "chatgpt_library_upload", guardrailAction: "mcp_execute", resources: ["connector_openai_library"] })
      try { dispatched++ } finally { await grant.release() }
    }
    await expect(operation()).rejects.toBeInstanceOf(CcaAuthorizationDeniedError)
    expect(dispatched).toBe(0)
    expect(f.permissionInputs[0]).toMatchObject({ sessionID, action: "chatgpt_library_upload" })
    if (kind === "guardrail") expect(f.guardrailInputs[0]).toMatchObject({ sessionID, action: "mcp_execute" })
    await f.authorization.close()
  })
  test("checks current, permission, guardrail, current in order and releases exactly once", async () => {
    const h = harness()
    const grant = await h.authorization.authorize(request)
    expect(h.events).toEqual(["current", "permission", "guardrail", "current"])
    expect(h.permissionInputs).toHaveLength(1)
    expect(h.permissionInputs[0]?.sessionID).toBe(sessionID)
    expect(h.permissionInputs[0]?.action).toBe("shell")
    expect(h.permissionInputs[0]?.resources).toEqual(["echo synthetic"])
    expect(h.permissionInputs[0]?.source).toBeUndefined()
    expect(h.guardrailInputs).toHaveLength(1)
    expect(h.guardrailInputs[0]?.sessionID).toBe(sessionID)
    expect(h.guardrailInputs[0]?.source).toBeUndefined()
    expect(h.guardrailInputs[0]?.holder).toBe("cca:synthetic-1")
    await grant.release()
    await grant.release()
    expect(h.releases()).toBe(1)
  })

  test("every request asserts fresh with a fresh holder and no grant reuse", async () => {
    const h = harness()
    const first = await h.authorization.authorize(request)
    const second = await h.authorization.authorize(request)
    expect(h.permissionInputs).toHaveLength(2)
    expect(h.guardrailInputs.map((input) => input.holder)).toEqual(["cca:synthetic-1", "cca:synthetic-2"])
    await first.release()
    expect(h.releases()).toBe(1)
    await second.release()
    expect(h.releases()).toBe(2)
  })

  test("missing or stale session at the first current check fails before any assert", async () => {
    const h = harness({ currentOutcomes: [false] })
    const error = await h.authorization.authorize(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaAuthorizationDeniedError)
    expect(h.permissionInputs).toHaveLength(0)
    expect(h.guardrailInputs).toHaveLength(0)
    expect(h.releases()).toBe(0)
  })

  test("permission denial rejects without reaching guardrail", async () => {
    const h = harness({ permissionFails: true })
    const error = await h.authorization.authorize(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaAuthorizationDeniedError)
    expect(h.events).toEqual(["current", "permission"])
    expect(h.guardrailInputs).toHaveLength(0)
    expect(h.releases()).toBe(0)
  })

  test("guardrail denial rejects with no reservation to release", async () => {
    const h = harness({ guardrailFails: true })
    const error = await h.authorization.authorize(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaAuthorizationDeniedError)
    expect(h.events).toEqual(["current", "permission", "guardrail"])
    expect(h.releases()).toBe(0)
  })

  test("retirement detected by the repeated current check releases the reservation before rejecting", async () => {
    const h = harness({ currentOutcomes: [true, false] })
    const error = await h.authorization.authorize(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaAuthorizationDeniedError)
    expect(h.events).toEqual(["current", "permission", "guardrail", "current", "release"])
    expect(h.releases()).toBe(1)
  })

  test("a pending permission ask times out, interrupts the pending assert, and denies", async () => {
    const h = harness({ permissionNever: true, timeoutMs: 30 })
    const started = Date.now()
    const error = await h.authorization.authorize(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaAuthorizationDeniedError)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(h.events).toContain("permission-cancelled")
    expect(h.guardrailInputs).toHaveLength(0)
    expect(h.releases()).toBe(0)
  })

  test("timeout after the guardrail grant releases the reservation and denies", async () => {
    const h = harness({ currentNeverOnCall: 2, timeoutMs: 30 })
    const error = await h.authorization.authorize(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaAuthorizationDeniedError)
    expect(h.events).toEqual(["current", "permission", "guardrail", "current", "release"])
    expect(h.releases()).toBe(1)
  })

  test("post-grant unwind release failure remains sticky until close", async () => {
    const h = harness({ currentOutcomes: [true, false], releaseFailOn: 1 })
    const denied = await h.authorization.authorize(request).catch((caught: unknown) => caught)
    expect(denied).toBeInstanceOf(CcaAuthorizationDeniedError)
    expect((denied as Error).message).not.toContain("release-secret")
    expect(h.events).toEqual(["current", "permission", "guardrail", "current", "release"])
    expect(h.releaseAttempts()).toBe(1)
    expect(h.releases()).toBe(0)
    const error = await h.authorization.close().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaAuthorizationCloseError)
    expect((error as Error).message).toBe("CCA authorization cleanup failed")
    expect((error as Error).message).not.toContain("release-secret")
    expect(h.releaseAttempts()).toBe(1)
  })

  test("direct release failure remains sticky until close", async () => {
    const h = harness({ releaseFailOn: 1 })
    const grant = await h.authorization.authorize(request)
    const releaseError = await grant.release().catch((caught: unknown) => caught)
    expect(releaseError).toBeInstanceOf(CcaAuthorizationCloseError)
    expect((releaseError as Error).message).not.toContain("release-secret")
    expect(h.releaseAttempts()).toBe(1)
    const error = await h.authorization.close().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaAuthorizationCloseError)
    expect((error as Error).message).toBe("CCA authorization cleanup failed")
    expect(h.releaseAttempts()).toBe(1)
  })

  test("close attempts every release and sanitizes any failure", async () => {
    const h = harness({ releaseFailOn: 1 })
    const first = await h.authorization.authorize(request)
    const second = await h.authorization.authorize(request)
    const error = await h.authorization.close().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaAuthorizationCloseError)
    expect((error as Error).message).toBe("CCA authorization cleanup failed")
    expect((error as Error).message).not.toContain("release-secret")
    expect(h.releaseAttempts()).toBe(2)
    expect(h.releases()).toBe(1)
    await first.release()
    await second.release()
    expect(h.releaseAttempts()).toBe(2)
    const secondError = await h.authorization.close().catch((caught: unknown) => caught)
    expect(secondError).toBeInstanceOf(CcaAuthorizationCloseError)
    expect(h.releaseAttempts()).toBe(2)
  })

  test("close releases outstanding grants exactly once and later authorize calls fail closed", async () => {
    const h = harness()
    const grant = await h.authorization.authorize(request)
    await h.authorization.close()
    expect(h.releases()).toBe(1)
    await grant.release()
    expect(h.releases()).toBe(1)
    await h.authorization.close()
    expect(h.releases()).toBe(1)
    const callsBefore = h.currentCalls()
    const error = await h.authorization.authorize(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaAuthorizationDeniedError)
    expect(h.currentCalls()).toBe(callsBefore)
    expect(h.permissionInputs).toHaveLength(1)
  })

  const asked = (type: "permission.asked" | "guardrail.asked", id: string, resources = request.resources) =>
    ({ type, data: { id, sessionID, rootSessionID: sessionID, action: request.action, resources } })

  test("an unasked grant traces both checks as allowed by rule", async () => {
    const h = harness()
    const grant = await h.authorization.authorize(request)
    expect(grant.trace).toEqual([
      { kind: "permission", reply: "allow", by: "rule" },
      { kind: "guardrail", reply: "allow", by: "rule" },
    ])
    await grant.release()
  })

  test("asks matched by requestID trace the reply and who decided it", async () => {
    const h = harness({
      permissionEvents: [
        asked("permission.asked", "per_other", ["echo other"]),
        asked("permission.asked", "per_synthetic"),
        { type: "session.permission.assessed", data: { sessionID, requestID: "per_other", outcome: "allow", via: "yolo", reply: "always" } },
        { type: "permission.replied", data: { sessionID, requestID: "per_synthetic", reply: "once" } },
      ],
      guardrailEvents: [
        asked("guardrail.asked", "grd_synthetic"),
        { type: "guardrail.replied", data: { sessionID, rootSessionID: sessionID, requestID: "grd_synthetic", reply: "always", decidedBy: "decision-model", authority: "yolo" } },
      ],
    })
    const grant = await h.authorization.authorize(request)
    expect(grant.trace).toEqual([
      { kind: "permission", requestID: "per_synthetic", reply: "once", by: "user" },
      { kind: "guardrail", requestID: "grd_synthetic", reply: "always", by: "yolo" },
    ])
    await grant.release()
  })

  test("automatic permission and decision-model guardrail replies trace as auto", async () => {
    const h = harness({
      permissionEvents: [
        asked("permission.asked", "per_synthetic"),
        { type: "session.permission.assessed", data: { sessionID, requestID: "per_synthetic", outcome: "allow", via: "auto-permission", reply: "once" } },
        { type: "permission.replied", data: { sessionID, requestID: "per_synthetic", reply: "once" } },
      ],
      guardrailEvents: [
        asked("guardrail.asked", "grd_synthetic"),
        { type: "guardrail.replied", data: { sessionID, rootSessionID: sessionID, requestID: "grd_synthetic", reply: "once", decidedBy: "decision-model", authority: "baseline" } },
      ],
    })
    const grant = await h.authorization.authorize(request)
    expect(grant.trace).toEqual([
      { kind: "permission", requestID: "per_synthetic", reply: "once", by: "auto" },
      { kind: "guardrail", requestID: "grd_synthetic", reply: "once", by: "auto" },
    ])
    await grant.release()
  })

  test("a denial carries its trace on the error", async () => {
    const rule = harness({ permissionFails: true })
    const byRule = await rule.authorization.authorize(request).catch((caught: unknown) => caught)
    expect((byRule as CcaAuthorizationDeniedError).trace).toEqual([{ kind: "permission", reply: "reject", by: "rule" }])
    const user = harness({
      guardrailFails: true,
      guardrailEvents: [
        asked("guardrail.asked", "grd_synthetic"),
        { type: "guardrail.replied", data: { sessionID, rootSessionID: sessionID, requestID: "grd_synthetic", reply: "reject" } },
      ],
    })
    const byUser = await user.authorization.authorize(request).catch((caught: unknown) => caught)
    expect((byUser as CcaAuthorizationDeniedError).trace).toEqual([
      { kind: "permission", reply: "allow", by: "rule" },
      { kind: "guardrail", requestID: "grd_synthetic", reply: "reject", by: "user" },
    ])
  })

  test("an ask still pending at the time limit traces as expired", async () => {
    const h = harness({ permissionNever: true, timeoutMs: 30, permissionEvents: [asked("permission.asked", "per_synthetic")] })
    const error = await h.authorization.authorize(request).catch((caught: unknown) => caught)
    expect((error as CcaAuthorizationDeniedError).trace).toEqual([{ kind: "permission", requestID: "per_synthetic", reply: "expired", by: "expired" }])
  })

  test("without an event source authorization still grants and denies on its checks and only the trace is empty", async () => {
    const allowed = harness({ withoutEvents: true })
    const grant = await allowed.authorization.authorize(request)
    expect(allowed.events).toEqual(["current", "permission", "guardrail", "current"])
    expect(grant.trace).toEqual([])
    await grant.release()
    expect(allowed.releases()).toBe(1)
    const denied = harness({ withoutEvents: true, permissionFails: true })
    const error = await denied.authorization.authorize(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaAuthorizationDeniedError)
    expect((error as CcaAuthorizationDeniedError).trace).toEqual([])
  })

  test("Dots scopes defer human decisions and every assert saves its resources", async () => {
    const deferred = harness({ defer: true })
    await (await deferred.authorization.authorize(request)).release()
    expect(deferred.permissionInputs[0]).toMatchObject({ defer: true, save: ["echo synthetic"] })
    expect(deferred.guardrailInputs[0]).toMatchObject({ defer: true })
    const waiting = harness()
    await (await waiting.authorization.authorize(request)).release()
    expect(waiting.permissionInputs[0]).toMatchObject({ save: ["echo synthetic"] })
    expect(waiting.permissionInputs[0]).not.toHaveProperty("defer")
    expect(waiting.guardrailInputs[0]).not.toHaveProperty("defer")
  })

  test("a deferred permission failure becomes the pending decision", async () => {
    const h = harness({ defer: true, permissionFailure: {
      _tag: "Permission.DeferredError", sessionID: "ses_owner", itemID: "rvw_synthetic", state: "open", action: "shell", resources: ["echo synthetic"],
    } })
    const error = await h.authorization.authorize(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaAuthorizationDeniedError)
    expect((error as CcaAuthorizationDeniedError).pending).toEqual([{
      kind: "permission", sessionID: "ses_owner", itemID: "rvw_synthetic", action: "shell", resources: ["echo synthetic"], hardReview: false, state: "open",
    }])
    expect((error as CcaAuthorizationDeniedError).busy).toBeUndefined()
    expect(h.guardrailInputs).toHaveLength(1)
    expect(h.releases()).toBe(1)
  })

  test("a deferred guardrail defect becomes the pending decision with its hard-review flag and state", async () => {
    const h = harness({ defer: true, guardrailDefect: {
      _tag: "Guardrail.DeferredError", sessionID: "ses_owner", state: "full", action: "shell", resources: ["echo synthetic"], hardReview: true,
    } })
    const error = await h.authorization.authorize(request).catch((caught: unknown) => caught)
    expect((error as CcaAuthorizationDeniedError).pending).toEqual([{
      kind: "guardrail", sessionID: "ses_owner", action: "shell", resources: ["echo synthetic"], hardReview: true, state: "full",
    }])
  })

  test("an open guardrail item carries the review directories that an always approval would remember", async () => {
    const looked: string[] = []
    const authorization = createCcaAuthorization({
      sessionID, events: { listen: () => Effect.succeed(Effect.void) }, assertCurrent: () => Effect.void, defer: true,
      permission: { assert: () => Effect.void } as unknown as Permission.Interface,
      guardrail: { assert: () => Effect.fail({
        _tag: "Guardrail.DeferredError", requestID: "grd_synthetic", sessionID: "ses_owner", itemID: "rvw_synthetic", state: "open",
        action: "shell", resources: ["echo synthetic"], ruleIDs: ["standard.review.outside-repo"], hardReview: false,
      }) } as unknown as SessionGuardrail.Interface,
      reviewDirectories: (owner, itemID) => Effect.sync(() => { looked.push(`${owner}/${itemID}`); return ["/synthetic/outside"] }),
    })
    const error = await authorization.authorize(request).catch((caught: unknown) => caught)
    expect((error as CcaAuthorizationDeniedError).pending).toMatchObject([{ kind: "guardrail", directories: ["/synthetic/outside"] }])
    expect(looked).toEqual(["ses_owner/rvw_synthetic"])
  })

  test("a plain denial carries no pending decision and a timeout is busy without one", async () => {
    const denied = await harness({ defer: true, permissionFails: true }).authorization.authorize(request).catch((caught: unknown) => caught)
    expect((denied as CcaAuthorizationDeniedError).pending).toBeUndefined()
    expect((denied as CcaAuthorizationDeniedError).busy).toBeUndefined()
    const busy = await harness({ defer: true, permissionNever: true, timeoutMs: 30 }).authorization.authorize(request).catch((caught: unknown) => caught)
    expect((busy as CcaAuthorizationDeniedError).busy).toBe(true)
    expect((busy as CcaAuthorizationDeniedError).pending).toBeUndefined()
    const waited = await harness({ permissionNever: true, timeoutMs: 30 }).authorization.authorize(request).catch((caught: unknown) => caught)
    expect(waited).toBeInstanceOf(CcaAuthorizationDeniedError)
    expect((waited as CcaAuthorizationDeniedError).busy).toBeUndefined()
  })

  const permissionOpen = { _tag: "Permission.DeferredError", sessionID: "ses_owner", itemID: "rvw_permission", state: "open", action: "shell", resources: ["echo synthetic"] }

  test("an open permission item still evaluates the guardrail and collects its item too", async () => {
    const h = harness({ defer: true, permissionFailure: permissionOpen, guardrailDefect: {
      _tag: "Guardrail.DeferredError", sessionID: "ses_owner", itemID: "rvw_guardrail", state: "open", action: "shell", resources: ["echo synthetic"], hardReview: true,
    } })
    const error = await h.authorization.authorize(request).catch((caught: unknown) => caught)
    expect((error as CcaAuthorizationDeniedError).pending?.map((item) => [item.kind, item.itemID])).toEqual([["permission", "rvw_permission"], ["guardrail", "rvw_guardrail"]])
    expect(h.guardrailInputs[0]).toMatchObject({ defer: true })
  })

  test("a guardrail deny after an open permission item wins as a plain denial", async () => {
    const h = harness({ defer: true, permissionFailure: permissionOpen, guardrailFails: true })
    const error = await h.authorization.authorize(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaAuthorizationDeniedError)
    expect((error as CcaAuthorizationDeniedError).pending).toBeUndefined()
  })

  test("a rejected or full permission item stops before the guardrail", async () => {
    const h = harness({ defer: true, permissionFailure: { ...permissionOpen, state: "rejected" } })
    const error = await h.authorization.authorize(request).catch((caught: unknown) => caught)
    expect((error as CcaAuthorizationDeniedError).pending?.map((item) => item.state)).toEqual(["rejected"])
    expect(h.guardrailInputs).toHaveLength(0)
  })
})
