export * as ConfigMemory from "./memory"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("Config.Memory")({
  enabled: Schema.optional(Schema.Boolean).annotate({ description: "Enable on-demand workspace memory (default: true). Never automatically recalls or saves transcripts." }),
  path: Schema.optional(Schema.String.check(Schema.isPattern(/\S/))).annotate({ description: "Managed memory base; defaults to the YCoding data directory's memory folder. Relative paths use the active Location." }),
  max_concept_bytes: Schema.optional(PositiveInt).annotate({ description: "Maximum UTF-8 bytes per concept (default: 65536)." }),
  max_bundle_bytes: Schema.optional(PositiveInt).annotate({ description: "Maximum total concept bytes per workspace (default: 8388608)." }),
  max_concepts: Schema.optional(PositiveInt).annotate({ description: "Maximum concepts per workspace (default: 1000)." }),
}) {}

export function resolve(infos: readonly Info[]) {
  return infos.reduce<{
    enabled: boolean
    path?: string
    max_concept_bytes: number
    max_bundle_bytes: number
    max_concepts: number
  }>((settings, info) => ({
    ...settings,
    ...Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)),
  }), { enabled: true, max_concept_bytes: 65_536, max_bundle_bytes: 8_388_608, max_concepts: 1_000 })
}

export type Resolved = ReturnType<typeof resolve>
