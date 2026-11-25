const uri = /^ui:\/\/[a-zA-Z0-9._~-]+\/[a-zA-Z0-9._~!$&'()+,;=:@/%-]+$/

export function appResourceUri(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || !("ui" in metadata)) return undefined
  const ui = metadata.ui
  if (!ui || typeof ui !== "object" || !("resourceUri" in ui)) return undefined
  const resource = ui.resourceUri
  if (typeof resource !== "string" || resource.length > 2048 || !uri.test(resource)) return undefined
  return resource
}
