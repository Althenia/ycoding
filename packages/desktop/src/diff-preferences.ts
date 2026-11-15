export type DiffPreferences = { readonly view: "auto" | "split" | "unified"; readonly wrap: "word" | "none"; readonly tree: boolean; readonly single: boolean }
export const defaultDiffPreferences: DiffPreferences = { view: "auto", wrap: "word", tree: true, single: false }

export function parseDiffPreferences(raw: string | null): DiffPreferences {
  try {
    const value: unknown = JSON.parse(raw ?? "null")
    if (!value || typeof value !== "object" || Array.isArray(value)) return defaultDiffPreferences
    const data = value as Record<string, unknown>
    return {
      view: data.view === "split" || data.view === "unified" ? data.view : "auto",
      wrap: data.wrap === "none" ? "none" : "word",
      tree: typeof data.tree === "boolean" ? data.tree : true,
      single: typeof data.single === "boolean" ? data.single : false,
    }
  } catch { return defaultDiffPreferences }
}

export type DiffFileNode = { readonly name: string; readonly path?: string; readonly children: readonly DiffFileNode[] }
export function diffFileTree(paths: readonly string[]): readonly DiffFileNode[] {
  const build = (entries: readonly { readonly path: string; readonly parts: readonly string[] }[]): readonly DiffFileNode[] => {
    const groups = new Map<string, typeof entries[number][]>()
    for (const entry of entries) {
      const name = entry.parts[0]
      if (name === undefined) continue
      const group = groups.get(name) ?? []
      group.push(entry)
      groups.set(name, group)
    }
    return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([name, group]) => ({
      name,
      path: group.find((entry) => entry.parts.length === 1)?.path,
      children: build(group.filter((entry) => entry.parts.length > 1).map((entry) => ({ path: entry.path, parts: entry.parts.slice(1) }))),
    }))
  }
  return build(paths.map((path) => ({ path, parts: path.split("/") })))
}
