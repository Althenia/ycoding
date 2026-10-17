import { describe, expect, test } from "bun:test"
import { meetingConfigSchema } from "../src/config"
import {
  decodeModelChoice,
  encodeModelChoice,
  ownerBindingStatus,
  ownerModelStatus,
  readCredentials,
  resolveAskSelection,
} from "../view/model.js"

describe("owner settings configuration", () => {
  test("Ask AI model defaults to inheriting the analysis model and bindings default enabled", () => {
    const config = meetingConfigSchema.parse({})
    expect(config.analysis.askModel).toBe("inherit")
    const bound = meetingConfigSchema.parse({
      knowledge: { bindings: [{ server: "docs", search: "search", read: "read" }] },
    })
    expect(bound.knowledge.bindings[0]?.enabled).toBe(true)
    const disabled = meetingConfigSchema.parse({
      knowledge: { bindings: [{ server: "docs", search: "search", read: "read", write: "replace", enabled: false }] },
    })
    expect(disabled.knowledge.bindings[0]).toMatchObject({ write: "replace", enabled: false })
  })

  test("Ask AI model accepts only inherit or a bounded model reference", () => {
    expect(
      meetingConfigSchema.parse({ analysis: { askModel: { providerID: "p", id: "m", variant: "high" } } }).analysis
        .askModel,
    ).toEqual({ providerID: "p", id: "m", variant: "high" })
    expect(() => meetingConfigSchema.parse({ analysis: { askModel: { providerID: "p" } } })).toThrow()
    expect(() => meetingConfigSchema.parse({ analysis: { askModel: "p/m" } })).toThrow()
  })
})

describe("live page credentials", () => {
  const key = "a".repeat(64)
  const owner = "b".repeat(64)

  test("ordinary link yields only the view key; owner link yields both memory-only credentials", () => {
    expect(readCredentials(`#key=${key}`)).toEqual({ key })
    expect(readCredentials(`#key=${key}&owner=${owner}`)).toEqual({ key, owner })
    expect(readCredentials(`#owner=${owner}&key=${key}`)).toEqual({ key, owner })
  })

  test("missing, duplicate, extra or malformed fragment fields yield no credentials", () => {
    for (const hash of [
      "",
      `#owner=${owner}`,
      `#key=${key}&key=${key}`,
      `#key=${key}&owner=${owner}&owner=${owner}`,
      `#key=${key}&owner=short`,
      `#key=${key}&token=${owner}`,
      `#key=${"A".repeat(64)}&owner=${owner}`,
    ])
      expect(readCredentials(hash)).toBeUndefined()
  })
})

describe("owner settings view-model", () => {
  test("model choice encoding round-trips identifiers containing slashes", () => {
    const value = encodeModelChoice("openrouter", "vendor/model-x")
    expect(decodeModelChoice(value)).toEqual({ providerID: "openrouter", id: "vendor/model-x" })
    expect(decodeModelChoice("inherit")).toBeUndefined()
    expect(decodeModelChoice("not-json")).toBeUndefined()
    expect(decodeModelChoice('["p"]')).toBeUndefined()
  })

  test("model availability is reported, never coerced from absence", () => {
    expect(ownerModelStatus({ enabled: true, status: "active" })).toBe("Available")
    expect(ownerModelStatus({ enabled: false, status: "active" })).toBe("Unavailable · disabled in catalog")
    expect(ownerModelStatus({ enabled: true, status: "deprecated" })).toBe("Unavailable · deprecated")
    expect(ownerModelStatus(undefined)).toBe("Unreported")
    expect(ownerModelStatus({})).toBe("Unreported")
  })

  test("explicit profile carries across variant and model changes while the provider stays the same", () => {
    const loaded = { providerID: "p", id: "m1", variant: "fast", profile: "acct" }
    expect(resolveAskSelection({ providerID: "p", id: "m1", variant: "deep" }, loaded)).toEqual({
      providerID: "p",
      id: "m1",
      variant: "deep",
      profile: "acct",
    })
    expect(resolveAskSelection({ providerID: "p", id: "m9" }, loaded)).toEqual({
      providerID: "p",
      id: "m9",
      profile: "acct",
    })
    expect(resolveAskSelection({ providerID: "q", id: "m1", variant: "fast" }, loaded)).toEqual({
      providerID: "q",
      id: "m1",
      variant: "fast",
    })
    expect(resolveAskSelection("inherit", loaded)).toBe("inherit")
    expect(resolveAskSelection({ providerID: "p", id: "m1" }, "inherit")).toEqual({ providerID: "p", id: "m1" })
    expect(resolveAskSelection({ providerID: "p", id: "m1" }, { providerID: "p", id: "m1" })).toEqual({
      providerID: "p",
      id: "m1",
    })
  })

  test("binding status names the live server state and write capability", () => {
    expect(ownerBindingStatus({ server: "docs" }, [{ name: "docs", status: "connected" }])).toBe(
      "Server connected",
    )
    expect(ownerBindingStatus({ server: "docs" }, [{ name: "docs", status: "failed" }])).toBe("Server failed")
    expect(ownerBindingStatus({ server: "docs" }, [])).toBe("Server unreported")
    expect(
      ownerBindingStatus({ server: "docs", write: "replace", writeCapability: "revision-aware" }, [
        { name: "docs", status: "connected" },
      ]),
    ).toBe("Server connected · write requires approval · revision-aware")
    expect(
      ownerBindingStatus({ server: "docs", write: "replace", writeCapability: "manual-only" }, [
        { name: "docs", status: "connected" },
      ]),
    ).toBe("Server connected · write requires approval · manual proposals only")
  })
})
