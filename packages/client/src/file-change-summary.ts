type CaptureMessage = {
  readonly id: string
  readonly type: string
  readonly time?: { readonly created?: number; readonly completed?: number }
  readonly content?: readonly { readonly type: string; readonly name?: string; readonly state?: { readonly status?: string; readonly structured?: unknown } }[]
  readonly status?: string
  readonly boundary?: { readonly messageID: string }
}

type LedgerChange = { readonly path: string; readonly patch: string; readonly additions: number; readonly deletions: number }

export type CapturedPatch = { readonly diff: string; readonly path: string; readonly additions: number; readonly deletions: number; readonly status: "created" | "deleted" | "modified" }
export type CapturedFile = { path: string; additions: number; deletions: number; status: CapturedPatch["status"]; files: CapturedPatch[] }
export type CapturedSummary = { readonly mode: "none" | "transcript" | "recovery"; readonly placementMessageID?: string; readonly files: CapturedFile[] }

function patchFacts(diff: string) {
  let old = 0
  let next = 0
  let oldExpected = 0
  let nextExpected = 0
  let oldConsumed = 0
  let nextConsumed = 0
  let additions = 0
  let deletions = 0
  let hunk = false
  let found = false
  let oldPath: string | undefined
  let newPath: string | undefined
  const lines = diff.replaceAll("\r\n", "\n").split("\n")
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("--- ") && !hunk) { oldPath = line.slice(4).split("\t")[0]; continue }
    if (line.startsWith("+++ ") && !hunk) { newPath = line.slice(4).split("\t")[0]; continue }
    if (line.startsWith("@@")) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!header || hunk && (oldConsumed !== oldExpected || nextConsumed !== nextExpected)) return undefined
      old = Number(header[1]); next = Number(header[3])
      oldExpected = header[2] === undefined ? 1 : Number(header[2])
      nextExpected = header[4] === undefined ? 1 : Number(header[4])
      if (![old, next, oldExpected, nextExpected].every(Number.isSafeInteger)) return undefined
      oldConsumed = 0; nextConsumed = 0; hunk = true; found = true
      continue
    }
    if (hunk && oldConsumed === oldExpected && nextConsumed === nextExpected && (line.startsWith("diff --git ") || line.startsWith("Index: ") || line.startsWith("--- "))) {
      hunk = false
      if (line.startsWith("--- ")) oldPath = line.slice(4).split("\t")[0]
      continue
    }
    if (!hunk) continue
    if (line === "\\ No newline at end of file" || line === "" && index === lines.length - 1) continue
    if (line.startsWith(" ")) { oldConsumed++; nextConsumed++; continue }
    if (line.startsWith("-")) { oldConsumed++; deletions++; continue }
    if (line.startsWith("+")) { nextConsumed++; additions++; continue }
    return undefined
  }
  if (!found || hunk && (oldConsumed !== oldExpected || nextConsumed !== nextExpected)) return undefined
  return { additions, deletions, oldPath, newPath }
}

export function capturedPatch(diff: string, path?: string, status?: string): CapturedPatch | undefined {
  const facts = patchFacts(diff)
  if (!facts) return undefined
  const resolved = path ?? [facts.newPath, facts.oldPath].find((item) => item && item !== "/dev/null")?.replace(/^[ab]\//, "") ?? "unknown"
  const state = status === "added" || status === "created" || facts.oldPath === "/dev/null" ? "created"
    : status === "deleted" || status === "removed" || facts.newPath === "/dev/null" ? "deleted" : "modified"
  return { diff, path: resolved, additions: facts.additions, deletions: facts.deletions, status: state }
}

export function capturedToolPatches(messages: readonly CaptureMessage[]): CapturedPatch[] {
  return messages.flatMap((message) => message.type !== "assistant" ? [] : (message.content ?? []).flatMap((part) => {
    if (part.type !== "tool" || part.state?.status !== "completed" || !["edit", "patch", "apply_patch"].includes(part.name ?? "")) return []
    const structured = part.state.structured
    if (!structured || typeof structured !== "object" || !("files" in structured) || !Array.isArray(structured.files)) return []
    return structured.files.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("patch" in entry) || typeof entry.patch !== "string") return []
      const patch = capturedPatch(entry.patch, "file" in entry && typeof entry.file === "string" ? entry.file : undefined,
        "status" in entry && typeof entry.status === "string" ? entry.status : undefined)
      return patch ? [patch] : []
    })
  }))
}

export function groupCapturedPatches(files: readonly CapturedPatch[]): CapturedFile[] {
  const groups = new Map<string, CapturedFile>()
  for (const file of files) {
    const group = groups.get(file.path)
    if (group) {
      group.additions += file.additions
      group.deletions += file.deletions
      group.files.push(file)
      if (group.status !== file.status) group.status = "modified"
      continue
    }
    groups.set(file.path, { path: file.path, additions: file.additions, deletions: file.deletions, status: file.status, files: [file] })
  }
  return [...groups.values()]
}

export function residentCapturedMessages<T extends CaptureMessage>(messages: readonly T[]): T[] {
  const positions = new Map(messages.map((message, index) => [message.id, index]))
  const boundary = messages.reduce((latest, message) => {
    if (message.type !== "compaction" || message.status !== "completed" || !message.boundary) return latest
    return Math.max(latest, positions.get(message.boundary.messageID) ?? -1)
  }, -1)
  return boundary < 0 ? [...messages] : messages.filter((message, index) => index > boundary || message.type === "compaction")
}

export function summarizeCapturedChanges(parent: readonly CaptureMessage[], children: readonly (readonly CaptureMessage[])[], ledger: readonly LedgerChange[]): CapturedSummary {
  const assistant = parent.findLast((message) => message.type === "assistant" && message.time?.completed !== undefined)
  if (assistant) {
    const files = groupCapturedPatches(capturedToolPatches([...parent, ...children.flat()]))
    return files.length ? { mode: "transcript", placementMessageID: assistant.id, files } : { mode: "none", files: [] }
  }
  const compaction = parent.findLast((message) => message.type === "compaction" && message.status === "completed")
  if (!compaction) return { mode: "none", files: [] }
  const files = groupCapturedPatches(ledger.flatMap((entry) => {
    const patch = capturedPatch(entry.patch, entry.path)
    return patch ? [patch] : []
  }))
  return files.length ? { mode: "recovery", placementMessageID: compaction.id, files } : { mode: "none", files: [] }
}
