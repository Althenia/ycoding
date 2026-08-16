export type RailSectionKey =
  | "session"
  | "context"
  | "todo"
  | "goal"
  | "autonomy"
  | "subagents"
  | "shells"
  | "skills"
  | "mcp"
  | "plugins"
  // Existing rail content the design's section list does not enumerate. Both summarise themselves,
  // so they follow the collapsed-by-default rule.
  | "guardrails"
  | "lsp"

/**
 * A fifth expanded section collapses the least recently expanded one, so the rail never turns into a
 * scroll wall where every section is half visible.
 */
export const MAX_EXPANDED = 4

/**
 * Sections that carry no summary on their header row, so collapsing them would hide information.
 * The remaining sections summarise themselves and stay collapsed until an attention event.
 */
export function defaultExpanded(input: { goal?: boolean; autonomy?: boolean }): RailSectionKey[] {
  return [
    "session" as const,
    "context" as const,
    ...(input.goal ? (["goal"] as const) : []),
    ...(input.autonomy ? (["autonomy"] as const) : []),
    "todo" as const,
  ].slice(-MAX_EXPANDED)
}

/**
 * `order` is a recency list with the least recently expanded section first.
 */
export function expandSection(order: RailSectionKey[], key: RailSectionKey): RailSectionKey[] {
  return [...order.filter((item) => item !== key), key].slice(-MAX_EXPANDED)
}

export function collapseSection(order: RailSectionKey[], key: RailSectionKey): RailSectionKey[] {
  return order.filter((item) => item !== key)
}

/**
 * Attention events force a section open and release it once cleared, but a section the user expanded
 * themselves stays open after the event clears.
 */
export function resolveExpanded(input: {
  order: RailSectionKey[]
  attention: RailSectionKey[]
}): RailSectionKey[] {
  return input.attention.reduce(expandSection, input.order)
}

/**
 * Rail placement follows the terminal width: hidden below 100 columns, an overlay until the main pane
 * can hold its own beside it, then a docked rail.
 */
export function railPlacement(width: number) {
  if (width < 100) return "hidden" as const
  if (width < 120) return "overlay" as const
  return "docked" as const
}

export function railWidth(width: number) {
  if (width >= 160) return 36
  if (width < 120) return 36
  return Math.min(36, 32 + Math.floor((width - 120) / 10))
}
