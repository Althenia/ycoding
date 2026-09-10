import { describe, expect, test } from "bun:test"
import { MacOSComputer } from "@ycoding-ai/core/computer/macos"
import path from "node:path"
import {
  computerHelperBuild,
  computerHelperBuildAvailable,
  developmentComputerHelperBuild,
} from "../script/computer-helper"

describe("macOS computer helper packaging", () => {
  test("filters unsupported targets without planning a native helper", () => {
    expect(computerHelperBuild({ platform: "linux", arch: "x64" }, "/tmp/bin")).toBeUndefined()
    expect(computerHelperBuild({ platform: "win32", arch: "arm64" }, "/tmp/bin")).toBeUndefined()
  })

  test("plans a sibling helper for each supported macOS architecture", () => {
    const arm64 = computerHelperBuild({ platform: "darwin", arch: "arm64" }, "/tmp/bin")
    expect(arm64).toEqual({
      source: path.resolve(import.meta.dir, "../../core/computer-helper/main.swift"),
      output: "/tmp/bin/ycoding-computer-helper",
      target: "arm64-apple-macosx13.0",
    })
    expect(arm64?.output).toBe(MacOSComputer.helperPath("/tmp/bin/ycoding"))
    expect(computerHelperBuild({ platform: "darwin", arch: "x64" }, "/tmp/bin")).toMatchObject({
      output: "/tmp/bin/ycoding-computer-helper",
      target: "x86_64-apple-macosx13.0",
    })
  })

  test("keeps only complete artifacts when the host cannot compile the macOS helper", () => {
    expect(computerHelperBuildAvailable({ platform: "darwin", arch: "arm64" }, "linux")).toBe(false)
    expect(computerHelperBuildAvailable({ platform: "linux", arch: "x64" }, "linux")).toBe(true)
    expect(computerHelperBuildAvailable({ platform: "darwin", arch: "x64" }, "darwin")).toBe(true)
  })

  test("plans the explicit source-development helper in Core's ignored cache", () => {
    expect(developmentComputerHelperBuild()).toEqual({
      source: path.resolve(import.meta.dir, "../../core/computer-helper/main.swift"),
      output: path.resolve(import.meta.dir, "../../core/.cache/computer-helper/ycoding-computer-helper"),
      target: `${process.arch === "x64" ? "x86_64" : process.arch}-apple-macosx13.0`,
    })
  })
})
