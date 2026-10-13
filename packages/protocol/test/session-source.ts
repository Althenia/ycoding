import { Schema } from "effect"
import { ClientApi } from "../src/client.js"
import { resourceIDs } from "./resources-contract.js"
import { platformIDs } from "./platform-contract.js"
import { platformExclusions } from "./platform-source.js"

export const sessionInventoryAdditions = {
  "event.unsubscribe": "protocol.md:227 / operation-inventory.md:94",
} as const

export const SessionAssetMetadata = Schema.Struct({
  mime: Schema.String,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "SessionAssetMetadata" })

export function sessionEndpoints() {
  return Object.values(ClientApi.groups)
    .flatMap((group) => Object.values(group.endpoints).map((endpoint) => ({ group: group.identifier, endpoint })))
    .filter(
      ({ endpoint }) =>
        !(endpoint.identifier in resourceIDs) &&
        !(endpoint.identifier in platformIDs) &&
        !(endpoint.identifier in platformExclusions),
    )
    .sort((a, b) => a.endpoint.identifier.localeCompare(b.endpoint.identifier))
}

export function sessionRpcEndpoints() {
  return sessionEndpoints().map(({ group, endpoint }) => ({
    group,
    endpoint:
      endpoint.identifier === "session.attachment.read"
        ? { ...endpoint, success: new Set([SessionAssetMetadata]) }
        : ["event.subscribe", "session.log"].includes(endpoint.identifier)
          ? { ...endpoint, success: new Set([Schema.Struct({ subscription_id: Schema.String })]) }
          : endpoint,
  }))
}
