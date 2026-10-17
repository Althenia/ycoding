import type { SessionInfoView, TeamTaskView } from "../store"
import { accountingPresentation, costText } from "./usage-accounting"
import { tokenCount } from "./usage-model"

export type TeamSubagent = TeamTaskView & {
  readonly startedAt?: number
  readonly question?: { readonly id: string; readonly text: string; readonly deferred?: true }
  readonly cacheHitRatio?: number
}

export type TeamShell = {
  readonly id: string
  readonly ownerID: string
  readonly ownerAgent?: string
  readonly ownerTitle?: string
  readonly command: string
  readonly status: "queued" | "running" | "exited" | "timeout" | "memory-limit" | "killed"
  readonly queuePosition?: number
  readonly startedAt: number
  readonly completedAt?: number
}

export const TEAM_SHELL_OUTPUT_TAIL_LIMIT = 256 * 1024

export function appendTeamShellOutput(current: string, page: string, limit: number = TEAM_SHELL_OUTPUT_TAIL_LIMIT): string {
  const text = current + page
  if (text.length <= limit) return text
  const tail = text.slice(-limit)
  const newline = tail.indexOf("\n")
  return newline > 0 && newline < limit / 2 ? tail.slice(newline + 1) : tail
}

export function shellOwnerLabel(
  shell: TeamShell,
  family: {
    readonly rootID: string
    readonly tasks: readonly TeamSubagent[]
    readonly sideChats: readonly TeamSideChat[]
  },
): string {
  if (shell.ownerID === family.rootID) return "Main session"
  const owner = family.tasks.find((task) => task.sessionID === shell.ownerID)
  if (owner) return `${owner.agent ?? "Subagent"} · ${owner.description}`
  const chat = family.sideChats.find((item) => item.id === shell.ownerID)
  if (chat) return `Side chat · ${chat.title}`
  return shell.ownerTitle ? `${shell.ownerAgent ?? "Subagent"} · ${shell.ownerTitle}` : shell.ownerAgent ?? "Subagent"
}

type TeamSideChat = {
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
  readonly refreshing?: boolean
  readonly economicsLoading?: boolean
  readonly economicsUnsupported?: boolean
  readonly shells: readonly TeamShell[]
  readonly shellTruncated?: boolean
  readonly shellStatus: "loading" | "ready" | "unsupported" | "error"
  readonly sideChats: readonly TeamSideChat[]
  readonly sideChatStatus: "loading" | "ready" | "unsupported" | "error"
  readonly sideChatNext?: string
  readonly sideChatLoading: boolean
}

export type TeamActionOutcome = { readonly status: "ok" } | { readonly status: "failed" | "unknown"; readonly message: string }

export type TeamShellOutput = { readonly command?: string; readonly status?: string; readonly text: string; readonly cursor: number; readonly size: number; readonly truncated: boolean }

export function teamShellCommand(shell: Pick<TeamShell, "command">, output?: Pick<TeamShellOutput, "command">): string {
  return output?.command ?? shell.command
}

const rank: Readonly<Record<TeamSubagent["state"], number>> = {
  waiting: 0, starting: 1, running: 1, cancelling: 2, completed: 3, cancelled: 4, failed: 5, lost: 6,
}

export function isManagedSubagent(session: Pick<SessionInfoView, "parentID" | "agent"> | undefined): boolean {
  return session?.parentID !== undefined && session.agent !== "btw"
}

export const taskStateLabel = (task: Pick<TeamSubagent, "state" | "stoppedRecovery">) => task.stoppedRecovery === undefined ? task.state : "stopped"

export const canContinueRecovery = (task: Pick<TeamSubagent, "stoppedRecovery">) => task.stoppedRecovery !== undefined

export const isDeferredQuestion = (task: Pick<TeamSubagent, "question">) => task.question?.deferred === true

export const canAnswerSubagent = (task: Pick<TeamSubagent, "state" | "question">) => task.question !== undefined && task.state === "waiting" && !isDeferredQuestion(task)

export function canCancelSubagent(state: TeamSubagent["state"]): boolean {
  return state === "starting" || state === "running" || state === "waiting"
}

export function pinAction(task: TeamSubagent) {
  const pinned = task.pinnedAt !== undefined
  return { pinned, action: pinned ? "unpin" : "pin", label: `${pinned ? "Unpin" : "Pin"} ${task.description}`, title: pinned ? "Unpin" : "Pin" }
}

