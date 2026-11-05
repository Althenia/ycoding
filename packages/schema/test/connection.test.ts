import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Connection } from "../src/connection.js"

describe("Connection.CredentialInfo", () => {
  const roundTrip = (input: unknown) =>
    Schema.encodeSync(Connection.CredentialInfo)(Schema.decodeUnknownSync(Connection.CredentialInfo)(input))

  test("round-trips OAuth and key credential connections", () => {
    const oauth = { type: "credential", id: "cred_oauth", label: "Work", active: true, kind: "oauth" } as const
    const key = { type: "credential", id: "cred_key", label: "Personal", active: false, kind: "key" } as const
    expect(roundTrip(oauth)).toEqual(oauth)
    expect(roundTrip(key)).toEqual(key)
  })

  test("decodes a credential connection without kind from an older server", () => {
    const legacy = { type: "credential", id: "cred_1", label: "Work", active: true } as const
    const decoded = Schema.decodeUnknownSync(Connection.CredentialInfo)(legacy)
    expect(decoded.kind).toBeUndefined()
    expect(roundTrip(legacy)).toEqual(legacy)
  })

  test("rejects an unknown kind", () => {
    const decode = Schema.decodeUnknownExit(Connection.CredentialInfo)
    expect(decode({ type: "credential", id: "cred_1", label: "Work", active: true, kind: "command" })._tag).toBe(
      "Failure",
    )
  })

  test("keeps env connections as type and name", () => {
    expect(Schema.encodeSync(Connection.Info)({ type: "env", name: "ACME_KEY" })).toEqual({
      type: "env",
      name: "ACME_KEY",
    })
  })
})
