import { expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const removed = /\b(setYolo|setAutoPermission|setAutoGuardrail|setAutoAnswer|autoPermission|autoGuardrail|autoAnswer|permissionsAuto|ordinaryReviewsAuto|permissionModelReviews|yoloLabel|autonomyDeciders)\b|"auto-(permission|guardrail|answer)"|\/yolo\b/

test("no web source reads or writes the removed independent autonomy flags or slash commands", async () => {
  const offenders: string[] = []
  for await (const file of new Glob("**/*.{ts,tsx,css}").scan({ cwd: root })) {
    if (/\.test\.tsx?$/.test(file) || file === "content/changelog.ts") continue
    const lines = (await Bun.file(path.join(root, file)).text()).split("\n")
    lines.forEach((line, index) => { if (removed.test(line)) offenders.push(`${file}:${index + 1}`) })
  }
  expect(offenders).toEqual([])
})

test("the Autonomous trigger and dialog replace the YOLO trigger and popover in the footer", async () => {
  const source = await Bun.file(path.join(root, "remote/ui/status-bar.tsx")).text()
  expect(source).toContain("AutonomousDialog")
  expect(source).toContain("aria-haspopup=\"dialog\"")
  expect(source).not.toMatch(/session-status__yolo|yoloTrigger|type="checkbox"/)
})

test("the Autonomous dialog uses the shared Modal for focus containment, Escape, and focus return", async () => {
  const source = await Bun.file(path.join(root, "remote/ui/autonomous-dialog.tsx")).text()
  expect(source).toContain("<Modal")
  expect(source).toContain("returnFocus")
  expect(source).not.toContain("setTimeout")
})
