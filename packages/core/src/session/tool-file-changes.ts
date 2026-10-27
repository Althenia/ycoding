import { RelativePath } from "../schema"

export const toolFileChanges = (tool: string, structured: unknown) => {
  if (tool !== "edit" && tool !== "patch") return []
  if (typeof structured !== "object" || structured === null || !("files" in structured)) return []
  if (!Array.isArray(structured.files)) return []
  return structured.files.flatMap((file: unknown) => {
    if (typeof file !== "object" || file === null || Array.isArray(file)) return []
    const value = file as Record<string, unknown>
    if (
      typeof value.file !== "string" ||
      typeof value.patch !== "string" ||
      typeof value.additions !== "number" ||
      !Number.isSafeInteger(value.additions) ||
      value.additions < 0 ||
      typeof value.deletions !== "number" ||
      !Number.isSafeInteger(value.deletions) ||
      value.deletions < 0
    )
      return []
    return [
      {
        path: RelativePath.make(value.file),
        patch: value.patch,
        additions: value.additions,
        deletions: value.deletions,
      },
    ]
  })
}
