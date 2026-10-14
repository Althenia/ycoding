export * as ConfigShell from "./shell"

import { Schema } from "effect"
import { Shell } from "@ycoding-ai/schema/shell"
import { PositiveInt } from "../schema"

export const MAX_MEMORY_LIMIT_MB = Shell.MAX_MEMORY_LIMIT_MB

export const MemoryLimitMb = Shell.MemoryLimitMb

export const MAX_QUEUE_RUNNING = 64
export const MAX_QUEUE_WAITING = 1_000
export const MAX_QUEUE_LOAD = 64

export const Queue = Schema.Struct({
  max_running: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_QUEUE_RUNNING)).pipe(Schema.optional).annotate({
    description: "Machine-wide cap on concurrently running queue-channel shell commands",
  }),
  max_running_per_session: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_QUEUE_RUNNING))
    .pipe(Schema.optional)
    .annotate({ description: "Cap on concurrently running queue-channel shell commands per Session" }),
  max_queued_per_session: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_QUEUE_WAITING))
    .pipe(Schema.optional)
    .annotate({
      description: "Cap on waiting queue-channel shell commands per Session; further commands are rejected",
    }),
  memory_reserve_mb: MemoryLimitMb.pipe(Schema.optional).annotate({
    description:
      "Available memory in MiB required to start a queued command that has no memory limit; a command with a limit requires its limit",
  }),
  max_load: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_QUEUE_LOAD))
    .pipe(Schema.optional)
    .annotate({
      description:
        "Start a queued command only while the 1-minute load average divided by the CPU count is below this value",
    }),
})
export type Queue = typeof Queue.Type

export const QUEUE_DEFAULTS = {
  max_running: 2,
  max_running_per_session: 1,
  max_queued_per_session: 16,
  memory_reserve_mb: 2_048,
  max_load: 1,
} satisfies Required<Queue>

export const queueLimits = (queue: Queue | undefined): Required<Queue> => ({ ...QUEUE_DEFAULTS, ...queue })
