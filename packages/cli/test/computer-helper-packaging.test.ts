import { describe, expect, test } from "bun:test"
import { MacOSComputer } from "@ycoding-ai/core/computer/macos"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildComputerHelper,
  computerHelperBuild,
  computerHelperBuildAvailable,
  developmentComputerHelperBuild,
  verifyPackagedComputerHelper,
} from "../script/computer-helper"

const macTest = process.platform === "darwin" ? test : test.skip

describe("macOS computer helper packaging", () => {
  macTest(
    "builds a signed YCoding Computer Use app with the product icon",
    async () => {
      const bin = await mkdtemp(path.join(os.tmpdir(), "ycoding-computer-brand-"))
      try {
        await buildComputerHelper({ platform: "darwin", arch: process.arch === "x64" ? "x64" : "arm64" }, bin)
        const application = path.join(bin, "ycoding-computer-helper.app")
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
      source: path.resolve(import.meta.dir, "../../core/computer-helper/main.swift"),
      output: "/tmp/bin/ycoding-computer-helper",
      application: "/tmp/bin/ycoding-computer-helper.app",
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
      application: path.resolve(import.meta.dir, "../../core/.cache/computer-helper/ycoding-computer-helper.app"),
      target: `${process.arch === "x64" ? "x86_64" : process.arch}-apple-macosx13.0`,
    })
  })

  test("rejects a macOS package without the signed application bundle", async () => {
    const bin = await mkdtemp(path.join(os.tmpdir(), "ycoding-computer-package-"))
    try {
      const helper = path.join(bin, "ycoding-computer-helper")
      await Bun.write(helper, '#!/bin/sh\nprintf \'{"status":"error","code":"invalid_request","outcome":"not_started"}\\n\'\n')
      await chmod(helper, 0o755)
      await expect(verifyPackagedComputerHelper(bin, "darwin")).rejects.toThrow("Computer helper application")
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })

  test("rejects an unexpected macOS application bundle in a non-macOS package", async () => {
    const bin = await mkdtemp(path.join(os.tmpdir(), "ycoding-computer-package-"))
    try {
      await mkdir(path.join(bin, "ycoding-computer-helper.app"))
      await expect(verifyPackagedComputerHelper(bin, "linux")).rejects.toThrow("Unexpected macOS computer helper")
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })
})
