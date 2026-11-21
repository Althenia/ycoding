import { afterAll, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { InteractionCapture } from "@ycoding-ai/core/interaction/capture"
import { InteractionRuntime } from "@ycoding-ai/core/interaction/index"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { Interaction } from "@ycoding-ai/schema/interaction"
import { testEffect } from "./lib/effect"

const root = await mkdtemp(path.join(tmpdir(), "ycoding-interaction-capture-"))
afterAll(() => rm(root, { recursive: true, force: true }))
const store = AttachmentStore.make(root)
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Session.node, InteractionRuntime.node, InteractionCapture.node]), [
  [SessionExecution.node, SessionExecution.noopLayer],
  [AttachmentStore.node, Layer.succeed(AttachmentStore.Service, store)],
]))
const png = { mimeType: "image/png", width: 1, height: 1,
  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" } as const

it.effect("a user capture becomes one steer input with the frame in the owning Session only", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const owner = Session.ID.make("ses_interaction_capture_owner")
    const bystander = Session.ID.make("ses_interaction_capture_bystander")
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values([
      { id: owner, project_id: Project.ID.global, directory: "/project", title: "Checkout\u0007 review" },
      { id: bystander, project_id: Project.ID.global, directory: "/project", title: "Bystander" },
    ]).run()
    const authority = yield* InteractionRuntime.Service
    const sessions = yield* Session.Service
    const leases: Interaction.ID[] = []
    const native = authority.register({
      platform: "chrome",
      inventory: async () => [{ kind: "chrome-tab", id: Interaction.ID.create(), label: "Fixture", origin: "https://example.test", pathname: "/" }],
      attach: async () => { const lease = { id: Interaction.ID.create() }; leases.push(lease.id); return lease },
      observe: async () => ({ revision: 1, elements: [] }),
      perform: async () => ({ outcome: "applied" }),
      preview: async () => undefined,
      resume: async () => true,
      detach: async () => {},
    })
    const grant = (sessionID: Session.ID) => Effect.promise(async () => {
      const pending = await authority.request(sessionID, { platform: "chrome" })
      const candidate = native.pending().find((request) => request.sessionID === sessionID)
      if (pending.state !== "pending" || !candidate) throw new Error("Expected a pending candidate")
      const [target] = await native.inventory(candidate.candidateID)
      if (!await native.approve({ candidateID: candidate.candidateID, sessionID, targetID: target.id, authorization: "native-proof" }))
        throw new Error("Expected approval")
      return candidate
    })
    const candidate = yield* grant(owner)
    expect(candidate.sessionLabel).toBe("Checkout review")
    yield* grant(bystander)
    const captured = yield* Effect.promise(() => native.capture(leases[0], {
      frame: png, title: "Cart for alice@example.test", url: "https://example.test/cart?token=secret-value#frag",
    }))
    expect(captured).toBe(true)
    const pending = yield* sessions.pending(owner)
    expect(pending).toHaveLength(1)
    const input = pending[0]
    expect(input).toMatchObject({ type: "user", delivery: "steer" })
    if (input.type !== "user") throw new Error("Expected a user input")
    expect(input.data.text).toContain("Selected Chrome tab")
    expect(input.data.text).not.toContain("alice@example.test")
    expect(input.data.text).not.toContain("secret-value")
    expect(input.data.text).not.toContain("\n")
    expect(input.data.files).toHaveLength(1)
    const file = input.data.files![0]
    expect(file.mime).toBe("image/png")
    expect(Buffer.from(yield* store.read(file.content)).toString("base64")).toBe(png.base64)
    expect(yield* sessions.pending(bystander)).toEqual([])
    native.disconnect()
  }),
)
