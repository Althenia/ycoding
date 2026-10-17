import type { SessionInfo, SessionMessageInfo, ShellInfo } from "@ycoding-ai/client"

export function isCompactionCheckpoint(message: SessionMessageInfo) {
  return message.type === "synthetic" && message.metadata?.compactionCheckpoint !== undefined
}

export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

type BtwSessionApi = {
  create(input: {
    parentID: string
    agent: string
    model?: { providerID: string; id: string; variant?: string }
  }): Promise<SessionInfo>
  synthetic(input: {
    sessionID: string
    text: string
    description: string
    delivery: "steer"
    resume: false
  }): Promise<unknown>
  prompt(input: { id?: string; sessionID: string; text: string; delivery?: "steer" }): Promise<unknown>
}

function rawParentSlice(messages: readonly SessionMessageInfo[]): string {
  const recent = messages
    .flatMap((message) => {
      if (message.type === "user") return [{ role: "User", text: message.text }]
      if (message.type === "synthetic") return [{ role: "Context", text: message.text }]
      if (message.type !== "assistant") return []
      return message.content
        .filter((part) => part.type === "text")
        .map((part) => ({ role: "Assistant", text: part.text }))
    })
    .slice(-12)
  return ["Recent parent session history (latest projected window):", ...recent.map((item) => `${item.role}:\n${item.text}`)].join("\n\n")
}

export async function openBtwSession(input: {
  api: BtwSessionApi
  parentID: string
  messages: readonly SessionMessageInfo[]
  model?: { providerID: string; id: string; variant?: string }
  text?: string
}) {
  const session = await input.api.create({
    parentID: input.parentID,
    agent: "btw",
    ...(input.model ? { model: input.model } : {}),
  })
  await input.api.synthetic({
    sessionID: session.id,
    text: rawParentSlice(input.messages),
    description: "Parent session history snapshot",
    delivery: "steer",
    resume: false,
  })
  if (input.text?.trim()) await input.api.prompt({ sessionID: session.id, text: input.text })
  return session
}

export async function steerBtwConclusion(input: {
  api: Pick<BtwSessionApi, "prompt">
  id: string
  parentID: string
  text: string
}) {
  await input.api.prompt({ id: input.id, sessionID: input.parentID, text: input.text, delivery: "steer" })
}

export type SessionShellGroup = {
  owner: { label: string }
  shells: ShellInfo[]
}

export function groupSessionShells(
  shells: readonly ShellInfo[],
  sessions: readonly SessionInfo[],
  currentSessionID: string,
  options?: { includeSettled?: boolean },
): SessionShellGroup[] {
  const rootID = familyRootID(sessions, currentSessionID)
  if (rootID === undefined) return []
  const descendantIDs = childSessionIDs(sessions, rootID)
  const ownerIDs = new Set([rootID, ...descendantIDs])
  const visible = shells.filter((shell) => {
    if (!options?.includeSettled && shell.status !== "running") return false
    const sessionID = shell.metadata.sessionID
    return typeof sessionID === "string" && ownerIDs.has(sessionID)
  })
  return [rootID, ...descendantIDs].flatMap((sessionID) => {
    const owned = visible.filter((shell) => shell.metadata.sessionID === sessionID)
    if (!owned.length) return []
    const owner = sessions.find((session) => session.id === sessionID)
    const label = sessionID === rootID ? "Main chat" : `${owner?.agent === "btw" ? "BTW" : owner?.agent ?? "Subagent"} · ${owner?.title ?? ""}`
    return [{ owner: { label }, shells: owned }]
  })
}

export function sessionShellFamily(sessions: readonly SessionInfo[], sessionID: string): SessionInfo[] {
  const rootID = familyRootID(sessions, sessionID)
  if (rootID === undefined) return []
  const ids = new Set([rootID, ...childSessionIDs(sessions, rootID)])
  return sessions.filter((session) => ids.has(session.id))
}

function familyRootID(sessions: readonly SessionInfo[], sessionID: string): string | undefined {
  if (!sessions.some((session) => session.id === sessionID)) return undefined
  let rootID = sessionID
  const seen = new Set([sessionID])
  let parentID = sessions.find((session) => session.id === rootID)?.parentID
  while (parentID) {
    if (seen.has(parentID) || !sessions.some((session) => session.id === parentID)) return undefined
    seen.add(parentID)
    rootID = parentID
    parentID = sessions.find((session) => session.id === rootID)?.parentID
  }
  return rootID
}

function childSessionIDs(sessions: readonly SessionInfo[], parentID: string): string[] {
  return sessions
    .filter((session) => session.parentID === parentID)
    .flatMap((session) => [session.id, ...childSessionIDs(sessions, session.id)])
}
