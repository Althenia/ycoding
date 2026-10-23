import { expect, test } from "bun:test"
import { deviceAliasLimit, parseDeviceAliasRequest } from "../src/index"

test("device aliases accept trimmed bounded names and explicit null only", () => {
  expect(deviceAliasLimit).toBe(48)
  for (const alias of ["a", "x".repeat(48), "名称 🧭", "<b>literal</b>"])
    expect(parseDeviceAliasRequest({ alias: `  ${alias}  ` })).toEqual({ ok: true, value: { alias } })
  expect(parseDeviceAliasRequest({ alias: null })).toEqual({ ok: true, value: { alias: null } })
  for (const value of [null, [], {}, { alias: undefined }, { alias: "" }, { alias: " " }, { alias: "x".repeat(49) }, { alias: 1 }, { alias: false }, { alias: [] },
    { alias: "a\nb" }, { alias: "a\tb" }, { alias: "a\u0000b" }, { alias: "a\u007fb" }, { alias: "a\u0085b" }, { alias: "a\u2028b" }, { alias: "a\u2029b" }, { alias: null, name: "host" }, { alias: "name", deviceID: "dev_other" }])
    expect(parseDeviceAliasRequest(value).ok, JSON.stringify(value)).toBe(false)
})
