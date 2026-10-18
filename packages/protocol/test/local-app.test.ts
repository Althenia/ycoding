import { expect, test } from "bun:test"
import {
  MutationClass,
  Paging,
  PeerRole,
  ScopeKind,
  Sensitivity,
  Settlement,
  Streaming,
  operations,
} from "../src/v5/index.js"

test.each([
  ["local.app.register", 5047, MutationClass.MUTATION],
  ["local.app.list", 5048, MutationClass.READ],
  ["local.app.revoke", 5049, MutationClass.MUTATION],
  ["local.app.open", 5050, MutationClass.MUTATION],
  ["local.app.status", 5051, MutationClass.READ],
  ["local.app.http", 5052, MutationClass.MUTATION],
] as const)("%s is a closed Session-scoped operation with its own stable identity", (name, id, mutation) => {
  const operation = operations.find((item) => item.diagnosticName === name)
  expect(operation).toBeDefined()
  expect(operation).toMatchObject({
    operationId: id,
    roles: [PeerRole.REMOTE_CLIENT, PeerRole.RELAY],
    scope: ScopeKind.SESSION,
    mutation,
    settlement: Settlement.COMPLETED,
    paging: Paging.UNPAGED,
    streaming: Streaming.TYPED_BULK,
    sensitivity: Sensitivity.SECRET,
    errorTypes: ["ycoding.v5.Connector_Error"],
  })
  expect(operations.filter((item) => item.operationId === id)).toHaveLength(1)
})
