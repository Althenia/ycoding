import { expect, test } from "bun:test"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SubagentCursor } from "@ycoding-ai/protocol/groups/session"
import { Effect, Schema } from "effect"
import { sessionHttp } from "./session-http"
import { SessionCompaction } from "../../schema/src/session-compaction"

const parentID = SessionV2.ID.make("ses_http_parent")
const otherID = SessionV2.ID.make("ses_http_other")
const anchor = { rank: 0, updated: 0, sessionID: otherID, direction: "next" } as const

test("subagent list rejects malformed and cross-parent cursors before the paged read", async () => {
  const pages: unknown[] = []
  await using http = sessionHttp(
    {},
    {
      orchestration: {
        page: (input) => Effect.sync(() => void pages.push(input)).pipe(Effect.andThen(Effect.die("unused"))),
      },
    },
  )

  for (const cursor of ["not-a-cursor", SubagentCursor.make({ parentID: otherID, anchor })]) {
    const response = await http.request(`/api/session/${parentID}/subagent?cursor=${cursor}`)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ _tag: "InvalidCursorError", message: "Invalid cursor" })
  }
  expect(pages).toEqual([])
})

test("session skills keeps a missing Session as a typed 404", async () => {
  await using http = sessionHttp({ skills: () => Effect.fail(new SessionV2.NotFoundError({ sessionID: parentID })) })
  const response = await http.request(`/api/session/${parentID}/skills`)

  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ _tag: "SessionNotFoundError", sessionID: parentID })
})

test("compact forwards the job ID and maps a conflicting durable job to 409 by that ID", async () => {
  const jobID = Schema.decodeUnknownSync(SessionV2.CompactionConflictError.fields.jobID)("cmp_http_test")
  const received: unknown[] = []
  await using http = sessionHttp({
    compact: (input) =>
      Effect.sync(() => void received.push(input)).pipe(
        Effect.andThen(
          Effect.fail(new SessionV2.CompactionConflictError({ sessionID: parentID, jobID, message: "job differs" })),
        ),
      ),
  })
  const response = await http.json(`/api/session/${parentID}/compact`, "POST", { id: jobID })

  expect(response.status).toBe(409)
  const body = await response.json()
  expect(body).toMatchObject({
    _tag: "ConflictError",
    resource: jobID,
  })
  expect(body.message).toContain(jobID)
  expect(body.message).toContain("job differs")
  expect(received).toEqual([{ sessionID: parentID, id: jobID }])
})

test("compact returns the settled durable job rather than a pending input or summary", async () => {
  const result = Schema.decodeUnknownSync(SessionCompaction.Result)({
    id: "cmp_http_settled",
    sessionID: parentID,
    trigger: "manual",
    status: "ended",
    requestedThrough: { messageID: "msg_compact_boundary", seq: 4 },
    timeCreated: 0,
  })
  const received: unknown[] = []
  function compact(input: SessionV2.AdvisorCompactInput): Effect.Effect<never>
  function compact(input: SessionV2.ManualCompactInput): Effect.Effect<typeof result>
  function compact(input: SessionV2.AdvisorCompactInput | SessionV2.ManualCompactInput) {
    if (input.trigger !== undefined) return Effect.die("unexpected advisor request")
    return Effect.sync(() => {
      received.push(input)
      return result
    })
  }
  await using http = sessionHttp({ compact })
  const response = await http.json(`/api/session/${parentID}/compact`, "POST", { id: result.id })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    data: {
      id: "cmp_http_settled",
      sessionID: parentID,
      trigger: "manual",
      status: "ended",
      requestedThrough: { messageID: "msg_compact_boundary", seq: 4 },
      timeCreated: 0,
    },
  })
  expect(received).toEqual([{ sessionID: parentID, id: result.id }])
})
