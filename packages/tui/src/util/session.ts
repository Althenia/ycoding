import type { SessionInfo, SessionMessageInfo, ShellInfo } from "@ycoding-ai/client"

export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

type BtwSessionApi = {
  create(input: {
    parentID: string
    agent: string
    model: { providerID: string; id: string; variant?: string }
  }): Promise<SessionInfo>
  synthetic(input: {
    sessionID: string
    text: string
    description: string
    delivery: "steer"
    resume: false
  }): Promise<unknown>
  prompt(input: { sessionID: string; text: string; delivery?: "steer" }): Promise<unknown>
}

export async function openBtwSession(input: {
  api: BtwSessionApi
  parentID: string
  messages: readonly SessionMessageInfo[]
  model: { providerID: string; id: string; variant?: string }
  text?: string
}) {
  const session = await input.api.create({ parentID: input.parentID, agent: "btw", model: input.model })
  const recent = input.messages
    .flatMap((message) => {
      if (message.type === "user") return [{ role: "User", text: message.text }]
      if (message.type === "synthetic") return [{ role: "Context", text: message.text }]
      if (message.type !== "assistant") return []
      return message.content
        .filter((part) => part.type === "text")
        .map((part) => ({ role: "Assistant", text: part.text }))
    })
    .slice(-12)
  await input.api.synthetic({
    sessionID: session.id,
    text: ["Recent parent session history:", ...recent.map((item) => `${item.role}:\n${item.text}`)].join("\n\n"),
    description: "Parent session history snapshot",
    delivery: "steer",
    resume: false,
  })
  if (input.text?.trim()) await input.api.prompt({ sessionID: session.id, text: input.text })
  return session
}

export async function steerBtwConclusion(input: {
  api: Pick<BtwSessionApi, "prompt">
  parentID: string
  text: string
}) {
  await input.api.prompt({ sessionID: input.parentID, text: input.text, delivery: "steer" })
}

export type SessionShellGroup = {
  owner: { label: string }
  shells: ShellInfo[]
}

export function groupSessionShells(
  shells: readonly ShellInfo[],
  sessions: readonly SessionInfo[],
  currentSessionID: string,
): SessionShellGroup[] {
  const descendantIDs = childSessionIDs(sessions, currentSessionID)
  const ownerIDs = new Set([currentSessionID, ...descendantIDs])
  const visible = shells.filter((shell) => {
    if (shell.status !== "running") return false
    const sessionID = shell.metadata.sessionID
    if (typeof sessionID !== "string") return true
    const owner = sessions.find((session) => session.id === sessionID)
    if (!owner) return true
    return ownerIDs.has(owner.id)
  })
  const groups = [currentSessionID, ...descendantIDs].flatMap((sessionID) => {
    const owned = visible.filter((shell) => shell.metadata.sessionID === sessionID)
    if (!owned.length) return []
    const owner = sessions.find((session) => session.id === sessionID)
    const label = sessionID === currentSessionID ? "Main chat" : `${owner?.agent ?? "Subagent"} · ${owner?.title ?? ""}`
    return [{ owner: { label }, shells: owned }]
  })
  const unknown = visible.filter((shell) => {
    const sessionID = shell.metadata.sessionID
    if (typeof sessionID !== "string") return true
    return !sessions.some((session) => session.id === sessionID)
  })
  if (!unknown.length) return groups
  return [...groups, { owner: { label: "Unknown session" }, shells: unknown }]
}

function childSessionIDs(sessions: readonly SessionInfo[], parentID: string): string[] {
  return sessions
    .filter((session) => session.parentID === parentID)
    .flatMap((session) => [session.id, ...childSessionIDs(sessions, session.id)])
}
