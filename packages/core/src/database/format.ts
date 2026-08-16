export * as DatabaseFormat from "./format"

import { Data } from "effect"

export const PreviousID = "current-2026-07-25"
export const CurrentID = "current-2026-08-04"

export class UnsupportedError extends Data.TaggedError("DatabaseFormatUnsupportedError")<{
  readonly message: string
}> {}

export const unsupported = () =>
  new UnsupportedError({
    message:
      "This YCoding data directory uses an unsupported pre-current format. Start YCoding with a fresh data directory.",
  })
