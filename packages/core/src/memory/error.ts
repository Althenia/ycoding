import { Data } from "effect"

export class MemoryError extends Data.TaggedError("Memory.Error")<{
  readonly code: "Disabled" | "NotFound" | "InvalidConcept" | "UnsafePath" | "StaleContent" | "TooLarge" | "Unavailable"
  readonly message: string
}> {}

export function memoryError(error: unknown) {
  return error instanceof MemoryError ? error : new MemoryError({ code: "Unavailable", message: "Workspace memory is unavailable; check storage access and configuration." })
}
