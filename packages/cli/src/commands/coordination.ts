import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"
import { ServerParams } from "./run"

export const CoordinationCommand = Spec.make("coordination", {
  description: "Manage local coordination groups and bounded assignments",
  params: {
    ...ServerParams,
    action: Argument.string("action").pipe(Argument.withDescription("list, get, create, members, arm, stop, complete, claim, release, dispatch, receipts, wait, cancelWait or capacity")),
    group: Flag.string("group").pipe(Flag.withDescription("Coordination group ID"), Flag.optional),
    data: Flag.string("data").pipe(Flag.withDescription("JSON object for a mutation, including its expected revision"), Flag.optional),
  },
})

const mutations = new Set(["create", "members", "arm", "stop", "complete", "claim", "release", "dispatch", "wait", "cancelWait"])
const reads = new Set(["list", "get", "receipts", "capacity"])

export function coordinationRequest(action: string, groupID?: string, data?: string) {
  if (!mutations.has(action) && !reads.has(action)) throw new Error(`Unknown coordination action: ${action}`)
  const grouped = action !== "list" && action !== "create"
  if (grouped && (!groupID || !/^cgrp_[A-Za-z0-9_-]{1,128}$/.test(groupID))) throw new Error("A valid coordination group ID is required")
  if (!grouped && groupID !== undefined) throw new Error("This action does not accept --group")
  if (reads.has(action) && data !== undefined) throw new Error("Read operations do not accept --data")
  if (mutations.has(action) && data === undefined) throw new Error("This action requires --data")
  const body: unknown = data === undefined ? undefined : JSON.parse(data)
  if (data !== undefined && (body === null || typeof body !== "object" || Array.isArray(body))) throw new Error("--data must be a JSON object")
  const suffix = action === "get" ? "" : action === "cancelWait" ? "/wait/cancel" : `/${action}`
  return {
    method: action === "members" ? "PUT" : mutations.has(action) ? "POST" : "GET",
    path: grouped ? `/api/coordination/${groupID}${suffix}` : "/api/coordination",
    ...(body === undefined ? {} : { body }),
  }
}
