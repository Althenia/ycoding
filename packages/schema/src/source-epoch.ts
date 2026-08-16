import { Schema } from "effect"

/** Stable identity of one running server process. */
export const SourceEpoch = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand("SourceEpoch"))
export type SourceEpoch = typeof SourceEpoch.Type
