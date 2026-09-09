import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { PtyID } from "@ycoding-ai/core/pty/schema"
import { PtyTicket } from "@ycoding-ai/core/pty/ticket"
import { SessionV2 } from "@ycoding-ai/core/session"
import { WorkspaceV2 } from "@ycoding-ai/core/workspace"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(PtyTicket.node))
const itExpiring = testEffect(
  LayerNode.compile(PtyTicket.node, [[PtyTicket.node, Layer.effect(PtyTicket.Service, PtyTicket.make(5))]]),
)
const sessionID = () => SessionV2.ID.make(`ses_${crypto.randomUUID()}`)

describe("PTY websocket tickets", () => {
  it.live("consumes tickets once", () =>
    Effect.gen(function* () {
      const tickets = yield* PtyTicket.Service
      const scope = {
        ptyID: PtyID.ascending(),
        sessionID: sessionID(),
        access: "inspect" as const,
        generation: 1,
        directory: "/tmp/a",
      }
      const issued = yield* tickets.issue(scope)

      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(true)
      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(false)
    }),
  )

  it.live("rejects tickets scoped to a different request", () =>
    Effect.gen(function* () {
      const tickets = yield* PtyTicket.Service
      const ptyID = PtyID.ascending()
      const scope = { ptyID, sessionID: sessionID(), access: "inspect" as const, generation: 1 }
      const issued = yield* tickets.issue({ ...scope, directory: "/tmp/a" })

      expect(yield* tickets.consume({ ...scope, directory: "/tmp/b", ticket: issued.ticket })).toBe(false)
      expect(yield* tickets.consume({ ...scope, directory: "/tmp/a", ticket: issued.ticket })).toBe(true)
    }),
  )

  itExpiring.live("rejects tickets after the TTL elapses", () =>
    Effect.gen(function* () {
      const tickets = yield* PtyTicket.Service
      const ptyID = PtyID.ascending()
      const scope = { ptyID, sessionID: sessionID(), access: "inspect" as const, generation: 1 }
      const issued = yield* tickets.issue(scope)

      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)))

      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(false)
    }),
  )

  it.live("rejects tickets scoped to a different workspace", () =>
    Effect.gen(function* () {
      const tickets = yield* PtyTicket.Service
      const ptyID = PtyID.ascending()
      const workspaceID = WorkspaceV2.ID.ascending()
      const scope = { ptyID, sessionID: sessionID(), access: "inspect" as const, generation: 1 }
      const issued = yield* tickets.issue({ ...scope, workspaceID })

      expect(yield* tickets.consume({ ...scope, workspaceID: WorkspaceV2.ID.ascending(), ticket: issued.ticket })).toBe(
        false,
      )
      expect(yield* tickets.consume({ ...scope, workspaceID, ticket: issued.ticket })).toBe(true)
    }),
  )

  it.live("fences control tickets by Session, access, generation, and writer fence", () =>
    Effect.gen(function* () {
      const tickets = yield* PtyTicket.Service
      const scope = {
        ptyID: PtyID.ascending(),
        sessionID: sessionID(),
        access: "control" as const,
        generation: 3,
        fence: 7,
      }
      const issued = yield* tickets.issue(scope)

      expect(yield* tickets.consume({ ...scope, fence: 8, ticket: issued.ticket })).toBe(false)
      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(true)
    }),
  )
})
