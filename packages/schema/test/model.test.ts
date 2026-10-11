import { describe, expect, test } from "bun:test"
import { Model } from "../src/model.js"
import { Schema } from "effect"

describe("Model.Ref", () => {
  test("preserves named profile selections without credential identity", () => {
    const ref = { ...Model.Ref.parse("openai/gpt-6.1-sol#high"), profile: "Work" }
    const decoded = Schema.decodeUnknownSync(Model.Ref)({ ...ref, credentialID: "cred_private" })
    expect(decoded).toEqual(ref)
    expect(Schema.encodeSync(Model.Ref)(decoded)).toEqual(ref)
    expect(() => Schema.decodeUnknownSync(Model.Ref)({ ...ref, profile: "" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Model.Ref)({ ...ref, profile: null })).toThrow()
    expect(Schema.encodeSync(Model.Ref)({ ...Model.Ref.parse("openai/gpt-6.1-sol"), profile: undefined })).toEqual({
      providerID: "openai",
      id: "gpt-6.1-sol",
    })
  })

  test("projects eligible named profiles without account or credential metadata", () => {
    const ref = Model.Ref.parse("openai/gpt-6.1-sol")
    const decoded = Schema.decodeUnknownSync(Model.Info)({
      ...Model.Info.empty(ref.providerID, ref.id),
      profiles: [{ name: "Work", active: false, credentialID: "cred_private", accountID: "account-private" }],
    })
    expect(decoded.profiles).toEqual([{ name: "Work", active: false }])
    expect(() => Schema.decodeUnknownSync(Model.Info)({ ...decoded, profiles: [{ name: "", active: true }] })).toThrow()
  })

  test("parses model references with optional variants", () => {
    const variant = Model.Ref.parse("openrouter/openai/gpt-5#high")
    expect(String(variant.providerID)).toBe("openrouter")
    expect(String(variant.id)).toBe("openai/gpt-5")
    expect(String(variant.variant)).toBe("high")

    const standard = Model.Ref.parse("anthropic/claude-sonnet")
    expect(String(standard.providerID)).toBe("anthropic")
    expect(String(standard.id)).toBe("claude-sonnet")
    expect(standard.variant).toBeUndefined()
  })

  test("parses profile-qualified references with optional variants", () => {
    const expected = Model.Ref.parse("openai/gpt-6-luna#high")
    expect(Model.Ref.parse("Work#openai/gpt-6-luna#high")).toMatchObject({ ...expected, profile: "Work" })
    expect(Model.Ref.parse("Work#openrouter/openai/gpt-5")).toMatchObject({
      providerID: "openrouter",
      id: "openai/gpt-5",
      profile: "Work",
    })
    expect(Model.Ref.parse("openai/gpt-6-luna")).not.toHaveProperty("profile")
  })

  test("preserves profile-specific Daybreak eligibility without admitting unknown programs", () => {
    const profile = { name: "Work", active: false, daybreak: ["daybreak_blue"] } as const
    expect(Schema.decodeUnknownSync(Model.Profile)(profile)).toEqual(profile)
    expect(() => Schema.decodeUnknownSync(Model.Profile)({ ...profile, daybreak: ["unknown"] })).toThrow()
    expect(Schema.encodeSync(Model.Profile)({ name: "Personal", active: true })).toEqual({ name: "Personal", active: true })
  })

  test("preserves per-profile variant IDs without publishing variant overlays", () => {
    const profile = { name: "Work", active: false, variants: [Model.VariantID.make("high")] }
    expect(Schema.decodeUnknownSync(Model.Profile)(profile)).toEqual(profile)
    expect(() => Schema.decodeUnknownSync(Model.Profile)({ ...profile, variants: [{ id: "high", settings: { private: true } }] })).toThrow()
    expect(Schema.decodeUnknownSync(Model.Profile)({ ...profile, variants: [] })).toEqual({ ...profile, variants: [] })
  })

  test("rejects malformed model references", () => {
    expect(() => Model.Ref.parse("gpt-5")).toThrow()
    expect(() => Model.Ref.parse("openai/gpt-5#")).toThrow()
    expect(() => Model.Ref.parse("openai/gpt-5#high#extra")).toThrow()
    expect(() => Model.Ref.parse("#openai/gpt-5")).toThrow()
    expect(() => Model.Ref.parse("Work#openai/gpt-5#")).toThrow()
  })
})
