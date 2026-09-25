import { describe, expect, test } from "bun:test"
import { MacOSComputer } from "@ycoding-ai/core/computer/macos"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildComputerHelper,
  computerHelperBuild,
  computerHelperBuildAvailable,
  developmentComputerHelperBuild,
  signingArguments,
  verifyPackagedComputerHelper,
} from "../script/computer-use"

const macTest = process.platform === "darwin" ? test : test.skip

describe("macOS computer helper packaging", () => {
  macTest(
    "builds a signed YCoding Computer Use app with the product icon",
    async () => {
      const bin = await mkdtemp(path.join(os.tmpdir(), "ycoding-computer-brand-"))
      try {
        await buildComputerHelper({ platform: "darwin", arch: process.arch === "x64" ? "x64" : "arm64" }, bin)
        const application = path.join(bin, "YCoding Computer Use.app")
        expect(await readdir(bin)).toEqual(["YCoding Computer Use.app"])
        const plist = path.join(application, "Contents", "Info.plist")
        const displayName = Bun.spawnSync([
          "/usr/bin/plutil",
          "-extract",
          "CFBundleDisplayName",
          "raw",
          "-o",
          "-",
          plist,
        ])
        expect(displayName.exitCode).toBe(0)
        expect(displayName.stdout.toString().trim()).toBe("YCoding Computer Use")
        const identifier = Bun.spawnSync(["/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", plist])
        expect(identifier.stdout.toString().trim()).toBe("app.ycoding.computer-use")
        const executable = Bun.spawnSync(["/usr/bin/plutil", "-extract", "CFBundleExecutable", "raw", "-o", "-", plist])
        expect(executable.stdout.toString().trim()).toBe("ycoding-computer-use")
        const automation = Bun.spawnSync(["/usr/bin/plutil", "-extract", "NSAppleEventsUsageDescription", "raw", "-o", "-", plist])
        expect(automation.exitCode).toBe(0)
        expect(automation.stdout.toString().trim()).toContain("YCoding Computer Use")
        const icon = Bun.spawnSync(["/usr/bin/plutil", "-extract", "CFBundleIconFile", "raw", "-o", "-", plist])
        expect(icon.exitCode).toBe(0)
        expect(icon.stdout.toString().trim()).toBe("YCoding.icns")
        const image = Bun.spawnSync([
          "/usr/bin/sips",
          "-g",
          "format",
          path.join(application, "Contents/Resources/YCoding.icns"),
        ])
        expect(image.exitCode).toBe(0)
        expect(image.stdout.toString()).toContain("format: icns")
        expect(Bun.spawnSync(["/usr/bin/codesign", "--verify", "--deep", "--strict", application]).exitCode).toBe(0)
      } finally {
        await rm(bin, { recursive: true, force: true })
      }
    },
    120_000,
  )

  test("filters unsupported targets without planning a native helper", () => {
    expect(computerHelperBuild({ platform: "linux", arch: "x64" }, "/tmp/bin")).toBeUndefined()
    expect(computerHelperBuild({ platform: "win32", arch: "arm64" }, "/tmp/bin")).toBeUndefined()
  })

  test("plans a sibling helper for each supported macOS architecture", () => {
    const arm64 = computerHelperBuild({ platform: "darwin", arch: "arm64" }, "/tmp/bin")
    expect(arm64).toEqual({
      source: path.resolve(import.meta.dir, "../../core/computer-use/main.swift"),
      application: "/tmp/bin/YCoding Computer Use.app",
      target: "arm64-apple-macosx13.0",
    })
    expect(arm64?.application).toBe(MacOSComputer.applicationPath("/tmp/bin/ycoding"))
    expect(computerHelperBuild({ platform: "darwin", arch: "x64" }, "/tmp/bin")).toMatchObject({
      application: "/tmp/bin/YCoding Computer Use.app",
      target: "x86_64-apple-macosx13.0",
    })
  })

  test("signs with a configured stable identity and a secure timestamp, otherwise ad hoc", () => {
    expect(signingArguments("/tmp/bin/YCoding Computer Use.app", "Developer ID Application: Example (TEAM123456)")).toEqual([
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "Developer ID Application: Example (TEAM123456)",
      "--timestamp",
      "/tmp/bin/YCoding Computer Use.app",
    ])
    expect(signingArguments("/tmp/bin/YCoding Computer Use.app", "")).toEqual([
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "/tmp/bin/YCoding Computer Use.app",
    ])
  })

  test("keeps only complete artifacts when the host cannot compile the macOS helper", () => {
    expect(computerHelperBuildAvailable({ platform: "darwin", arch: "arm64" }, "linux")).toBe(false)
    expect(computerHelperBuildAvailable({ platform: "linux", arch: "x64" }, "linux")).toBe(true)
    expect(computerHelperBuildAvailable({ platform: "darwin", arch: "x64" }, "darwin")).toBe(true)
  })

  test("plans the explicit source-development helper in Core's ignored cache", () => {
    expect(developmentComputerHelperBuild()).toEqual({
      source: path.resolve(import.meta.dir, "../../core/computer-use/main.swift"),
      application: path.resolve(import.meta.dir, "../../core/.cache/computer-use/YCoding Computer Use.app"),
      target: `${process.arch === "x64" ? "x86_64" : process.arch}-apple-macosx13.0`,
    })
  })

  test("rejects a macOS package without the signed application bundle", async () => {
    const bin = await mkdtemp(path.join(os.tmpdir(), "ycoding-computer-package-"))
    try {
      await expect(verifyPackagedComputerHelper(bin, "darwin")).rejects.toThrow("Computer helper application")
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })

  test("rejects an unexpected macOS application bundle in a non-macOS package", async () => {
    const bin = await mkdtemp(path.join(os.tmpdir(), "ycoding-computer-package-"))
    try {
      await mkdir(path.join(bin, "YCoding Computer Use.app"))
      await expect(verifyPackagedComputerHelper(bin, "linux")).rejects.toThrow("Unexpected macOS computer helper")
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })
})
