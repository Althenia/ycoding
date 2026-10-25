export function toolDisplayName(name: string, metadata?: unknown) {
  const details = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}
  const connector = "connector" in details && typeof details.connector === "string" ? details.connector : undefined
  const tool = "tool" in details && typeof details.tool === "string" ? details.tool : undefined
  const label = "connectorLabel" in details && typeof details.connectorLabel === "string" ? details.connectorLabel : undefined
  const identity = name.match(/^(chatgpt|claude)_(.*)_[a-f0-9]{12}$/)
  const prefix = connector === undefined ? undefined : `${connector.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80)}_`
  const registered = identity?.[2]
  const operation = registered && prefix && registered.startsWith(prefix) ? registered.slice(prefix.length) : undefined
  if (identity && (!operation || (tool && operation !== tool.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80)))) return "Tool name unavailable"
  const parts = identity
    ? [identity[1], ...(label ? [label] : []), tool || operation!]
    : name.replace(/^tools\./, "").replace(/^mcp__/, "").split(/\.|__|\/|:/)
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).map((part) => {
    const words = part.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2")
    const title = words === "chatgpt" ? "ChatGPT" : words.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    return escapeDisplayText(title)
  }).join(" · ") || "Tool"
}

export function escapeDisplayText(value: string) {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}
