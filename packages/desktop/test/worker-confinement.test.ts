import { expect, test } from "bun:test"
import { profile } from "../src/backend-confinement"
import { confinedWorkerCommand } from "./isolation"

test("only the confined worker command adds read-data for its exact resource root", () => {
  const resources = "/synthetic/YCoding Desktop.app/Contents/Resources/app/runtime"
  const backend = { resources, executable: `${resources}/backend/ycoding`, directory: `${resources}/backend`, manifest: `${resources}/backend.json`, version: "synthetic" }
  const owned = "/synthetic/owned"
  const rules = profile({ owned, cwd: "/synthetic/cwd", backend, connect: [12_345, 23_456] })
  const resourceRead = `(allow file-read-data (literal "${resources}"))`
  expect(rules).not.toContain(resourceRead)
  expect(confinedWorkerCommand(rules, backend, owned)).toEqual([
    "/usr/bin/sandbox-exec", "-p", `${rules}\n${resourceRead}`, backend.executable, "desktop-client",
    "--resources", resources, "--preferences", `${owned}/preferences.json`,
  ])
})
