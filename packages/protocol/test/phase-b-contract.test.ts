import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  decodeLossless,
  encodeAssetMetadata,
  fs_read_ResultSchema,
  session_attachment_read_ResultSchema,
  ScopeSchema,
  ScopeKind,
  PeerRole,
  operations,
  AssetMetadataResultSchema,
} from "../src/v5/index.js"
import { messages } from "../src/generated/v5/contract.js"
import { Connection } from "../src/v5/connection/index.js"
import { send } from "./connection-fixtures.js"

test("global Forms append one local-only Location selector without changing real-Session scopes", () => {
  const scope = create(ScopeSchema, {
    target: {
      case: "globalForm",
      value: { directory: encodeLossless("/project"), workspaceId: encodeLossless("workspace") },
    },
  })
  expect(decodeStrict(ScopeSchema, encodeStrict(ScopeSchema, scope))).toEqual(scope)
  expect(messages["ycoding.v5.Scope"].fields.map((field) => field.tag)).toEqual([1, 2, 3, 4, 5, 6, 7])
  for (const operation of operations.filter((operation) => operation.diagnosticName.startsWith("session.form."))) {
    expect(operation.roleScopes.find((rule) => rule.role === PeerRole.LOCAL_CLIENT)!.scopes).toEqual([
      ScopeKind.FORM,
      ScopeKind.GLOBAL_FORM,
    ])
    expect(
      operation.roleScopes.find((rule) => rule.role === PeerRole.REMOTE_CLIENT)?.scopes ?? [operation.scope],
    ).not.toContain(ScopeKind.GLOBAL_FORM)
  }
})
test("receipt-confirmation timeout after Ready handoff closes the unestablished producer with 1008", () => {
  const client = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: [],
    now: 0,
  })
  const server = new Connection({
    role: PeerRole.SERVER,
    peer: PeerRole.LOCAL_CLIENT,
    operations,
    eventTypes: [],
    now: 0,
    epoch: "connection-1",
    sourceEpoch: "source-1",
  })
  client.start(0)
  send(client, server)
  send(server, client)
  expect(client.state).toBe("established")
  expect(server.state).toBe("confirm")
  expect(server.advance(5000)).toContainEqual(expect.objectContaining({ type: "closed", code: 1008 }))
})

test.each(["", "text", "text/", "text/plain\r\nX: injected", "text/😀", 'text/plain; charset="unterminated'])(
  "asset MIME %s cannot cross the metadata boundary",
  (mime) => {
    const value = create(AssetMetadataResultSchema, {
      metadata: { typeName: "ycoding.v5.fs_read_Result", payload: new Uint8Array() },
      mime: encodeLossless(mime),
      byteCount: 0n,
    })
    expect(() => encodeStrict(AssetMetadataResultSchema, value)).toThrow("asset MIME")
  },
)
test.each([
  "application/octet-stream",
  "image/svg+xml",
  "text/plain; charset=utf-8",
  ' Text/Plain ; charset="utf-8;version=1" ',
])("both asset metadata consumers preserve valid MIME %s and exact zero length", (mime) => {
  const fs = encodeAssetMetadata(
    fs_read_ResultSchema,
    create(fs_read_ResultSchema, { data: { mime: encodeLossless(mime), byteCount: 0n } }),
  )
  const attachment = encodeAssetMetadata(
    session_attachment_read_ResultSchema,
    create(session_attachment_read_ResultSchema, { data: { mime: encodeLossless(mime), bytes: 0n } }),
  )
  for (const metadata of [fs, attachment]) {
    expect(decodeLossless(metadata.mime!)).toBe(mime)
    expect(metadata.byteCount).toBe(0n)
    expect(metadata.metadata?.payload.length).toBeGreaterThan(0)
  }
})
