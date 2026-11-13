import { expect, test } from "bun:test"
import { dotenvEntries, signingConfiguration } from "../script/signing-preflight"
import config from "../electrobun.config"

test("matches dotenv entries by filename only, case-insensitively", () => {
  expect(dotenvEntries([".env", ".env.local", ".ENV.production", ".envrc", "env", "package.json", ".gitignore", "environment.ts"])).toEqual([".env", ".env.local", ".ENV.production", ".envrc"])
  expect(dotenvEntries([])).toEqual([])
})

test("reports signing environment names without values", () => {
  const names = signingConfiguration({ PATH: "/usr/bin", YCODING_MACOS_SIGNING_IDENTITY: "synthetic-secret", APPLE_ID: "", YCODING_MACOS_SIGNING_KEYCHAIN: "synthetic-secret" }, config)
  expect(names).toEqual(["YCODING_MACOS_SIGNING_IDENTITY", "YCODING_MACOS_SIGNING_KEYCHAIN", "APPLE_ID"])
  expect(JSON.stringify(names)).not.toContain("synthetic-secret")
})

test("refuses enabled or missing signing options and accepts the unsigned config", () => {
  expect(signingConfiguration({}, config)).toEqual([])
  expect(signingConfiguration({}, { build: { mac: { codesign: true, notarize: false, createDmg: false } } })).toEqual(["electrobun.config.ts build.mac.codesign"])
  expect(signingConfiguration({}, {})).toHaveLength(3)
  expect(signingConfiguration({ ELECTROBUN_DEVELOPER_ID: "synthetic" }, config)).toEqual(["ELECTROBUN_DEVELOPER_ID"])
})

test("reports a configured models snapshot override by name without its path", () => {
  const names = signingConfiguration({ MODELS_DEV_API_JSON: "/synthetic/private/models.json" }, config)
  expect(names).toEqual(["MODELS_DEV_API_JSON"])
  expect(JSON.stringify(names)).not.toContain("/synthetic")
  expect(signingConfiguration({ MODELS_DEV_API_JSON: "" }, config)).toEqual(["MODELS_DEV_API_JSON"])
  expect(signingConfiguration({ MODELS_DEV_API_JSON: undefined }, config)).toEqual(["MODELS_DEV_API_JSON"])
  expect(signingConfiguration({ PATH: "/usr/bin" }, config)).toEqual([])
})

test("detects configured names by property presence without reading any value", () => {
  const env: Record<string, string | undefined> = {}
  for (const name of ["APPLE_ID", "MODELS_DEV_API_JSON", "YCODING_MACOS_SIGNING_IDENTITY"])
    Object.defineProperty(env, name, { enumerable: true, get: () => { throw new Error(`${name} value was read`) } })
  expect(signingConfiguration(env, config)).toEqual(["YCODING_MACOS_SIGNING_IDENTITY", "MODELS_DEV_API_JSON", "APPLE_ID"])
})

test("reports build-time client secret environment names without values", () => {
  const names = signingConfiguration({ YCODING_ANTIGRAVITY_CLIENT_SECRET: "synthetic-secret", YCODING_MUSE_CLIENT_SECRET: "synthetic-secret" }, config)
  expect(names).toEqual(["YCODING_ANTIGRAVITY_CLIENT_SECRET", "YCODING_MUSE_CLIENT_SECRET"])
  expect(JSON.stringify(names)).not.toContain("synthetic-secret")
})
