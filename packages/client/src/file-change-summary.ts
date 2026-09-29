type CapturePart = {
  readonly type: string
  readonly id?: string
  readonly name?: string
  readonly state?: { readonly status?: string; readonly input?: unknown; readonly structured?: unknown }
}

type CaptureMessage = {
  readonly id: string
  readonly type: string
  readonly time?: { readonly created?: number; readonly completed?: number }
  readonly metadata?: { readonly [key: string]: unknown }
  readonly content?: readonly CapturePart[]
}

export type CapturedPatch = { readonly diff: string; readonly path: string; readonly additions: number; readonly deletions: number; readonly status: "created" | "deleted" | "modified" }
export type CapturedFile = { path: string; additions: number; deletions: number; status: CapturedPatch["status"]; files: CapturedPatch[] }
export type CapturedUnit = { readonly placementMessageID: string; readonly assistantMessageIDs: string[]; readonly files: CapturedFile[] }

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

export function capturedPartPatches(part: CapturePart): CapturedPatch[] {
  if (part.type !== "tool" || part.state?.status !== "completed" || !["edit", "patch", "apply_patch"].includes(part.name ?? "")) return []
  const structured = part.state.structured
  if (!structured || typeof structured !== "object" || !("files" in structured) || !Array.isArray(structured.files)) return []
  return structured.files.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("patch" in entry) || typeof entry.patch !== "string") return []
    const patch = capturedPatch(entry.patch, "file" in entry && typeof entry.file === "string" ? entry.file : undefined,
      "status" in entry && typeof entry.status === "string" ? entry.status : undefined)
    return patch ? [patch] : []
  })
}

function messagePatches(messages: readonly CaptureMessage[]) {
  return messages.flatMap((message) => message.type === "assistant" ? (message.content ?? []).flatMap(capturedPartPatches) : [])
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

type Dispatch =
  | { readonly kind: "launch"; readonly childID: string }
  | { readonly kind: "send"; readonly childID: string; readonly callID: string }
  | { readonly kind: "answer"; readonly childID: string; readonly questionID?: string }

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

function dispatchOf(part: CapturePart): Dispatch | undefined {
  if (part.type !== "tool") return undefined
  const structured = record(part.state?.structured)
  if (part.name === "subagent") return typeof structured?.sessionID === "string" ? { kind: "launch", childID: structured.sessionID } : undefined
  if (part.name !== "subagent_control" || part.state?.status !== "completed") return undefined
  const childID = record(structured?.task)?.sessionID
  if (typeof childID !== "string") return undefined
  if (structured?.action === "send" && typeof part.id === "string") return { kind: "send", childID, callID: part.id }
  if (structured?.action !== "answer") return undefined
  const questionID = record(part.state.input)?.questionID
  return { kind: "answer", childID, ...(typeof questionID === "string" ? { questionID } : {}) }
}

function assistantDispatches(messages: readonly CaptureMessage[]) {
  return messages.flatMap((message) => message.type !== "assistant" ? [] : (message.content ?? []).flatMap((part) => {
    const dispatch = dispatchOf(part)
    return dispatch ? [{ assistantMessageID: message.id, dispatch }] : []
  }))
}

export function capturedChildSessionIDs(parent: readonly CaptureMessage[]): string[] {
  return [...new Set(assistantDispatches(parent).map((item) => item.dispatch.childID))]
}

function boundaryIndex(child: readonly CaptureMessage[], dispatch: Dispatch, assistantMessageID: string, sendMessageID: (assistantMessageID: string, callID: string) => string) {
  if (dispatch.kind === "launch") return child.findIndex((message) => message.type === "user")
  if (dispatch.kind === "send") {
    const id = sendMessageID(assistantMessageID, dispatch.callID)
    return child.findIndex((message) => message.id === id)
  }
  const questionID = dispatch.questionID
  if (questionID === undefined) return -1
  return child.findIndex((message) => message.type === "synthetic" && message.metadata?.kind === "answer" && message.metadata.questionID === questionID)
}

function childInput(message: CaptureMessage) {
  return message.type === "user" || message.type === "synthetic" && message.metadata?.kind === "answer"
}

export function summarizeCapturedChanges(
  parent: readonly CaptureMessage[],
  children: ReadonlyMap<string, readonly CaptureMessage[]>,
  sendMessageID: (assistantMessageID: string, callID: string) => string,
): CapturedUnit[] {
  const units = parent.reduce<CaptureMessage[][]>((groups, message) => {
    if (message.type === "user" || groups.length === 0) groups.push([message])
    else groups.at(-1)!.push(message)
    return groups
  }, [])
  const claims = units.flatMap((messages, unitIndex) => assistantDispatches(messages).flatMap((item) => {
    const child = children.get(item.dispatch.childID)
    const index = child ? boundaryIndex(child, item.dispatch, item.assistantMessageID, sendMessageID) : -1
    return index < 0 ? [] : [{ unitIndex, childID: item.dispatch.childID, index }]
  })).filter((claim, position, all) => all.findIndex((other) => other.childID === claim.childID && other.index === claim.index) === position)
  const childPatches = claims.map((claim) => {
    const child = children.get(claim.childID)!
    const next = child.findIndex((message, index) => index > claim.index && (childInput(message) || claims.some((other) => other.childID === claim.childID && other.index === index)))
    return { unitIndex: claim.unitIndex, patches: messagePatches(child.slice(claim.index, next < 0 ? child.length : next)) }
  })
  return units.flatMap((messages, unitIndex) => {
    const assistants = messages.filter((message) => message.type === "assistant")
    const files = groupCapturedPatches([...messagePatches(messages), ...childPatches.filter((claim) => claim.unitIndex === unitIndex).flatMap((claim) => claim.patches)])
    return assistants.length && files.length ? [{ placementMessageID: assistants.at(-1)!.id, assistantMessageIDs: assistants.map((message) => message.id), files }] : []
  })
}
