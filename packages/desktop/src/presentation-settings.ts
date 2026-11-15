export type PresentationSettings = {
  readonly thinking: "show" | "hide"
  readonly grouping: "auto" | "none"
  readonly companion: "auto" | "hide"
}

export const PRESENTATION_STORAGE_KEY = "ycoding.desktop.presentation"
export const DEFAULT_PRESENTATION: PresentationSettings = { thinking: "hide", grouping: "auto", companion: "hide" }
export const COMPANION_DOCKED_QUERY = "(min-width: 1181px)"

const choice = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => options.find((option) => option === value) ?? fallback

export function parsePresentationSettings(raw: string | null): PresentationSettings {
  if (raw === null || raw.length > 4_096) return DEFAULT_PRESENTATION
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return DEFAULT_PRESENTATION }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_PRESENTATION
  const own = (key: string) => Object.hasOwn(parsed, key) ? Reflect.get(parsed, key) : undefined
  return {
    thinking: choice(own("thinking"), ["show", "hide"], DEFAULT_PRESENTATION.thinking),
    grouping: choice(own("grouping"), ["auto", "none"], DEFAULT_PRESENTATION.grouping),
    companion: choice(own("companion"), ["auto", "hide"], DEFAULT_PRESENTATION.companion),
  }
}

export const withThinking = (settings: PresentationSettings, expanded: boolean): PresentationSettings => ({ ...settings, thinking: expanded ? "show" : "hide" })
export const withToolGrouping = (settings: PresentationSettings, grouping: PresentationSettings["grouping"]): PresentationSettings => ({ ...settings, grouping })
export const withCompanion = (settings: PresentationSettings, open: boolean): PresentationSettings => ({ ...settings, companion: open ? "auto" : "hide" })
export const startupCompanionOpen = (settings: PresentationSettings, docked: boolean) => settings.companion === "auto" && docked

export function toolDisclosures<T>(parts: readonly T[], grouping: PresentationSettings["grouping"]): readonly (readonly T[])[] {
  if (parts.length === 0) return []
  return grouping === "auto" ? [parts] : parts.map((part) => [part])
}
