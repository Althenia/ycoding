import type { CoordinationInfo } from "@ycoding-ai/client"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Money } from "@ycoding-ai/schema/money"
import { Session } from "@ycoding-ai/schema/session"
import { createContext, createSignal, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import { useClient } from "./client"
import { useConfig } from "../config"
import {
  externalNotificationAllowed,
  rosterError,
  type CoordinationGroupView,
  type CoordinationMemberInput,
  type CoordinationPolicyPatch,
  type CoordinationService,
  type CoordinationSessionChoice,
  type ExternalNotificationKind,
  type GlobalDelegationView,
  type NotificationFilter,
} from "../util/coordination"
import { errorMessage } from "../util/error"

const Context = createContext<ReturnType<typeof createCoordination>>()

function createCoordination() {
  const client = useClient()
  const config = useConfig()
  const [groups, setGroups] = createSignal<CoordinationGroupView[]>()
  const [sessions, setSessions] = createSignal<readonly CoordinationSessionChoice[]>([])
  const [error, setError] = createSignal<string>()
  const [globalDelegation, setGlobalDelegation] = createSignal<GlobalDelegationView>()
  const records = new Map<string, CoordinationInfo>()
  let generation = 0
  let disposed = false

  async function refresh() {
    const token = ++generation
    try {
      const [list, settings] = await Promise.all([
        client.api.coordination.list(),
        Promise.resolve().then(() => client.api.coordination.settings()).catch(() => undefined),
      ])
      const roots: CoordinationSessionChoice[] = []
      let cursor: string | undefined
      do {
        const page = await client.api.session.list({ parentID: null, limit: 200, ...(cursor === undefined ? {} : { cursor }) })
        if (disposed || token !== generation) return
        roots.push(...page.data.filter((session) => session.time.archived === undefined).map((session) => ({ sessionID: session.id, title: session.title })))
        cursor = page.cursor.next ?? undefined
      } while (cursor !== undefined)
      const loaded = await Promise.all(list.map(async (summary) => {
        const [detail, capacity, receipts] = await Promise.all([
          client.api.coordination.get({ groupID: summary.id }),
          client.api.coordination.capacity({ groupID: summary.id }),
          client.api.coordination.receipts({ groupID: summary.id }),
        ])
        const value = detail
        const title = (sessionID: string) => roots.find((session) => session.sessionID === sessionID)?.title ?? sessionID
        const view: CoordinationGroupView = {
          id: value.id, name: value.name, status: value.status, revision: value.revision,
          policy: value.policy,
          capacity: { active: capacity.active, hardLimit: capacity.hardLimit },
          roster: value.members.map((member) => ({
            sessionID: member.sessionID,
            title: title(member.sessionID),
            role: member.role,
            ...(member.allowedTools === undefined ? {} : { allowedTools: member.allowedTools }),
            ...(member.resourceScopes === undefined ? {} : { resourceScopes: member.resourceScopes }),
          })),
          queue: value.dispatches.filter((dispatch) => dispatch.status === "queued" || dispatch.status === "pending")
            .map((dispatch) => ({ id: dispatch.id, title: title(dispatch.targetSessionID), reason: dispatch.reason ?? dispatch.status, ...(dispatch.selection === undefined ? {} : { selection: dispatch.selection }) })),
          leases: value.claims.filter((claim) => claim.status === "active").map((claim) => ({ id: `${claim.targetSessionID}:${claim.generation}`, holder: title(claim.holderSessionID), resource: title(claim.targetSessionID), expiresAt: claim.leaseExpiresAt })),
          receipts: receipts.map((receipt) => ({ id: receipt.id, worker: title(receipt.sessionID), outcome: receipt.kind, reason: receipt.detail, time: receipt.time, ...(receipt.selection === undefined ? {} : { selection: receipt.selection }) })),
        }
        return { view, record: value }
      }))
      if (disposed || token !== generation) return
      records.clear()
      loaded.forEach((item) => records.set(item.record.id, item.record))
      setGroups(loaded.map((item) => item.view))
      setGlobalDelegation(settings)
      setSessions(roots)
      setError(undefined)
    } catch (cause) {
      if (!disposed && token === generation) setError(errorMessage(cause))
    }
  }

  const record = (groupID: string) => {
    const value = records.get(groupID)
    if (!value) throw new Error("Refresh coordination before changing this group")
    return value
  }
  const mutate = async (operation: () => Promise<unknown>) => {
    await operation()
    await refresh()
  }
  const inputs = (groupID: string): CoordinationMemberInput[] =>
    record(groupID).members.map((member) => ({
      sessionID: member.sessionID,
      role: member.role,
      ...(member.allowedTools === undefined ? {} : { allowedTools: member.allowedTools }),
      ...(member.resourceScopes === undefined ? {} : { resourceScopes: member.resourceScopes }),
    }))
  const memberInput = (member: CoordinationMemberInput) =>
    Coordination.MemberInput.make({ ...member, sessionID: Session.ID.make(member.sessionID) })
  const writeMembers = (groupID: string, members: ReadonlyArray<CoordinationMemberInput>, extra: { name?: string; policy?: Coordination.Policy } = {}) => {
    const error = rosterError(members)
    if (error) return Promise.reject(new Error(error))
    return mutate(() => client.api.coordination.members({
      groupID: Coordination.GroupID.make(groupID), revision: record(groupID).revision,
      members: members.map(memberInput), ...extra,
    }))
  }
  const withRole = (members: CoordinationMemberInput[], sessionID: string, role: CoordinationMemberInput["role"]) =>
    members.map((member) =>
      member.sessionID === sessionID ? { ...member, role } : role === "coordinator" && member.role === "coordinator" ? { ...member, role: "worker" as const } : member)
  const service: CoordinationService = {
    create: (input) => mutate(() => client.api.coordination.create(Coordination.CreateInput.make({
      name: input.name,
      policy: Coordination.Policy.make({ concurrency: 1, queueCapacity: 64 }),
      members: input.roster.map(memberInput),
    }))),
    rename: (groupID, name) => writeMembers(groupID, inputs(groupID), { name }),
    addMember: (groupID, sessionID, role) => {
      const current = inputs(groupID)
      if (current.some((member) => member.sessionID === sessionID)) return Promise.reject(new Error("A session can appear once in a roster"))
      return writeMembers(groupID, withRole([...current, { sessionID, role }], sessionID, role))
    },
    setMemberRole: (groupID, sessionID, role) => writeMembers(groupID, withRole(inputs(groupID), sessionID, role)),
    setMemberAccess: (groupID, sessionID, patch) =>
      writeMembers(groupID, inputs(groupID).map((member) => {
        if (member.sessionID !== sessionID) return member
        const { allowedTools, resourceScopes, ...rest } = member
        const tools = "allowedTools" in patch ? patch.allowedTools : allowedTools
        const scopes = "resourceScopes" in patch ? patch.resourceScopes : resourceScopes
        return { ...rest, ...(tools === undefined ? {} : { allowedTools: tools }), ...(scopes === undefined ? {} : { resourceScopes: scopes }) }
      })),
    removeMember: (groupID, sessionID) => writeMembers(groupID, inputs(groupID).filter((member) => member.sessionID !== sessionID)),
    updatePolicy: (groupID, patch: CoordinationPolicyPatch) => {
      const current = record(groupID).policy
      const budget = patch.budget === undefined ? current.budget : (patch.budget ?? undefined)
      const delegatedDecisions = patch.delegatedDecisions === undefined ? current.delegatedDecisions : (patch.delegatedDecisions ?? undefined)
      return writeMembers(groupID, inputs(groupID), { policy: Coordination.Policy.make({
        concurrency: patch.concurrency === undefined ? current.concurrency : patch.concurrency,
        queueCapacity: patch.queueCapacity ?? current.queueCapacity,
        ...(budget === undefined ? {} : { budget: Money.USD.make(budget) }),
        ...(delegatedDecisions === undefined ? {} : { delegatedDecisions }),
      }) })
    },
    arm: (groupID) => mutate(() => client.api.coordination.arm({ groupID: Coordination.GroupID.make(groupID), revision: record(groupID).revision })),
    stop: (groupID) => mutate(() => client.api.coordination.stop({ groupID: Coordination.GroupID.make(groupID), revision: record(groupID).revision })),
    complete: (groupID) => mutate(() => client.api.coordination.complete({ groupID: Coordination.GroupID.make(groupID), revision: record(groupID).revision })),
  }
  const filter = (): NotificationFilter => config.data.attention.coordination
  const setFilter = async (next: NotificationFilter) => {
    await config.update((draft) => { draft.attention ??= {}; draft.attention.coordination = next })
  }
  const externalAllowed = (sessionID: string, kind: ExternalNotificationKind) => externalNotificationAllowed(filter(), groups(), sessionID, kind)
  const cleanups = Coordination.DurableDefinitions.map((definition) => client.event.on(definition.type, () => void refresh()))
  cleanups.push(client.event.on("coordination.updated", () => void refresh()))
  cleanups.push(client.event.on("server.connected", () => void refresh()))
  onMount(() => void refresh())
  onCleanup(() => { disposed = true; generation += 1; cleanups.forEach((cleanup) => cleanup()) })
  return { groups, sessions, error, globalDelegation, service, filter, setFilter, externalAllowed, refresh }
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
