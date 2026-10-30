import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "../src/config"
import { DotsAccess } from "../src/dots/access"
import { Credential } from "../src/credential"
import { Integration } from "../src/integration"

test("enabled Dots configuration requires an explicit nonempty profile", () => {
  const decode = Schema.decodeUnknownSync(Config.Info)
  expect(decode({ dots: { enabled: true, profile: "fixture" } }, { onExcessProperty: "error" }).dots).toEqual({ enabled: true, profile: "fixture" })
  for (const dots of [{ enabled: true }, { enabled: true, profile: "" }, { enabled: true, profile: 1 }])
    expect(() => decode({ dots }, { onExcessProperty: "error" })).toThrow()
  expect(decode({}).dots).toBeUndefined()
})

test("the Dots display name accepts only bounded printable single-line text", () => {
  const decode = Schema.decodeUnknownSync(Config.Info)
  for (const name of ["a", "Desk Mac (2)", "x".repeat(100), "~!@#$%^&*()_+{}|:<>?"])
    expect(decode({ dots: { enabled: true, profile: "fixture", name } }, { onExcessProperty: "error" }).dots).toEqual({ enabled: true, profile: "fixture", name })
  for (const name of ["", " ", " padded", "padded ", "x".repeat(101), "line\nbreak", "tab\tname", "caf\u00e9", "nul\u0000", "del\u007f", 1])
    expect(() => decode({ dots: { enabled: true, profile: "fixture", name } }, { onExcessProperty: "error" })).toThrow()
})

test("only global configuration supplies the Dots display name and it never changes the access selection", () => {
  const document = (name: string | undefined, scope?: "global") => new Config.Document({ type: "document", ...(scope ? { scope } : {}),
    info: new Config.Info({ dots: { enabled: true, profile: "pinned", ...(name === undefined ? {} : { name }) } }) })
  expect(Config.dotsName([document("Project desk")])).toBeUndefined()
  expect(Config.dotsName([document("Global desk", "global"), document("Project desk")])).toBe("Global desk")
  expect(Config.dotsName([document("Older desk", "global"), document("Newer desk", "global")])).toBe("Newer desk")
  expect(Config.dotsName([document("Older desk", "global"), document(undefined, "global")])).toBeUndefined()
  expect(Config.dots([document("Global desk", "global")])).toEqual({ enabled: true, profile: "pinned" })
  expect(Config.dots([document("Global desk", "global")])).toEqual(Config.dots([document("Renamed desk", "global")]))
})

test("configured access requires the exact available ChatGPT profile, independent of refresh generation", () => {
  const entries = [new Config.Document({ type: "document", scope: "global", info: new Config.Info({ dots: { enabled: true, profile: "pinned" } }) })]
  const credential = new Credential.Info({ id: Credential.ID.create(), integrationID: Integration.ID.make("openai"), label: "pinned", value: {
    type: "oauth", methodID: Integration.MethodID.make("chatgpt-browser"), access: "synthetic", refresh: "synthetic", expires: 0, metadata: { accountID: "synthetic" },
  } })
  expect(DotsAccess.configured(entries, [credential])).toBe(true)
  expect(DotsAccess.configured(entries, [new Credential.Info({ ...credential, generation: 5 })])).toBe(true)
  expect(DotsAccess.configured(entries, [new Credential.Info({ ...credential, label: "other" })])).toBe(false)
  expect(DotsAccess.configured(entries, [])).toBe(false)
  expect(DotsAccess.configured(entries, [new Credential.Info({ ...credential, value: { ...credential.value, metadata: { accountID: "" } } })])).toBe(false)
})

test("only global configuration document provenance can opt in Dots", () => {
  const global = new Config.Document({ type: "document", scope: "global", info: new Config.Info({ dots: { enabled: true, profile: "pinned" } }) })
  const project = new Config.Document({ type: "document", info: new Config.Info({ dots: { enabled: true, profile: "untrusted" } }) })
  expect(Config.dots([project])).toEqual({ enabled: false })
  expect(Config.dots([global, project])).toEqual({ enabled: true, profile: "pinned" })
  expect(Config.capabilities([project]).dots).toBe(false)
  expect(Config.capabilities([global, project]).dots).toBe(true)
})
