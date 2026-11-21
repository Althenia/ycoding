import { expect, test } from "bun:test"
import { nativeBuildTarget } from "../script/native-target"

test.each([
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "x64"],
  ["win32", "x64"],
] as const)("default and single builds select only the supported %s-%s host", (os, arch) => {
  expect(nativeBuildTarget({ os, arch })).toEqual({ os, arch })
  expect(nativeBuildTarget({ os, arch, single: true })).toEqual({ os, arch })
})

test("requested targets must match a supported host and baseline is limited to x64", () => {
  expect(nativeBuildTarget({ os: "linux", arch: "x64", target: "linux-x64", baseline: true })).toEqual({ os: "linux", arch: "x64", avx2: false })
  expect(nativeBuildTarget({ os: "win32", arch: "x64", target: "win32-x64" })).toEqual({ os: "win32", arch: "x64" })
  expect(() => nativeBuildTarget({ os: "darwin", arch: "arm64", baseline: true })).toThrow()
  for (const [os, arch] of [["linux", "arm64"], ["win32", "arm64"], ["freebsd", "x64"]])
    expect(() => nativeBuildTarget({ os, arch })).toThrow()
  for (const target of ["linux-arm64", "win32-arm64", "linux-x64-musl", "darwin-arm64"])
    expect(() => nativeBuildTarget({ os: "linux", arch: "x64", target })).toThrow()
})
