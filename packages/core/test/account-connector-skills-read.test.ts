import { describe, expect } from "bun:test"
import type { FetchLike } from "@modelcontextprotocol/client"
import { Credential } from "@ycoding-ai/core/credential"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Integration } from "@ycoding-ai/core/integration"
import { Permission } from "@ycoding-ai/core/permission"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { Effect, Exit, Fiber } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventRuntime.node])))
const integrationID = Integration.ID.make("openai")
const methodID = Integration.MethodID.make("chatgpt-browser")
const settings = { enabled: true }
const sessionID = SessionSchema.ID.make("ses_skills_test")

const listBody = {
  hazelnuts: [
    { id: "skill-fixture-1", name: "synthetic-one", enabled: true },
    { id: "skill fixture/2", name: "synthetic-two", enabled: false },
  ],
  next_cursor: "synthetic-cursor-must-not-leak",
}
const detailBody = {
  id: "skill fixture/2",
  name: "synthetic-two",
  sediment_id: "synthetic-sediment",
  files: { "SKILL.md": { start: 0, length: 4 } },
  permissions: { can_read: true },
}

function backend(
  options: {
    status?: number
    body?: unknown
    detailBody?: unknown
    duringFetch?: () => void
    blockedStream?: { entered: PromiseWithResolvers<void>; cancelled: { value: boolean } }
    blockUntilAbort?: { entered: PromiseWithResolvers<void>; aborted: { value: boolean } }
    bodyFlip?: () => void
  } = {},
) {
  const requests: Array<{ url: string; method: string; headers: Headers }> = []
  const fetcher: FetchLike = (input, init) => {
    const request = new Request(input.toString(), init)
    requests.push({ url: request.url, method: request.method, headers: request.headers })
    options.duringFetch?.()
    if (options.blockUntilAbort) {
      const blocked = options.blockUntilAbort
      const signal = (init as RequestInit | undefined)?.signal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            blocked.aborted.value = true
            reject(new DOMException("The operation was aborted", "AbortError"))
          },
          { once: true },
        )
        if (signal?.aborted) {
          blocked.aborted.value = true
          reject(new DOMException("The operation was aborted", "AbortError"))
          return
        }
        blocked.entered.resolve()
      })
    }
    return (async () => {
    if (options.blockedStream) {
      const blocked = options.blockedStream
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              blocked.entered.resolve()
            },
            cancel() {
              blocked.cancelled.value = true
            },
          },
          { highWaterMark: 0 },
        ),
      )
    }
    if (options.bodyFlip) {
      const flip = options.bodyFlip
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            start(controller) {
              flip()
              controller.enqueue(new TextEncoder().encode(JSON.stringify(options.body ?? listBody)))
              controller.close()
            },
          },
          { highWaterMark: 0 },
        ),
      )
    }
    if (options.status) return new Response("Synthetic denied response with private detail", { status: options.status })
    if (request.url.startsWith("https://chatgpt.com/backend-api/hazelnuts/"))
      return Response.json(options.detailBody ?? detailBody)
    return Response.json(options.body ?? listBody)
    })()
  }
  return { requests, fetch: fetcher }
}

const profiles = Effect.fn(function* () {
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  yield* integrations.transform((draft) =>
    draft.method.update({
      integrationID,
      method: { id: methodID, type: "oauth", label: "Synthetic ChatGPT" },
      authorize: () => Effect.die("Authentication must not be started"),
    }),
  )
  const first = yield* credentials.create({
    integrationID,
    label: "fixture-a",
    value: Credential.OAuth.make({
      type: "oauth",
      methodID,
      access: "fixture-access-a",
      refresh: "fixture-refresh-a",
      expires: Date.now() + 3_600_000,
      metadata: { accountID: "fixture-account-a" },
    }),
  })
  const second = yield* credentials.create({
    integrationID,
    label: "fixture-b",
    value: Credential.OAuth.make({
      type: "oauth",
      methodID,
      access: "fixture-access-b",
      refresh: "fixture-refresh-b",
      expires: Date.now() + 3_600_000,
      metadata: { accountID: "fixture-account-b" },
    }),
  })
  yield* credentials.activate(first.id)
  return { integrations, credentials, first, second }
})

const client = Effect.fn(function* (input: {
  backend: ReturnType<typeof backend>
  settings?: () => { enabled: boolean; profile?: string } | undefined
  assert?: Permission.Interface["assert"]
}) {
  const { AccountConnectors } = yield* Effect.promise(() => import("../src/account-connectors"))
  const profile = yield* profiles()
  const assertions: Permission.AssertInput[] = []
  const service = AccountConnectors.make({
    integration: profile.integrations,
    settings: () => Effect.sync(input.settings ?? (() => settings)),
    directory: "/synthetic-project",
    permission: {
      assert:
        input.assert ??
        ((value) =>
          Effect.sync(() => {
            assertions.push(value)
          })),
    },
    guardrail: { assert: () => Effect.succeed({ release: Effect.void }) },
    fetch: input.backend.fetch,
  })
  return { ...profile, service, assertions }
})

