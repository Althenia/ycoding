export type DiffLine =
  | { readonly kind: "hunk"; readonly text: string }
  | { readonly kind: "context" | "added" | "removed"; readonly text: string; readonly oldNumber?: number; readonly newNumber?: number }

export type DiffCell = { readonly kind: "context" | "added" | "removed"; readonly number: number; readonly text: string }

type SplitDiffRow =
  | { readonly kind: "hunk"; readonly text: string }
  | { readonly kind: "line"; readonly old?: DiffCell; readonly new?: DiffCell }

export type ParsedDiff = { readonly unified: readonly DiffLine[]; readonly split: readonly SplitDiffRow[] }

export function parseUnifiedPatch(patch: string): ParsedDiff | undefined {
  const lines = patch.replaceAll("\r\n", "\n").split("\n")
  const unified: DiffLine[] = []
  const split: SplitDiffRow[] = []
  const removed: DiffCell[] = []
  const added: DiffCell[] = []
  let oldNumber = 0
  let newNumber = 0
  let oldExpected = 0
  let newExpected = 0
  let oldConsumed = 0
  let newConsumed = 0
  let inHunk = false

  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      split.push({ kind: "line", ...(removed[index] ? { old: removed[index] } : {}), ...(added[index] ? { new: added[index] } : {}) })
    }
    removed.length = 0
    added.length = 0
  }
  const complete = () => {
    flush()
    return oldConsumed === oldExpected && newConsumed === newExpected
  }

  for (const [index, line] of lines.entries()) {
    if (line.startsWith("@@")) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!header || inHunk && !complete()) return undefined
      oldNumber = Number(header[1])
      newNumber = Number(header[3])
      oldExpected = header[2] === undefined ? 1 : Number(header[2])
      newExpected = header[4] === undefined ? 1 : Number(header[4])
      if (![oldNumber, newNumber, oldExpected, newExpected].every(Number.isSafeInteger)) return undefined
      oldConsumed = 0
      newConsumed = 0
      inHunk = true
      unified.push({ kind: "hunk", text: line })
      split.push({ kind: "hunk", text: line })
      continue
    }
    if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") && oldConsumed === oldExpected && newConsumed === newExpected ||
      line.startsWith("+++ ") && oldConsumed === oldExpected && newConsumed === newExpected) {
      if (inHunk && !complete()) return undefined
      inHunk = false
      continue
    }
    if (!inHunk) continue
    if (line === "\\ No newline at end of file") continue
    if (line.startsWith(" ")) {
      flush()
      unified.push({ kind: "context", text: line.slice(1), oldNumber, newNumber })
      split.push({ kind: "line", old: { kind: "context", number: oldNumber, text: line.slice(1) }, new: { kind: "context", number: newNumber, text: line.slice(1) } })
      oldNumber++
      newNumber++
      oldConsumed++
      newConsumed++
      continue
    }
    if (line.startsWith("-")) {
      unified.push({ kind: "removed", text: line.slice(1), oldNumber })
      removed.push({ kind: "removed", number: oldNumber++, text: line.slice(1) })
      oldConsumed++
      continue
    }
    if (line.startsWith("+")) {
      unified.push({ kind: "added", text: line.slice(1), newNumber })
      added.push({ kind: "added", number: newNumber++, text: line.slice(1) })
      newConsumed++
      continue
    }
    if (line === "" && index === lines.length - 1) continue
    return undefined
  }
  if (!inHunk || !complete()) return undefined
  return { unified, split }
}

export function summarizeFileChanges(files: readonly { readonly additions: number; readonly deletions: number }[]) {
  return {
    files: files.length,
    additions: files.reduce((total, file) => total + (Number.isSafeInteger(file.additions) && file.additions > 0 ? file.additions : 0), 0),
    deletions: files.reduce((total, file) => total + (Number.isSafeInteger(file.deletions) && file.deletions > 0 ? file.deletions : 0), 0),
  }
}

export function filePathParts(path: string) {
  const boundary = path.lastIndexOf("/") + 1
  return { directory: path.slice(0, boundary), basename: path.slice(boundary) }
}
