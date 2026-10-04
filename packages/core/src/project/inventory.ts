export * as ProjectInventory from "./inventory"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Project } from "@ycoding-ai/schema/project"
import { Event } from "@ycoding-ai/schema/project-directories"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import { FSUtil } from "../fs-util"
import { AbsolutePath } from "../schema"
import { Session } from "../session"
import { SessionTable } from "../session/sql"
import { ProjectDirectories } from "./directories"
import { ProjectDirectoryTable, ProjectTable } from "./sql"

export type Entry = Project.InventoryEntry
export type Anchor = Project.InventoryAnchor

export interface ListInput {
  readonly limit: number
  readonly search?: string
  readonly after?: Anchor
}

export interface Interface {
  readonly list: (input: ListInput) => Effect.Effect<{ readonly data: Entry[]; readonly next?: Anchor }>
  readonly forget: (input: { readonly projectID: Project.ID; readonly directory: AbsolutePath }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/ProjectInventory") {}

type Row = {
  project_id: Project.ID
  project_name: string | null
  project_worktree: AbsolutePath
  directory: AbsolutePath
  strategy: string | null
  sessions: number
  time_active: number
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fs = yield* FSUtil.Service
    const sessions = yield* Session.Service
    const directories = yield* ProjectDirectories.Service
    const events = yield* EventRuntime.Service

    const list = Effect.fn("ProjectInventory.list")(function* (input: ListInput) {
      const rows = yield* db
        .all<Row>(
          sql`with candidates as (
            select ${ProjectDirectoryTable.project_id} as project_id, ${ProjectDirectoryTable.directory} as directory,
              ${ProjectDirectoryTable.strategy} as strategy, ${ProjectDirectoryTable.time_created} as time, 0 as session
            from ${ProjectDirectoryTable}
            union all
            select ${SessionTable.project_id}, ${SessionTable.directory}, null, ${SessionTable.time_updated}, 1
            from ${SessionTable}
          )
          select candidates.project_id as project_id, ${ProjectTable.name} as project_name,
            ${ProjectTable.worktree} as project_worktree, candidates.directory as directory,
            max(candidates.strategy) as strategy, sum(candidates.session) as sessions, max(candidates.time) as time_active
          from candidates
          join ${ProjectTable} on ${ProjectTable.id} = candidates.project_id
          ${where(input)}
          group by candidates.project_id, candidates.directory
          order by ${ProjectTable.worktree}, candidates.project_id, candidates.directory
          limit ${input.limit + 1}`,
        )
        .pipe(Effect.orDie)
      const page = rows.slice(0, input.limit)
      const data = yield* Effect.forEach(
        page,
        (row) =>
          fs.isDir(row.directory).pipe(
            Effect.map(
              (available): Entry => ({
                projectID: row.project_id,
                ...(row.project_name ? { projectName: row.project_name } : {}),
                projectWorktree: row.project_worktree,
                directory: row.directory,
                ...(row.strategy ? { strategy: row.strategy } : {}),
                sessions: row.sessions,
                timeActive: row.time_active,
                available,
              }),
            ),
          ),
        { concurrency: 8 },
      )
      const last = page.at(-1)
      if (rows.length <= input.limit || !last) return { data }
      return {
        data,
        next: { projectWorktree: last.project_worktree, projectID: last.project_id, directory: last.directory },
      }
    })

    const forget = Effect.fn("ProjectInventory.forget")(function* (input: {
      readonly projectID: Project.ID
      readonly directory: AbsolutePath
    }) {
      const rows = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(and(eq(SessionTable.project_id, input.projectID), eq(SessionTable.directory, input.directory)))
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        rows,
        (row) => sessions.remove(row.id).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void)),
        { concurrency: 1, discard: true },
      )
      if (yield* directories.remove(input)) yield* events.publish(Event.Updated, { projectID: input.projectID })
    })

    return Service.of({ list, forget })
  }),
)

function where(input: ListInput) {
  const conditions = [searchFilter(input.search), anchorFilter(input.after)].filter((item) => item !== undefined)
  if (conditions.length === 0) return sql``
  return sql`where ${sql.join(conditions, sql` and `)}`
}

function searchFilter(search: string | undefined) {
  const value = search?.trim().toLowerCase()
  if (!value) return undefined
  const pattern = `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
  return sql`(lower(candidates.directory) like ${pattern} escape '\\' or lower(coalesce(${ProjectTable.name}, '')) like ${pattern} escape '\\')`
}

function anchorFilter(anchor: Anchor | undefined) {
  if (!anchor) return undefined
  return sql`(${ProjectTable.worktree}, candidates.project_id, candidates.directory) > (${anchor.projectWorktree}, ${anchor.projectID}, ${anchor.directory})`
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, FSUtil.node, Session.node, ProjectDirectories.node, EventRuntime.node],
})
