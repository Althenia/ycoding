import type { EditorSelection } from "./editor-integration"

export function editorSelectionKey(selection: EditorSelection) {
  return JSON.stringify([selection.filePath, ...selection.ranges.map((range) => [range.selection.start.line, range.selection.start.character, range.selection.end.line, range.selection.end.character, range.text])])
}

export function formatEditorContext(selection: EditorSelection) {
  const selected = selection.ranges.filter((range) => range.selection.start.line !== range.selection.end.line || range.selection.start.character !== range.selection.end.character)
  if (!selected.length) return `<system-reminder>Note: The user opened the file "${selection.filePath}". This may or may not be relevant to the current task.</system-reminder>\n`
  const ranges = selected.map((range, index) => {
    const label = range.selection.start.line === range.selection.end.line ? `#${range.selection.start.line}` : `#${range.selection.start.line}-${range.selection.end.line}`
    return `Note: The user selected ${selected.length > 1 ? `Selection ${index + 1}: ` : ""}${label} from "${selection.filePath}". \`\`\`${range.text}\`\`\`\n\n`
  })
  return `<system-reminder>${ranges.join("\n")} This may or may not be relevant to the current task.</system-reminder>\n`
}
