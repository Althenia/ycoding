import { expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { Job } from "../src/job"
import { SessionSchema } from "../src/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Job.node))

it.effect("finished job outputs remain complete after notice admission and eight days of late reads", () =>
  Effect.gen(function* () {
    const jobs = yield* Job.Service
    const sessionID = SessionSchema.ID.make("ses_late_job_outputs")
    const release = yield* Deferred.make<void>()
    let active = 0
    const outputs = Array.from({ length: 16 }, (_, index) => String(index).padStart(4, "0") + "x".repeat(262140))
    for (const [index, output] of outputs.entries()) {
      const job = yield* jobs.start({
        id: `job_late_output_${index}`,
        type: "shell",
        metadata: { sessionID },
        run: Effect.acquireUseRelease(
          Effect.sync(() => { active++ }),
          () => Deferred.await(release).pipe(Effect.as(output)),
          () => Effect.sync(() => { active-- }),
        ),
      })
      yield* jobs.background(job.id)
    }
    expect(active).toBe(16)
    expect([...(yield* jobs.outstandingSessions())]).toEqual([sessionID])
    yield* Deferred.succeed(release, undefined)
    for (const [index, output] of outputs.entries())
      expect(yield* jobs.wait({ id: `job_late_output_${index}` })).toMatchObject({
        timedOut: false, info: { status: "completed", output },
      })
    expect(active).toBe(0)
    expect([...(yield* jobs.outstandingSessions())]).toEqual([sessionID])
    for (let index = 0; index < outputs.length; index++) yield* jobs.noticeAdmitted(`job_late_output_${index}`)
    expect([...(yield* jobs.outstandingSessions())]).toEqual([])
    yield* TestClock.adjust("8 days")
    for (const [index, output] of outputs.entries()) {
      expect(yield* jobs.get(`job_late_output_${index}`)).toMatchObject({ status: "completed", output })
      expect(yield* jobs.wait({ id: `job_late_output_${index}`, timeout: 0 })).toMatchObject({
        timedOut: false, info: { status: "completed", output },
      })
    }
    const retained = yield* jobs.list()
    expect(retained).toHaveLength(16)
    expect(retained.every((job) => job.status === "completed")).toBe(true)
    expect(retained.reduce((bytes, job) => bytes + Buffer.byteLength(job.output ?? ""), 0)).toBe(4194304)
  }),
)
