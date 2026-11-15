import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import type { EditorSelection } from "./editor-integration"

export function workspaceScore(parent: string, directory: string) {
  if (!path.isAbsolute(parent)) return 0
  const relative = path.relative(path.resolve(parent), path.resolve(directory))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) ? path.resolve(parent).length : 0
}

function workspacePaths(value: string | null) {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string")
  } catch {}
  return value.split(/\r?\n/).filter(Boolean)
}

function stringOffset(text: string, byteOffset: number) {
  let bytes = 0
  let index = 0
  for (const character of text) {
    if (bytes >= byteOffset) break
    bytes += new TextEncoder().encode(character).length
    index += character.length
  }
  return index
}

function position(text: string, offset: number) {
  const lines = text.slice(0, offset).split("\n")
  return { line: lines.length, character: lines.at(-1)!.length + 1 }
}

export async function readZedSelection(database: string, directory: string): Promise<{ type: "selection"; selection: EditorSelection } | { type: "empty" | "unavailable" }> {
  let db: Database | undefined
  try {
    if (!(await fs.stat(database)).isFile()) return { type: "unavailable" }
    db = new Database(database, { readonly: true })
    const rows = db.query<{ item_kind: string; editor_id: number | null; workspace_id: number; workspace_paths: string | null; timestamp: string; buffer_path: string | null }, []>(`select i.kind as item_kind, e.item_id as editor_id, i.workspace_id, w.paths as workspace_paths, w.timestamp, e.buffer_path from items i join panes p on p.pane_id = i.pane_id and p.workspace_id = i.workspace_id join workspaces w on w.workspace_id = i.workspace_id left join editors e on e.item_id = i.item_id and e.workspace_id = i.workspace_id where i.active = 1 and p.active = 1 order by w.timestamp desc`).all()
    const selected = rows.map((row) => ({ row, score: Math.max(0, ...workspacePaths(row.workspace_paths).map((folder) => workspaceScore(folder, directory))) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || String(b.row.timestamp).localeCompare(String(a.row.timestamp)))[0]?.row
    if (!selected) return { type: "empty" }
    if (selected.item_kind !== "Editor") return { type: "unavailable" }
    if (selected.editor_id === null || !selected.buffer_path) return { type: "empty" }
    const ranges = db.query<{ start: number; end: number }, [number, number]>("select start, end from editor_selections where editor_id = ? and workspace_id = ?").all(selected.editor_id, selected.workspace_id)
    if (!ranges.length || ranges.some((range) => !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < 0)) return { type: "unavailable" }
    const contents = db.query<{ contents: string | null }, [number, number]>("select contents from editors where item_id = ? and workspace_id = ?").get(selected.editor_id, selected.workspace_id)?.contents
    if (contents === null || contents === undefined) {
      if ((await fs.stat(selected.buffer_path)).size > 8 * 1024 * 1024) return { type: "unavailable" }
    }
    const text = contents ?? await fs.readFile(selected.buffer_path, "utf8")
    if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) return { type: "unavailable" }
    return { type: "selection", selection: { filePath: selected.buffer_path, source: "zed", ranges: ranges.map((range) => ({ start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) })).sort((a, b) => a.start - b.start || a.end - b.end).map((range) => {
      const start = stringOffset(text, range.start)
      const end = stringOffset(text, range.end)
      return { text: text.slice(start, end), selection: { start: position(text, start), end: position(text, end) } }
    }) } }
  } catch { return { type: "unavailable" } }
  finally { db?.close() }
}
