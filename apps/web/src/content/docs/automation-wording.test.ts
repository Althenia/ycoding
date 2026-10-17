import { describe, expect, test } from "bun:test"
import { DOC_PAGES, findDocPage } from "./registry"

const text = (slug: string) => JSON.stringify(findDocPage(slug)?.sections)

describe("automatic answer wording", () => {
  test("no public page promises unconditional automatic answers", () => {
    const stale = [
      "Also answer questions and Forms.",
      "Level 1 plus questions and deterministic forms.",
      "can still auto-answer questions and permissions",
      "An active goal auto-answers questions, forms",
      "An active goal also answers questions, forms",
      "`ask` and questions are answered automatically at any level.",
      "Under YOLO 2–3 or an active goal, single-select question auto-answering",
    ]
    for (const page of DOC_PAGES) for (const phrase of stale) expect(JSON.stringify(page.sections)).not.toContain(phrase)
  })

  test("YOLO, goal, and permission pages name the Session's own auto-answer as the condition for answers", () => {
    expect(text("configuration/yolo")).toContain("Automatic question and form answers require the Session's own `/auto-answer` on (default off)")
    expect(text("configuration/yolo")).toContain("independent of YOLO, goals, and sleep")
    expect(text("configuration/goal")).toContain("Automatic answers require the Session's own `/auto-answer` on.")
    expect(text("configuration/permissions")).toContain("Automatic answers need the Session's auto-answer on.")
    expect(text("configuration/tools")).toContain("With a Session's auto-answer on")
    expect(text("configuration/guardrails")).toContain("applies immediately to that Session only")
  })

  test("CLI and remote autonomy tables condition answers on the Session's auto-answer at level Ask first", () => {
    expect(text("usage/cli")).toContain("Automatic answers need the Session's auto-answer on")
    expect(text("usage/remote")).toContain("Automatic answers need this Session's auto-answer on")
    for (const slug of ["usage/cli", "usage/remote"]) {
      expect(text(slug)).toContain("Ask first")
      expect(text(slug)).toContain("Tools + reviews")
    }
  })

  test("auto-answer is a Session toggle, never a configuration key, and the YOLO levels end at 2", () => {
    const rows = JSON.stringify(findDocPage("configuration")?.sections)
    expect(rows).not.toContain("`auto_answer`")
    for (const slug of ["usage/tui", "usage/cli", "usage/remote", "configuration/yolo", "configuration/permissions", "configuration/tools"]) {
      expect(text(slug)).not.toContain("auto_answer")
      expect(text(slug)).not.toContain("YOLO 3")
    }
  })
})
