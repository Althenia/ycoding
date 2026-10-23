import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"
import { ServerParams } from "./run"

export const CoordinationCommand = Spec.make("coordination", {
  description: "Manage Projects",
  params: {
    ...ServerParams,
    action: Argument.string("action").pipe(Argument.withDescription("list, get, create, update or delete")),
    group: Flag.string("group").pipe(Flag.withDescription("Project ID"), Flag.optional),
    data: Flag.string("data").pipe(Flag.withDescription("JSON body for create or update; update requires revision"), Flag.optional),
  },
})

const bodies = new Set(["create", "update"])
const actions = new Set(["list", "get", "create", "update", "delete"])

export function coordinationRequest(action: string, groupID?: string, data?: string) {
  if (!actions.has(action)) throw new Error(`Unknown coordination action: ${action}`)
  const grouped = action === "get" || action === "update" || action === "delete"
  if (grouped && (!groupID || groupID.length > 96 || !/^cgrp_[A-Za-z0-9_-]+$/.test(groupID))) throw new Error("A valid Project ID is required")
  if (!grouped && groupID !== undefined) throw new Error("This action does not accept --group")
  if (!bodies.has(action) && data !== undefined) throw new Error("This action does not accept --data")
  if (bodies.has(action) && data === undefined) throw new Error("This action requires --data")
  const body: unknown = data === undefined ? undefined : JSON.parse(data)
  if (data !== undefined && (body === null || typeof body !== "object" || Array.isArray(body))) throw new Error("--data must be a JSON object")
  return {
    method: action === "delete" ? "DELETE" : action === "update" ? "PATCH" : action === "create" ? "POST" : "GET",
    path: grouped ? `/api/coordination/${groupID}` : "/api/coordination",
    ...(body === undefined ? {} : { body }),
  }
}
