import type { SessionInfo, SessionListInput } from "@ycoding-ai/client"
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { isBackgroundSession } from "./session"

export type ScopeLocation = {
  readonly directory: string
  readonly project: {
    readonly id: string
    readonly directory: string
  }
}

export type RecentSessionScope =
  | {
      readonly kind: "git"
      readonly directory: string
      readonly canonicalDirectory: string
      readonly projectID: string
      readonly projectDirectory: string
      readonly commonDirectory: string
    }
  | {
      readonly kind: "project"
      readonly directory: string
      readonly canonicalDirectory: string
      readonly projectID: string
      readonly projectDirectory: string
    }
  | {
      readonly kind: "directory"
      readonly directory: string
      readonly canonicalDirectory: string
    }

const MAX_SCOPED_PAGES = 5
const MAX_WORKTREE_QUERIES = 16

function safeStat(target: string) {
  try {
    return statSync(target)
  } catch {
    return undefined
  }
}

function safeReadText(target: string) {
  try {
    return readFileSync(target, "utf8")
  } catch {
    return undefined
  }
}

function safeReadDir(target: string) {
  try {
    return readdirSync(target)
  } catch {
    return undefined
  }
}

export function canonicalDirectory(directory: string): string {
  const resolved = path.resolve(directory)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function resolveCommonFromGitDir(gitDir: string): string {
  const commonFile = path.join(gitDir, "commondir")
  const stat = safeStat(commonFile)
  if (stat?.isFile()) {
    const target = safeReadText(commonFile)?.trim()
    if (target) return canonicalDirectory(path.resolve(gitDir, target))
  }
  return canonicalDirectory(gitDir)
}

export function resolveGitCommonDirectory(
  directory: string,
  cache?: Map<string, string | null>,
): string | undefined {
  const start = canonicalDirectory(directory)
  if (cache?.has(start)) return cache.get(start) ?? undefined

  let current = start
  while (true) {
    const dotGit = path.join(current, ".git")
    const stat = safeStat(dotGit)
    if (stat?.isDirectory()) {
      const common = resolveCommonFromGitDir(dotGit)
      cache?.set(start, common)
      return common
    }
    if (stat?.isFile()) {
      const text = safeReadText(dotGit)
      const match = text?.match(/^gitdir:\s*(.+)$/m)
      if (match?.[1]) {
        const gitDir = path.resolve(current, match[1].trim())
        const common = resolveCommonFromGitDir(gitDir)
        cache?.set(start, common)
        return common
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  cache?.set(start, null)
  return undefined
}

export function discoverGitWorktrees(commonDirectory: string, rawDirectory?: string): string[] {
  const canonicals = new Set<string>()
  if (path.basename(commonDirectory) === ".git") {
    canonicals.add(canonicalDirectory(path.dirname(commonDirectory)))
  }
  const worktreesDir = path.join(commonDirectory, "worktrees")
  for (const entry of safeReadDir(worktreesDir) ?? []) {
    const entryDir = path.join(worktreesDir, entry)
    const gitdirText = safeReadText(path.join(entryDir, "gitdir"))?.trim()
    if (!gitdirText) continue
    canonicals.add(canonicalDirectory(path.dirname(path.resolve(entryDir, gitdirText))))
  }

  const rawResolved = rawDirectory ? path.resolve(rawDirectory) : undefined
  const canonicalResolved = rawResolved ? canonicalDirectory(rawResolved) : undefined
  const aliasPrefix =
    rawResolved &&
    canonicalResolved &&
    canonicalResolved.length > rawResolved.length &&
    canonicalResolved.endsWith(rawResolved)
      ? canonicalResolved.slice(0, canonicalResolved.length - rawResolved.length)
      : undefined

  return [...canonicals].map((dir) =>
    aliasPrefix && dir.startsWith(`${aliasPrefix}${path.sep}`) ? dir.slice(aliasPrefix.length) : dir,
  )
}

export function resolveRecentSessionScope(
  location: ScopeLocation,
  cache?: Map<string, string | null>,
): RecentSessionScope {
  const canonical = canonicalDirectory(location.directory)
  const commonDirectory = resolveGitCommonDirectory(location.directory, cache)
  if (commonDirectory !== undefined) {
    return {
      kind: "git",
      directory: location.directory,
      canonicalDirectory: canonical,
      projectID: location.project.id,
      projectDirectory: location.project.directory,
      commonDirectory,
    }
  }
  if (location.project.id === "global") {
    return {
      kind: "directory",
      directory: location.directory,
      canonicalDirectory: canonical,
    }
  }
  return {
    kind: "project",
    directory: location.directory,
    canonicalDirectory: canonical,
    projectID: location.project.id,
    projectDirectory: location.project.directory,
  }
}

export function recentSessionScopeKey(scope: RecentSessionScope | undefined): string | undefined {
  if (!scope) return undefined
  if (scope.kind === "git") return `git:${scope.commonDirectory}:${scope.projectID}`
  if (scope.kind === "directory") return `dir:${scope.canonicalDirectory}`
  return `project:${scope.projectID}`
}

export function scopeHintDirectory(scope: RecentSessionScope): string {
  if (scope.kind === "directory") return scope.directory
  return scope.projectDirectory
}

export function matchesRecentSessionScope(
  scope: RecentSessionScope,
  session: Pick<SessionInfo, "projectID" | "location">,
  cache?: Map<string, string | null>,
): boolean {
  if (scope.kind === "git") {
    return resolveGitCommonDirectory(session.location.directory, cache) === scope.commonDirectory
  }
  if (scope.kind === "directory") {
    return canonicalDirectory(session.location.directory) === scope.canonicalDirectory
  }
  return session.projectID === scope.projectID
}

export async function listScopedRecentSessions(input: {
  list: (
    query: SessionListInput,
    options?: { signal?: AbortSignal },
  ) => Promise<{ readonly data: readonly SessionInfo[]; readonly cursor: { readonly next?: string | null } }>
  scope: RecentSessionScope
  search?: string
  limit?: number
  signal?: AbortSignal
  cache?: Map<string, string | null>
}): Promise<SessionInfo[]> {
  const limit = input.limit ?? 50
  const base = {
    pinned: false as const,
    ...(input.search === undefined ? {} : { search: input.search }),
    parentID: null,
    background: "exclude" as const,
    limit,
    order: "desc" as const,
  }
  const accept = (session: SessionInfo) =>
    !session.parentID && !isBackgroundSession(session) && matchesRecentSessionScope(input.scope, session, input.cache)

  if (input.scope.kind === "directory") {
    const page = await input.list({ ...base, directory: input.scope.directory }, { signal: input.signal })
    return page.data.filter(accept).toSorted((a, b) => b.time.updated - a.time.updated).slice(0, limit)
  }

  if (input.scope.kind === "project") {
    const page = await input.list({ ...base, project: input.scope.projectID }, { signal: input.signal })
    return page.data.filter(accept).toSorted((a, b) => b.time.updated - a.time.updated).slice(0, limit)
  }

  const byID = new Map<string, SessionInfo>()
  const add = (rows: readonly SessionInfo[]) => {
    let matched = 0
    for (const session of rows) {
      if (!accept(session)) continue
      matched++
      byID.set(session.id, session)
    }
    return matched
  }

  const fetchProject = async () => {
    if (input.scope.kind !== "git" || input.scope.projectID === "global") return
    let cursor: string | undefined
    for (let pageIndex = 0; pageIndex < MAX_SCOPED_PAGES; pageIndex++) {
      const page = await input.list(
        {
          ...base,
          project: input.scope.projectID,
          ...(cursor === undefined ? {} : { cursor }),
        },
        { signal: input.signal },
      )
      const matched = add(page.data)
      cursor = page.cursor.next ?? undefined
      if (!cursor || byID.size >= limit || matched === page.data.length) break
    }
  }

  const worktrees = discoverGitWorktrees(input.scope.commonDirectory, input.scope.directory)
  const directoryTargets =
    input.scope.projectID === "global"
      ? [...new Set([input.scope.directory, ...worktrees])].slice(0, MAX_WORKTREE_QUERIES)
      : worktrees.length > 1
        ? worktrees.slice(0, MAX_WORKTREE_QUERIES)
        : []

  await Promise.all([
    fetchProject(),
    ...directoryTargets.map(async (directory) => {
      const page = await input.list({ ...base, directory }, { signal: input.signal })
      add(page.data)
    }),
  ])

  return [...byID.values()].toSorted((a, b) => b.time.updated - a.time.updated).slice(0, limit)
}
