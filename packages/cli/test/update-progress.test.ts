import { expect, test } from "bun:test"
import { UpdateProgress } from "../src/update/progress"

test("renders a proportional download bar with sizes", () => {
  expect(UpdateProgress.format({ phase: "download", received: 0, total: 40 * 1024 * 1024 }, 20)).toBe(
    "Downloading [░░░░░░░░░░░░░░░░░░░░]   0%  0.0/40.0 MB",
  )
  expect(UpdateProgress.format({ phase: "download", received: 10 * 1024 * 1024, total: 40 * 1024 * 1024 }, 20)).toBe(
    "Downloading [█████░░░░░░░░░░░░░░░]  25% 10.0/40.0 MB",
  )
  expect(UpdateProgress.format({ phase: "download", received: 40 * 1024 * 1024, total: 40 * 1024 * 1024 }, 20)).toBe(
    "Downloading [████████████████████] 100% 40.0/40.0 MB",
  )
})

test("renders received size when the release omits its length", () => {
  expect(UpdateProgress.format({ phase: "download", received: 3 * 1024 * 1024 }, 20)).toBe("Downloading 3.0 MB")
})

test("renders verification and installation phases", () => {
  expect(UpdateProgress.format({ phase: "verify" }, 20)).toBe("Verifying checksum")
  expect(UpdateProgress.format({ phase: "install" }, 20)).toBe("Installing")
})

test("redraws one terminal line only when the rendered text changes and ends it once", () => {
  const writes: string[] = []
  const reporter = UpdateProgress.terminal({ write: (text) => writes.push(text), interactive: true, width: 20 })
  reporter.report({ phase: "download", received: 0, total: 100 })
  reporter.report({ phase: "download", received: 0, total: 100 })
  reporter.report({ phase: "download", received: 100, total: 100 })
  reporter.report({ phase: "verify" })
  reporter.report({ phase: "install" })
  reporter.end()
  expect(writes).toEqual([
    "\r\x1b[2KDownloading [░░░░░░░░░░░░░░░░░░░░]   0% 0.0/0.0 MB",
    "\r\x1b[2KDownloading [████████████████████] 100% 0.0/0.0 MB",
    "\r\x1b[2KVerifying checksum",
    "\r\x1b[2KInstalling",
    "\n",
  ])
})

test("prints each phase once without redraws when output is not a terminal", () => {
  const writes: string[] = []
  const reporter = UpdateProgress.terminal({ write: (text) => writes.push(text), interactive: false, width: 20 })
  reporter.report({ phase: "download", received: 0, total: 100 })
  reporter.report({ phase: "download", received: 100, total: 100 })
  reporter.report({ phase: "verify" })
  reporter.report({ phase: "install" })
  reporter.end()
  expect(writes).toEqual(["Downloading\n", "Verifying checksum\n", "Installing\n"])
})
