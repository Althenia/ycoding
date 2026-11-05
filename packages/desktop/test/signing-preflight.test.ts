import { expect, test } from "bun:test"
import { dotenvEntries, signingConfiguration } from "../script/signing-preflight"

test("matches dotenv entries by filename only, case-insensitively", () => {
  expect(dotenvEntries([".env", ".env.local", ".ENV.production", ".envrc", "env", "package.json", ".gitignore", "environment.ts"])).toEqual([".env", ".env.local", ".ENV.production", ".envrc"])
  expect(dotenvEntries([])).toEqual([])
})

test("reports signing environment names without values", () => {
  const names = signingConfiguration({ PATH: "/usr/bin", YCODING_MACOS_SIGNING_IDENTITY: "synthetic-secret", APPLE_ID: "", YCODING_MACOS_SIGNING_KEYCHAIN: "synthetic-secret" }, {})
  expect(names).toEqual(["YCODING_MACOS_SIGNING_IDENTITY", "YCODING_MACOS_SIGNING_KEYCHAIN", "APPLE_ID"])
  expect(JSON.stringify(names)).not.toContain("synthetic-secret")
})

test("reports configured Tauri macOS signing and accepts an unsigned setup", () => {
  expect(signingConfiguration({}, { bundle: { macOS: { signingIdentity: "-", minimumSystemVersion: "13.3" } } })).toEqual(["tauri.conf.json bundle.macOS.signingIdentity"])
  expect(signingConfiguration({ PATH: "/usr/bin" }, { bundle: { macOS: { minimumSystemVersion: "13.3" } } })).toEqual([])
})

test("reports alternate and platform Tauri configuration files by presence", () => {
  expect(signingConfiguration({}, {}, ["tauri.conf.json", "tauri.macos.conf.json", "Tauri.macos.toml", "Cargo.toml"])).toEqual(["src-tauri/tauri.macos.conf.json", "src-tauri/Tauri.macos.toml"])
  expect(signingConfiguration({ TAURI_CONFIG: "{}" }, {}, [])).toEqual(["TAURI_CONFIG"])
  expect(signingConfiguration({}, {}, ["TAURI.MACOS.CONF.JSON", "TAURI.toml"])).toEqual(["src-tauri/TAURI.MACOS.CONF.JSON", "src-tauri/TAURI.toml"])
})

test("reports a configured models snapshot override by name without its path", () => {
  const names = signingConfiguration({ MODELS_DEV_API_JSON: "/synthetic/private/models.json" }, {})
  expect(names).toEqual(["MODELS_DEV_API_JSON"])
  expect(JSON.stringify(names)).not.toContain("/synthetic")
  expect(signingConfiguration({ MODELS_DEV_API_JSON: "" }, {})).toEqual(["MODELS_DEV_API_JSON"])
  expect(signingConfiguration({ MODELS_DEV_API_JSON: undefined }, {})).toEqual(["MODELS_DEV_API_JSON"])
  expect(signingConfiguration({ PATH: "/usr/bin" }, {})).toEqual([])
})

test("detects configured names by property presence without reading any value", () => {
  const env: Record<string, string | undefined> = {}
  for (const name of ["APPLE_ID", "MODELS_DEV_API_JSON", "YCODING_MACOS_SIGNING_IDENTITY"])
    Object.defineProperty(env, name, { enumerable: true, get: () => { throw new Error(`${name} value was read`) } })
  expect(signingConfiguration(env, {})).toEqual(["YCODING_MACOS_SIGNING_IDENTITY", "MODELS_DEV_API_JSON", "APPLE_ID"])
})

test("reports build-time client secret environment names without values", () => {
  const names = signingConfiguration({ YCODING_ANTIGRAVITY_CLIENT_SECRET: "synthetic-secret", YCODING_MUSE_CLIENT_SECRET: "synthetic-secret" }, {})
  expect(names).toEqual(["YCODING_ANTIGRAVITY_CLIENT_SECRET", "YCODING_MUSE_CLIENT_SECRET"])
  expect(JSON.stringify(names)).not.toContain("synthetic-secret")
})