export function teamActiveCount(data: Pick<TeamPanelData, "status" | "activeTotal" | "tasks" | "shells" | "shellStatus">): number | undefined {
  if (data.status !== "ready" || data.shellStatus !== "ready") return undefined
  return (data.activeTotal ?? data.tasks.filter((entry) => isActiveSubagent(entry.state)).length) + data.shells.filter((shell) => shell.status === "running").length
}

export function teamActivityLabel(data: Pick<TeamPanelData, "status" | "activeTotal" | "tasks" | "shells" | "shellStatus" | "next" | "shellTruncated">): string {
  const count = teamActiveCount(data)
  if (count === undefined) return "Activity unreported"
  return `${data.shellTruncated || data.activeTotal === undefined && data.next !== undefined ? "At least " : ""}${count} active`
}

export function isActiveSubagent(state: TeamSubagent["state"]): boolean {
  return canCancelSubagent(state) || state === "cancelling"
}

function recency(task: TeamSubagent): number {
  return isActiveSubagent(task.state) ? task.startedAt ?? 0 : task.updatedAt
}

export function taskRows(tasks: readonly TeamSubagent[]): readonly string[] {
  const ordered = [...tasks].sort((left, right) => {
    if (left.pinnedAt !== undefined || right.pinnedAt !== undefined) {
      if (left.pinnedAt === undefined) return 1
      if (right.pinnedAt === undefined) return -1
      return left.pinnedAt - right.pinnedAt || left.sessionID.localeCompare(right.sessionID)
    }
    return rank[left.state] - rank[right.state] || recency(right) - recency(left) || left.sessionID.localeCompare(right.sessionID)
  })
  const pinned = ordered.filter((item) => item.pinnedAt !== undefined)
  const unpinned = ordered.filter((item) => item.pinnedAt === undefined)
  const active = unpinned.filter((item) => isActiveSubagent(item.state))
  const inactive = unpinned.filter((item) => !isActiveSubagent(item.state))
  return [
    ...(pinned.length ? ["section:pinned", ...pinned.map((item) => item.sessionID)] : []),
    ...(active.length ? ["section:active", ...active.map((item) => item.sessionID)] : []),
    ...(inactive.length ? ["section:inactive", ...inactive.map((item) => item.sessionID)] : []),
  ]
}

export function siblingTargets(tasks: readonly TeamSubagent[], currentID: string) {
  const rows = taskRows(tasks).filter((id) => !id.startsWith("section:"))
  const index = rows.indexOf(currentID)
  return { previous: index > 0 ? rows[index - 1] : undefined, next: index >= 0 ? rows[index + 1] : undefined }
}

export function shellStatusLabel(shell: Pick<TeamShell, "status" | "queuePosition">): string {
  if (shell.status !== "queued") return shell.status
  return shell.queuePosition === undefined ? "queued" : `queued #${shell.queuePosition}`
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

export type UsageSlot = {
  readonly key: "tokens" | "cost" | "context" | "cache"
  readonly label: string
  readonly state: "value" | "loading" | "unreported" | "unsupported"
  readonly value: string
  readonly meter?: number
}

export function usageSlots(task: TeamSubagent, economics: { readonly loading?: boolean }): readonly UsageSlot[] {
  const slot = (key: UsageSlot["key"], label: string, value: string | undefined, meter?: number): UsageSlot =>
    value !== undefined
      ? { key, label, state: "value", value, ...(meter === undefined ? {} : { meter }) }
      : { key, label, state: economics.loading === true ? "loading" : "unreported", value: "—" }
  const context = task.contextTotal === undefined ? undefined
    : `${task.contextTotal.toLocaleString("en-US")} / ${task.contextLimit === undefined ? "unreported" : task.contextLimit.toLocaleString("en-US")}`
  const meter = task.contextTotal === undefined || task.contextLimit === undefined || task.contextLimit <= 0 ? undefined : Math.min(1, task.contextTotal / task.contextLimit)
  const cache = formatCacheHit(task.cacheHitRatio)
  return [
    slot(
      "tokens",
      "Tokens (inclusive)",
      task.accounting === undefined ? undefined : tokenCount(task.accounting.total.tokens).toLocaleString("en-US"),
    ),
    slot(
      "cost",
      "Cost (inclusive)",
      task.accounting?.total.cost.known === undefined
        ? undefined
        : `${costText(task.accounting.total.cost)}${task.accounting.status === "so-far" ? " · so far" : ""}${accountingPresentation(task.accounting, task.accountingUnavailable).complete ? "" : " · incomplete"}`,
    ),
    slot("context", "Context", context, meter),
    slot("cache", "Cache", task.cacheHitRatio === undefined || cache === "—" ? undefined : cache),
  ]
}
