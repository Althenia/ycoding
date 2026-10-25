import type { CoordinationInfo, CoordinationParticipant, CoordinationUpdateInput } from "@ycoding-ai/client"
import { createContext, createMemo, createSignal, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import { useClient } from "./client"
import { useConfig } from "../config"
import {
  externalNotificationAllowed,
  projectContextOf,
  projectOfSession,
  ProjectCreationError,
  roster,
  type DelegatedDecisionsView,
  type ExternalNotificationKind,
  type GlobalDelegationView,
  type NotificationFilter,
  type ProjectMemberView,
  type ProjectService,
  type ProjectSessionChoice,
  type ProjectView,
} from "../util/coordination"
import { errorMessage } from "../util/error"

const Context = createContext<ReturnType<typeof createCoordination>>()

type RootSession = Omit<ProjectSessionChoice, "projectName">

const rootRefreshEvents = new Set([
  "session.created",
  "session.deleted",
  "session.archived",
  "session.moved",
  "session.renamed",
])
const liveStateEvents = ["session.execution.", "form.", "permission.", "guardrail.", "coordination."]

function memberView(participant: CoordinationParticipant, role: ProjectMemberView["role"]): ProjectMemberView {
  return {
    sessionID: participant.sessionID,
    title: participant.title,
    role,
    state: participant.state,
    directory: participant.location.directory,
    lastActivity: participant.lastActivity,
    pending: participant.pending.length,
    ...(participant.drivenBy === undefined ? {} : { drivenBy: participant.drivenBy.title }),
    ...(participant.owner === undefined ? {} : { owner: participant.owner }),
  }
}

function projectView(info: CoordinationInfo): ProjectView {
  return {
    id: info.id,
    name: info.name,
    revision: info.revision,
    active: info.active,
    ...(info.pausedReason === undefined ? {} : { pausedReason: info.pausedReason }),
    concurrency: info.settings.concurrency,
    ...(info.settings.delegatedDecisions === undefined ? {} : { delegatedDecisions: info.settings.delegatedDecisions }),
    created: info.time.created,
    master: memberView(info.master, "master"),
    members: info.members.map((member) => memberView(member, "member")),
  }
}

function createCoordination() {
  const client = useClient()
  const config = useConfig()
  const [projects, setProjects] = createSignal<ProjectView[]>()
  const [roots, setRoots] = createSignal<readonly RootSession[]>([])
  const [error, setError] = createSignal<string>()
  const [globalDelegation, setGlobalDelegation] = createSignal<GlobalDelegationView>()
  const [loadedAt, setLoadedAt] = createSignal<number>()
  const records = new Map<string, CoordinationInfo>()
  let generation = 0
  let rootGeneration = 0
  let disposed = false
  let scheduled: ReturnType<typeof setTimeout> | undefined
  let projectRefresh: Promise<boolean> | undefined
  const creations = new Map<string, { sessionID?: string; submitted?: boolean }>()

  async function loadProjects() {
    const token = ++generation
    try {
      const [list, settings] = await Promise.all([
        client.api.coordination.list(),
        Promise.resolve()
          .then(() => client.api.coordination.settings())
          .catch(() => undefined),
      ])
      const details = await Promise.all(list.map((summary) => client.api.coordination.get({ groupID: summary.id })))
      if (disposed || token !== generation) return false
      records.clear()
      details.forEach((detail) => records.set(detail.id, detail))
      setProjects(details.map(projectView))
      setGlobalDelegation(settings)
      setLoadedAt(Date.now())
      setError(undefined)
      return true
    } catch (cause) {
      if (!disposed && token === generation) setError(errorMessage(cause))
      return false
    }
  }

  function refreshProjects(): Promise<boolean> {
    const pending: Promise<boolean> = loadProjects().then(async (loaded) => {
      if (!disposed && projectRefresh !== pending && projectRefresh) return await projectRefresh
      return loaded
    })
    projectRefresh = pending
    return pending
  }

  async function refreshRoots() {
    const token = ++rootGeneration
    try {
      const found: RootSession[] = []
      let cursor: string | undefined
      do {
        const page = await client.api.session.list({
          parentID: null,
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        })
        if (disposed || token !== rootGeneration) return
        found.push(
          ...page.data
            .filter((session) => session.time.archived === undefined)
            .map((session) => ({
              sessionID: session.id,
              title: session.title,
              directory: session.location.directory,
              updated: session.time.updated,
            })),
        )
        cursor = page.cursor.next ?? undefined
      } while (cursor !== undefined)
      setRoots(found)
    } catch (cause) {
      if (!disposed && token === rootGeneration) setError(errorMessage(cause))
    }
  }

  const refresh = () => Promise.all([refreshProjects(), refreshRoots()]).then(() => undefined)
  const schedule = () => {
    if (scheduled !== undefined) return
    scheduled = setTimeout(() => {
      scheduled = undefined
      if (!disposed) void refreshProjects()
    }, 150)
  }

  const sessions = createMemo<readonly ProjectSessionChoice[]>(() =>
    roots().map((session) => {
      const owner = projectOfSession(projects(), session.sessionID)
      return owner ? { ...session, projectName: owner.project.name } : session
    }),
  )

  const record = (projectID: string) => {
    const value = records.get(projectID)
    if (!value) throw new Error("Refresh Projects before changing this Project")
    return value
  }
  const memberIDs = (projectID: string) => record(projectID).members.map((member) => member.sessionID)
  const settingsOf = (projectID: string) => record(projectID).settings
  const mutate = async <T,>(operation: () => Promise<T>) => {
    try {
      return await operation()
    } finally {
      await Promise.all([refreshProjects(), refreshRoots()])
    }
  }
  const update = (projectID: string, change: Omit<CoordinationUpdateInput, "groupID" | "revision">) =>
    mutate(() =>
      client.api.coordination.update({ groupID: projectID, revision: record(projectID).revision, ...change }),
    )
  const createSession = async (directory: string, title?: string) => {
    const created = await client.api.session.create({
      location: { directory },
      ...(title?.trim() ? { title: title.trim() } : {}),
    })
    return created.id
  }
  const createForProject = async (key: string, directory: string, title?: string) => {
    const prior = creations.get(key)
    if (prior?.sessionID) return prior.sessionID
    if (prior)
      throw new ProjectCreationError(
        "Session creation outcome unknown. Check Sessions before choosing an existing Session; creation will not be repeated.",
      )
    const pending: { sessionID?: string; submitted?: boolean } = {}
    creations.set(key, pending)
    try {
      pending.sessionID = await createSession(directory, title)
      return pending.sessionID
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        ["InvalidRequestError", "SessionNotFoundError", "UnauthorizedError"].includes(String(cause._tag))
      ) {
        creations.delete(key)
        throw cause
      }
      throw new ProjectCreationError(
        "Session creation outcome unknown. Check Sessions before choosing an existing Session; creation will not be repeated.",
      )
    }
  }
  const creationFailure = (sessionID: string, cause: unknown) =>
    new ProjectCreationError(
      `Session created: ${sessionID}. Project membership not confirmed: ${errorMessage(cause)}. Retry reuses this Session.`,
      sessionID,
    )

  const service: ProjectService = {
    create: (input) => {
      const key = JSON.stringify(["master", input])
      return mutate(async () => {
        const masterSessionID =
          "sessionID" in input.master
            ? input.master.sessionID
            : await createForProject(key, input.master.directory, input.master.title ?? input.name)
        const attempt = creations.get(key) ?? { sessionID: masterSessionID, submitted: false }
        creations.set(key, attempt)
        try {
          if (!(await refreshProjects())) throw new Error("Projects could not be refreshed")
          const owner = [...records.values()].find(
            (record) =>
              record.master.sessionID === masterSessionID ||
              record.members.some((member) => member.sessionID === masterSessionID),
          )
          if (owner) {
            if (attempt.submitted && owner.master.sessionID === masterSessionID && owner.name === input.name) {
              creations.delete(key)
              return masterSessionID
            }
            throw new Error("The Session belongs to another Project")
          }
          attempt.submitted = true
          const created = await client.api.coordination.create({
            name: input.name,
            masterSessionID,
            memberSessionIDs: [],
          })
          creations.delete(key)
          return created.master.sessionID
        } catch (cause) {
          if ("sessionID" in input.master) throw cause
          throw creationFailure(masterSessionID, cause)
        }
      })
    },
    rename: (projectID, name) => update(projectID, { name }).then(() => undefined),
    setMaster: (projectID, sessionID) => {
      const current = record(projectID)
      if (current.master.sessionID === sessionID) return Promise.resolve()
      const members = [current.master.sessionID, ...memberIDs(projectID).filter((id) => id !== sessionID)]
      return update(projectID, { masterSessionID: sessionID, memberSessionIDs: members }).then(() => undefined)
    },
    setConcurrency: (projectID, value) => {
      const { delegatedDecisions } = settingsOf(projectID)
      return update(projectID, {
        settings: { concurrency: value, ...(delegatedDecisions === undefined ? {} : { delegatedDecisions }) },
      }).then(() => undefined)
    },
    setDelegation: (projectID, value: DelegatedDecisionsView | null) =>
      update(projectID, {
        settings: {
          concurrency: settingsOf(projectID).concurrency,
          ...(value === null ? {} : { delegatedDecisions: value }),
        },
      }).then(() => undefined),
    addMember: (projectID, sessionID) => {
      if (roster(projectView(record(projectID))).some((member) => member.sessionID === sessionID))
        return Promise.reject(new Error("A Session can belong to a Project once"))
      return update(projectID, { memberSessionIDs: [...memberIDs(projectID), sessionID] }).then(() => undefined)
    },
    newMember: async (projectID, directory, title) => {
      const key = JSON.stringify(["member", projectID, directory, title])
      const sessionID = await createForProject(key, directory, title)
      try {
        if (!(await refreshProjects())) throw new Error("Projects could not be refreshed")
        const owner = [...records.values()].find(
          (record) =>
            record.master.sessionID === sessionID || record.members.some((member) => member.sessionID === sessionID),
        )
        if (owner && (owner.id !== projectID || owner.master.sessionID === sessionID))
          throw new Error("The Session belongs to another Project")
        if (!owner) await update(projectID, { memberSessionIDs: [...memberIDs(projectID), sessionID] })
        creations.delete(key)
        return sessionID
      } catch (cause) {
        throw creationFailure(sessionID, cause)
      }
    },
    removeMember: (projectID, sessionID) => {
      if (record(projectID).master.sessionID === sessionID)
        return Promise.reject(new Error("Change the Master in Settings before removing it"))
      return update(projectID, { memberSessionIDs: memberIDs(projectID).filter((id) => id !== sessionID) }).then(
        () => undefined,
      )
    },
    deleteMember: (projectID, sessionID) => {
      if (!memberIDs(projectID).includes(sessionID))
        return Promise.reject(new Error("Only a member Session can be deleted from its Project"))
      return mutate(() => client.api.session.remove({ sessionID }))
    },
    deleteProject: (projectID) => mutate(() => client.api.coordination.delete({ groupID: projectID })),
  }

  const filter = (): NotificationFilter => config.data.attention.coordination
  const setFilter = async (next: NotificationFilter) => {
    await config.update((draft) => {
      draft.attention ??= {}
      draft.attention.coordination = next
    })
  }
  const externalAllowed = (sessionID: string, kind: ExternalNotificationKind) =>
    externalNotificationAllowed(filter(), projects(), sessionID, kind)
  const projectOf = (sessionID: string) => projectOfSession(projects(), sessionID)
  const contextOf = (sessionID: string) => projectContextOf(projects(), sessionID)

  const cleanups = [
    client.event.listen(({ details }) => {
      if (details.type === "server.connected") return void refresh()
      if (rootRefreshEvents.has(details.type)) void refreshRoots()
      if (rootRefreshEvents.has(details.type) || liveStateEvents.some((prefix) => details.type.startsWith(prefix)))
        schedule()
    }),
  ]
  onMount(() => void refresh())
  onCleanup(() => {
    disposed = true
    generation += 1
    rootGeneration += 1
    if (scheduled !== undefined) clearTimeout(scheduled)
    cleanups.forEach((cleanup) => cleanup())
  })
  return {
    projects,
    sessions,
    error,
    globalDelegation,
    loadedAt,
    service,
    filter,
    setFilter,
    externalAllowed,
    projectOf,
    contextOf,
    refresh,
  }
}

export function CoordinationProvider(props: ParentProps) {
  const value = createCoordination()
  return <Context.Provider value={value}>{props.children}</Context.Provider>
}

export function useCoordination() {
  const value = useContext(Context)
  if (!value) throw new Error("CoordinationProvider is missing")
  return value
}

export function useCoordinationOptional() {
  return useContext(Context)
}