describe("account connector skills read", () => {
  it.live("lists installed skills through the fixed route with pinned identity headers", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote })
      const read = yield* current.service.skillsRead({ profile: "fixture-a", permission: { sessionID } })
      const result = yield* read.list()
      expect(remote.requests).toHaveLength(1)
      expect(remote.requests[0]?.method).toBe("GET")
      expect(remote.requests[0]?.url).toBe(
        "https://chatgpt.com/backend-api/hazelnuts?scope=installed&include_permissions=true",
      )
      expect(remote.requests[0]?.headers.get("authorization")).toBe("Bearer fixture-access-a")
      expect(remote.requests[0]?.headers.get("ChatGPT-Account-Id")).toBe("fixture-account-a")
      expect(remote.requests[0]?.headers.get("originator")).toBe("Codex Desktop")
      expect(current.assertions).toHaveLength(1)
      expect(current.assertions[0]).toMatchObject({
        action: "chatgpt_account_skills_read",
        resources: [current.first.id],
        sessionID,
        metadata: { profile: "fixture-a", accountID: "fixture-account-a" },
      })
      expect(result.status).toBe(200)
      expect(result.keys).toEqual(["hazelnuts", "next_cursor"])
      expect(result.count).toBe(2)
      expect(result.hasNext).toBe(true)
      expect(result.paginationKeys).toEqual(["next_cursor"])
      expect(JSON.stringify(result)).not.toContain("synthetic-cursor-must-not-leak")
      expect(JSON.stringify(result)).not.toContain("fixture-access-a")
    }),
  )

  it.live("reads one detail through the fixed encoded route", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote })
      const read = yield* current.service.skillsRead({ profile: "fixture-a", permission: { sessionID } })
      const list = yield* read.list()
      const detail = yield* read.detail(list.ids[1]!)
      expect(remote.requests[1]?.url).toBe(
        "https://chatgpt.com/backend-api/hazelnuts/skill%20fixture%2F2?include_permissions=true",
      )
      expect(detail.status).toBe(200)
      expect(detail.keys).toEqual(["files", "id", "name", "permissions", "sediment_id"])
      expect(JSON.stringify(detail)).not.toContain("synthetic-sediment")
    }),
  )

  it.live("refuses before dispatch when the account generation binding is stale", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote, settings: () => ({ enabled: true }) })
      const exit = yield* current.service
        .skillsRead({
          profile: "fixture-a",
          binding: { credentialID: current.first.id, accountGeneration: current.first.accountGeneration + 1 },
          permission: { sessionID },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(remote.requests).toHaveLength(0)
    }),
  )

  it.live("fails closed when the selected profile changes during dispatch", () =>
    Effect.gen(function* () {
      let selectedProfile: string | undefined
      const remote = backend({
        duringFetch: () => {
          selectedProfile = "fixture-b"
        },
      })
      const current = yield* client({
        backend: remote,
        settings: () => ({ enabled: true, ...(selectedProfile ? { profile: selectedProfile } : {}) }),
      })
      const read = yield* current.service.skillsRead({ profile: "fixture-a", permission: { sessionID } })
      const exit = yield* read.list().pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(remote.requests).toHaveLength(1)
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).not.toContain("synthetic-cursor")
    }),
  )

  it.live("fails closed before dispatch when the active credential changes with no configured profile", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote })
      const read = yield* current.service.skillsRead({ permission: { sessionID } })
      yield* current.credentials.activate(current.second.id)
      const exit = yield* read.list().pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(remote.requests).toHaveLength(0)
    }),
  )

  it.live("configured profile wins across active credential switch", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({
        backend: remote,
        settings: () => ({ enabled: true, profile: "fixture-a" }),
      })
      const read = yield* current.service.skillsRead({ permission: { sessionID } })
      yield* current.credentials.activate(current.second.id)
      const result = yield* read.list()
      expect(result.status).toBe(200)
      expect(remote.requests).toHaveLength(1)
      expect(remote.requests[0]?.headers.get("authorization")).toBe("Bearer fixture-access-a")
    }),
  )

  it.live("fails closed on 401 without retry, refresh, or leaking the response body", () =>
    Effect.gen(function* () {
      const remote = backend({ status: 401 })
      const current = yield* client({ backend: remote })
      const read = yield* current.service.skillsRead({ profile: "fixture-a", permission: { sessionID } })
      const exit = yield* read.list().pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(remote.requests).toHaveLength(1)
      if (Exit.isFailure(exit)) {
        const text = JSON.stringify(exit.cause)
        expect(text).toContain("401")
        expect(text).not.toContain("private detail")
        expect(text).not.toContain("fixture-access-a")
      }
    }),
  )

  it.live("fails closed on 403 without retry", () =>
    Effect.gen(function* () {
      const remote = backend({ status: 403 })
      const current = yield* client({ backend: remote })
      const read = yield* current.service.skillsRead({ profile: "fixture-a", permission: { sessionID } })
      const exit = yield* read.list().pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(remote.requests).toHaveLength(1)
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain("403")
    }),
  )

  it.live("refuses before dispatch when account connectors are disabled", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote, settings: () => ({ enabled: false }) })
      const exit = yield* current.service.skillsRead({ profile: "fixture-a", permission: { sessionID } }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(remote.requests).toHaveLength(0)
    }),
  )

  it.live("rejects mutation-adjacent detail ids before dispatch", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({ backend: remote })
      const read = yield* current.service.skillsRead({ profile: "fixture-a", permission: { sessionID } })
      for (const id of ["", "uploads", "draft", ".", ".."]) {
        const exit = yield* read.detail(id).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }
      expect(remote.requests).toHaveLength(0)
    }),
  )

  it.live("does not infer a next page from a generic cursor field", () =>
    Effect.gen(function* () {
      const remote = backend({ body: { hazelnuts: [{ id: "skill-fixture-1" }], cursor: "synthetic-current" } })
      const current = yield* client({ backend: remote })
      const read = yield* current.service.skillsRead({ profile: "fixture-a", permission: { sessionID } })
      const result = yield* read.list()
      expect(result.hasNext).toBe(false)
      expect(result.paginationKeys).toEqual(["cursor"])
      expect(JSON.stringify(result)).not.toContain("synthetic-current")
    }),
  )

  it.live("refuses a conflicting configured profile for the pinned read before dispatch", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({
        backend: remote,
        settings: () => ({ enabled: true, profile: "fixture-b" }),
      })
      const exit = yield* current.service
        .skillsRead({
          profile: "fixture-a",
          binding: { credentialID: current.first.id, accountGeneration: current.first.accountGeneration },
          permission: { sessionID },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(remote.requests).toHaveLength(0)
    }),
  )

  it.live("fails closed when the profile changes while the response body is read", () =>
    Effect.gen(function* () {
      let selectedProfile: string | undefined
      const remote = backend({
        bodyFlip: () => {
          selectedProfile = "fixture-b"
        },
      })
      const current = yield* client({
        backend: remote,
        settings: () => ({ enabled: true, ...(selectedProfile ? { profile: selectedProfile } : {}) }),
      })
      const read = yield* current.service.skillsRead({ profile: "fixture-a", permission: { sessionID } })
      const exit = yield* read.list().pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(remote.requests).toHaveLength(1)
    }),
  )

  it.live("treats a detail id mismatch as an invalid response", () =>
    Effect.gen(function* () {
      const remote = backend({ detailBody: { ...detailBody, id: "synthetic-other" } })
      const current = yield* client({ backend: remote })
      const read = yield* current.service.skillsRead({ profile: "fixture-a", permission: { sessionID } })
      const exit = yield* read.detail("skill fixture/2").pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).not.toContain("synthetic-other")
    }),
  )

  it.live("refuses before dispatch and sends no network requests when native permission denies", () =>
    Effect.gen(function* () {
      const remote = backend()
      const current = yield* client({
        backend: remote,
        assert: (input) =>
          Effect.fail(
            new Permission.BlockedError({
              rules: [{ action: input.action, resource: "*", effect: "deny" }],
              permission: input.action,
              resources: input.resources,
            }),
          ),
      })
      const read = yield* current.service.skillsRead({ profile: "fixture-a", permission: { sessionID } })
      const exit = yield* read.list().pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(remote.requests).toHaveLength(0)
    }),
  )

  it.live("cancels a blocked response stream when the read is interrupted", () =>
    Effect.gen(function* () {
      const blockedStream = { entered: Promise.withResolvers<void>(), cancelled: { value: false } }
      const remote = backend({ blockedStream })
      const current = yield* client({ backend: remote })
      const read = yield* current.service.skillsRead({ profile: "fixture-a", permission: { sessionID } })
      const fiber = yield* read.list().pipe(Effect.forkChild)
      yield* Effect.promise(() => blockedStream.entered.promise)
      yield* Fiber.interrupt(fiber)
      expect(blockedStream.cancelled.value).toBe(true)
    }),
  )

  it.live("aborts the in-flight fetch when the read is interrupted", () =>
    Effect.gen(function* () {
      const blockUntilAbort = { entered: Promise.withResolvers<void>(), aborted: { value: false } }
      const remote = backend({ blockUntilAbort })
      const current = yield* client({ backend: remote })
      const read = yield* current.service.skillsRead({ profile: "fixture-a", permission: { sessionID } })
      const fiber = yield* read.list().pipe(Effect.forkChild)
      yield* Effect.promise(() => blockUntilAbort.entered.promise)
      yield* Fiber.interrupt(fiber)
      expect(blockUntilAbort.aborted.value).toBe(true)
    }),
  )
})
