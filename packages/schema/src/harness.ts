export * as Harness from "./harness.js"

import { Schema } from "effect"

const id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128))

export const Stage = Schema.Literals(["baseline", "propose", "probe", "compose", "adopt"]).annotate({
  identifier: "Harness.Stage",
})
export type Stage = typeof Stage.Type

export const Mode = Schema.Literals(["adaptive", "parallel", "sequential", "disabled"]).annotate({
  identifier: "Harness.Mode",
})
export type Mode = typeof Mode.Type

export const VersionID = id.annotate({ identifier: "Harness.VersionID" })
export const CandidateID = id.annotate({ identifier: "Harness.CandidateID" })
export const Outcome = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)).annotate({
  identifier: "Harness.Outcome",
})
export const ExperienceID = id.annotate({ identifier: "Harness.ExperienceID" })

export const Experiences = Schema.Array(ExperienceID)
  .check(Schema.isMaxLength(64))
  .annotate({ identifier: "Harness.Experiences" })
