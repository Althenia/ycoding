export function isConversationRoot(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const id = Reflect.get(value, "id")
  const parentID = Reflect.get(value, "parentID")
  return typeof id === "string" && id.length > 0 && !id.startsWith("ses_compaction_") &&
    Reflect.get(value, "agent") !== "compaction" && (parentID === undefined || parentID === null)
}
