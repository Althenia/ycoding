import type { SessionInfoView, TeamTaskView } from "../store"

export type TeamSubagent = TeamTaskView & {
  readonly startedAt?: number
  readonly question?: { readonly id: string; readonly text: string }
  readonly cacheHitRatio?: number
}

export type TeamShell = {
  readonly id: string
  readonly ownerID: string
  readonly command: string
  readonly status: "running" | "exited" | "timeout" | "memory-limit" | "killed"
  readonly startedAt: number
  readonly completedAt?: number
}

export type TeamSideChat = {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
}

export type TeamPanelData = {
  readonly rootID: string
  readonly status: "loading" | "ready" | "unsupported" | "error"
  readonly tasks: readonly TeamSubagent[]
  readonly total?: number
  readonly activeTotal?: number
  readonly next?: string
  readonly pageLoading: boolean
  readonly shells: readonly TeamShell[]
  readonly shellTruncated?: boolean
  readonly shellStatus: "loading" | "ready" | "unsupported" | "error"
  readonly sideChats: readonly TeamSideChat[]
  readonly sideChatStatus: "loading" | "ready" | "unsupported" | "error"
  readonly sideChatNext?: string
  readonly sideChatLoading: boolean
}

export type TeamActionOutcome = { readonly status: "ok" } | { readonly status: "failed" | "unknown"; readonly message: string }

export type TeamShellOutput = { readonly text: string; readonly cursor: number; readonly size: number; readonly truncated: boolean }

const rank: Readonly<Record<TeamSubagent["state"], number>> = {
  waiting: 0, starting: 1, running: 1, cancelling: 2, completed: 3, cancelled: 4, failed: 5, lost: 6,
}

export function isManagedSubagent(session: Pick<SessionInfoView, "parentID" | "agent"> | undefined): boolean {
  return session?.parentID !== undefined && session.agent !== "btw"
}

export function canCancelSubagent(state: TeamSubagent["state"]): boolean {
  return state === "starting" || state === "running" || state === "waiting"
}

export function teamActiveCount(data: Pick<TeamPanelData, "activeTotal" | "tasks">): number {
  return data.activeTotal ?? data.tasks.filter((entry) => isActiveSubagent(entry.state)).length
}

export function isActiveSubagent(state: TeamSubagent["state"]): boolean {
  return canCancelSubagent(state) || state === "cancelling"
}

export function taskRows(tasks: readonly TeamSubagent[]): readonly string[] {
  const ordered = [...tasks].sort((left, right) => rank[left.state] - rank[right.state] || right.updatedAt - left.updatedAt || left.sessionID.localeCompare(right.sessionID))
  const active = ordered.filter((item) => isActiveSubagent(item.state))
  const inactive = ordered.filter((item) => !isActiveSubagent(item.state))
  return [
    ...(active.length ? ["section:active", ...active.map((item) => item.sessionID)] : []),
    ...(inactive.length ? ["section:inactive", ...inactive.map((item) => item.sessionID)] : []),
  ]
}

export function siblingTargets(tasks: readonly TeamSubagent[], currentID: string) {
  const rows = taskRows(tasks).filter((id) => !id.startsWith("section:"))
  const index = rows.indexOf(currentID)
  return { previous: index > 0 ? rows[index - 1] : undefined, next: index >= 0 ? rows[index + 1] : undefined }
}

export function shellRows(shells: readonly TeamShell[]): readonly string[] {
  return [...new Set(shells.map((shell) => shell.ownerID))].flatMap((ownerID) => [
    `owner:${ownerID}`, ...shells.filter((shell) => shell.ownerID === ownerID).map((shell) => shell.id),
  ])
}

export function formatCacheHit(ratio: number | undefined): string {
  return ratio === undefined || !Number.isFinite(ratio) || ratio < 0 || ratio > 1 ? "—" : `${Math.round(ratio * 100)}% hit`
}

export function formatElapsed(startedAt: number | undefined, endedAt: number): string {
  if (startedAt === undefined) return "—"
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000))
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds % 3_600 / 60)}m`
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${seconds}s`
}
