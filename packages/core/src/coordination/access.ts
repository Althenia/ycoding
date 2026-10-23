export * as CoordinationAccessResolver from "./access"

import { and, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import type { Session } from "@ycoding-ai/schema/session"
import type { Coordination } from "@ycoding-ai/schema/coordination"
import { CoordinationService } from "./index"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import type { CoordinationAccess } from "../session/coordination-access"
import { SessionMessageTable, SessionTable } from "../session/sql"

export type Restriction = CoordinationAccess.Access & {
  readonly resourceScopes?: readonly string[]
  readonly status?: string
  readonly selection?: Coordination.DispatchSelection
}

export function make(options: {
  readonly db: Database.Interface["db"]
  readonly coordination: Pick<CoordinationService.Interface, "standingRoles" | "accessForInput">
}) {
  return {
    forSession: Effect.fn("CoordinationAccessResolver.forSession")(function* (sessionID: Session.ID) {
      const restrictions: Restriction[] = []
      const visited = new Set<Session.ID>()
      let current: Session.ID | undefined = sessionID
      while (current !== undefined && !visited.has(current)) {
        visited.add(current)
        const roles = yield* options.coordination.standingRoles(current).pipe(Effect.orDie)
        restrictions.push(...roles.filter((role) => current === sessionID || role.role !== "coordinator"))
        const message = yield* options.db.select({ id: SessionMessageTable.id }).from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.session_id, current), eq(SessionMessageTable.type, "user")))
          .orderBy(desc(SessionMessageTable.seq)).limit(1).get().pipe(Effect.orDie)
        const assignment = message === undefined ? undefined : yield* options.coordination.accessForInput({ sessionID: current, messageID: message.id }).pipe(Effect.orDie)
        if (assignment !== undefined) {
          const access: Restriction = { role: "worker", allowedTools: assignment.allowedTools, resourceScopes: assignment.resourceScopes, ...(current === sessionID ? { selection: assignment.selection } : {}) }
          restrictions.push(access)
          if (assignment.assignmentResourceScope !== undefined)
            restrictions.push({ ...access, resourceScopes: [assignment.assignmentResourceScope] })
        }
        const parent: { id: Session.ID | null } | undefined = yield* options.db.select({ id: SessionTable.parent_id }).from(SessionTable)
          .where(eq(SessionTable.id, current)).get().pipe(Effect.orDie)
        current = parent?.id ?? undefined
      }
      return restrictions
    }),
  }
}

export type Interface = ReturnType<typeof make>
export class Service extends Context.Service<Service, Interface>()("@ycoding/CoordinationAccessResolver") {}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, Effect.gen(function* () {
    const database = yield* Database.Service
    const coordination = yield* CoordinationService.Service
    return Service.of(make({ db: database.db, coordination }))
  })),
  deps: [Database.node, CoordinationService.node],
})
