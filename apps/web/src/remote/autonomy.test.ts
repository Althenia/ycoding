import { describe, expect, test } from "bun:test"
import {
  autonomyAnnouncement,
  autonomyChange,
  autonomyDefaultAnnouncement,
  autonomyDefaultChange,
  autonomyKeyIntent,
  autonomyLabels,
  autonomyRows,
  autonomySummary,
  autonomyTone,
  requiresYoloConfirmation,
  cycleAutonomyMode,
  readAutonomyDefaults,
  type AutonomyModes,
  type EffectiveAutonomyView,
} from "./autonomy"

const manual: AutonomyModes = { permissions: "manual", guardrails: "manual", answers: "manual" }
const effective = (change: Partial<EffectiveAutonomyView> = {}): EffectiveAutonomyView => ({ ...manual, inherited: {}, deferred: false, guardrailsEnabled: true, ...change })
const key = (name: string, modifiers: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers })

test("only entering YOLO requires risk acceptance", () => {
  expect(requiresYoloConfirmation(manual, { permissions: "yolo" })).toBe(true)
  expect(requiresYoloConfirmation(manual, { permissions: "yolo", guardrails: "yolo", answers: "yolo" })).toBe(true)
  expect(requiresYoloConfirmation({ ...manual, permissions: "yolo" }, { permissions: "yolo" })).toBe(false)
  expect(requiresYoloConfirmation(manual, { guardrails: "auto" })).toBe(false)
})

describe("cycling", () => {
  test("steps Manual, YOLO, Auto in that order and wraps both ways", () => {
    expect(cycleAutonomyMode("manual", 1)).toBe("yolo")
    expect(cycleAutonomyMode("yolo", 1)).toBe("auto")
    expect(cycleAutonomyMode("auto", 1)).toBe("manual")
    expect(cycleAutonomyMode("manual", -1)).toBe("auto")
    expect(cycleAutonomyMode("auto", -1)).toBe("yolo")
    expect(cycleAutonomyMode("yolo", -1)).toBe("manual")
  })

  test("a cycle changes exactly one category from this Session's own value", () => {
    expect(autonomyChange({ type: "cycle", category: "guardrails", step: 1 }, { ...manual, guardrails: "auto" })).toEqual({ guardrails: "manual" })
    expect(autonomyChange({ type: "cycle", category: "answers", step: -1 }, manual)).toEqual({ answers: "auto" })
  })

  test("set-all names all three categories in one change", () => {
    for (const mode of ["manual", "yolo", "auto"] as const)
      expect(autonomyChange({ type: "all", mode }, { permissions: "auto", guardrails: "yolo", answers: "manual" })).toEqual({ permissions: mode, guardrails: mode, answers: mode })
  })
})

describe("keyboard", () => {
  test.each([
    ["ArrowDown", 0, { type: "select", index: 1 }],
    ["ArrowDown", 2, { type: "select", index: 2 }],
    ["ArrowUp", 2, { type: "select", index: 1 }],
    ["ArrowUp", 0, { type: "select", index: 0 }],
    ["ArrowRight", 1, { type: "cycle", category: "guardrails", step: 1 }],
    ["ArrowLeft", 2, { type: "cycle", category: "answers", step: -1 }],
    ["1", 1, { type: "all", mode: "manual" }],
    ["2", 0, { type: "all", mode: "yolo" }],
    ["3", 2, { type: "all", mode: "auto" }],
    ["d", 1, { type: "save-default", category: "guardrails" }],
    ["D", 0, { type: "save-default", category: "permissions" }],
    ["r", 2, { type: "reset-default", category: "answers" }],
  ] as const)("%s on row %i", (name, selected, intent) => {
    expect(autonomyKeyIntent(key(name), selected)).toEqual(intent)
  })

  test("other keys and modified keys are left to the browser", () => {
    for (const name of ["0", "4", "a", "Enter", "Tab", " ", "Escape"]) expect(autonomyKeyIntent(key(name), 0)).toBeUndefined()
    for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const) {
      expect(autonomyKeyIntent(key("1", { [modifier]: true }), 0)).toBeUndefined()
      expect(autonomyKeyIntent(key("ArrowRight", { [modifier]: true }), 0)).toBeUndefined()
    }
  })
})

describe("saved defaults", () => {
  test("a save names the Session's own mode for that category", () => {
    const own = { ...manual, answers: "auto" } as const
    expect(autonomyDefaultChange({ type: "save-default", category: "answers" }, own)).toEqual({ answers: "auto" })
    expect(autonomyDefaultChange({ type: "save-default", category: "permissions" }, own)).toEqual({ permissions: "manual" })
  })

  test("a reset names Manual for that category alone", () => {
    expect(autonomyDefaultChange({ type: "reset-default", category: "guardrails" }, { permissions: "yolo", guardrails: "auto", answers: "yolo" })).toEqual({ guardrails: "manual" })
  })

  test("saving YOLO needs acceptance unless that default is already YOLO; Manual and Auto never do", () => {
    const saved: AutonomyModes = { permissions: "yolo", guardrails: "auto", answers: "manual" }
    expect(requiresYoloConfirmation(saved, { guardrails: "yolo" })).toBe(true)
    expect(requiresYoloConfirmation(saved, { permissions: "yolo" })).toBe(false)
    expect(requiresYoloConfirmation(saved, { permissions: "manual" })).toBe(false)
    expect(requiresYoloConfirmation(saved, { answers: "auto" })).toBe(false)
  })

  test("rows carry the saved default beside the Session's effective mode", () => {
    const rows = autonomyRows({ ...manual, effective: effective({ permissions: "auto", inherited: { permissions: "ses_parent" } }) }, { permissions: "yolo", guardrails: "manual", answers: "auto" })
    expect(rows.map((row) => [row.mode, row.saved])).toEqual([["auto", "yolo"], ["manual", "manual"], ["manual", "auto"]])
    expect(autonomyRows(manual).every((row) => row.saved === undefined)).toBe(true)
  })

  test("reads only a complete answer with known modes", () => {
    expect(readAutonomyDefaults({ data: { permissions: "yolo", guardrails: "auto", answers: "manual", yoloAcceptedAt: { permissions: 1 } } })).toEqual({ permissions: "yolo", guardrails: "auto", answers: "manual" })
    for (const payload of [undefined, null, {}, { data: null }, { data: { permissions: "yolo", guardrails: "auto" } }, { data: { ...manual, answers: "sometimes" } }])
      expect(readAutonomyDefaults(payload)).toBeUndefined()
  })

  test("announces each saved or reset category for new Sessions", () => {
    expect(autonomyDefaultAnnouncement({ guardrails: "yolo" })).toBe("Guardrails default saved as YOLO for new Sessions")
    expect(autonomyDefaultAnnouncement({ answers: "manual" })).toBe("Answers default reset to Manual for new Sessions")
  })
})

describe("effective rows", () => {
  test("list Permissions, Guardrails, and Answers in order with the Session's own and effective modes", () => {
    const rows = autonomyRows({ permissions: "auto", guardrails: "yolo", answers: "manual", effective: effective({ permissions: "auto", guardrails: "yolo", answers: "manual" }) })
    expect(rows.map((row) => [row.category, row.title, row.own, row.mode, row.label])).toEqual([
      ["permissions", "Permissions", "auto", "auto", "Auto"],
      ["guardrails", "Guardrails", "yolo", "yolo", "YOLO"],
      ["answers", "Answers", "manual", "manual", "Manual"],
    ])
    expect(rows.every((row) => row.inheritedFrom === undefined)).toBe(true)
  })

  test("an inherited mode is the effective mode and names its source, never Manual", () => {
    const rows = autonomyRows({
      ...manual,
      effective: effective({ permissions: "auto", answers: "yolo", inherited: { permissions: "ses_parent", answers: "ses_root" } }),
    })
    expect(rows.map((row) => [row.own, row.mode, row.label, row.inheritedFrom])).toEqual([
      ["manual", "auto", "Auto", "ses_parent"],
      ["manual", "manual", "Manual", undefined],
      ["manual", "yolo", "YOLO", "ses_root"],
    ])
  })

  test("without an effective answer the rows read the Session's own modes", () => {
    expect(autonomyRows({ permissions: "yolo", guardrails: "auto", answers: "manual" }).map((row) => row.mode)).toEqual(["yolo", "auto", "manual"])
  })

  test("name who decides each category by effective mode", () => {
    const decide = (modes: AutonomyModes, change: Partial<EffectiveAutonomyView> = {}) => autonomyRows({ ...modes, effective: effective({ ...modes, ...change }) }).map((row) => row.decider)
    expect(decide(manual)).toEqual(["You decide each permission ask", "You decide each review", "You answer each question"])
    expect(decide(manual, { deferred: true })).toEqual(["Review box holds unresolved permission asks", "Review box holds unresolved reviews", "Review box holds unresolved questions"])
    expect(decide({ permissions: "yolo", guardrails: "yolo", answers: "yolo" })).toEqual([
      "YOLO bypasses permission blockers",
      "YOLO bypasses all guardrail blockers",
      "YOLO answers all questions, including free text",
    ])
    expect(decide({ permissions: "auto", guardrails: "auto", answers: "auto" })).toEqual([
      "Rules approve permission asks; denies still block",
      "Routine reviews are approved; hard reviews still need you",
      "Explicit defaults or the one Recommended option answer; the rest reach you",
    ])
    expect(decide({ permissions: "auto", guardrails: "auto", answers: "auto" }, { deferred: true })[1]).toBe("Review box holds unresolved reviews while deferred")
    expect(decide({ permissions: "auto", guardrails: "auto", answers: "auto" }, { deferred: true })[2]).toBe("Explicit defaults or the one Recommended option answer; the rest wait in Review")
    expect(decide({ permissions: "auto", guardrails: "auto", answers: "auto" }, { guardrailsEnabled: false })[1]).toBe("Ordinary reviews are disabled; hard reviews still need you")
  })
})

describe("labels", () => {
  test("uniform modes read as one Autonomous label and mixed modes name every category", () => {
    expect(autonomyLabels(manual)).toEqual(["Autonomous Manual"])
    expect(autonomyLabels({ permissions: "yolo", guardrails: "yolo", answers: "yolo" })).toEqual(["Autonomous YOLO"])
    expect(autonomyLabels({ permissions: "auto", guardrails: "auto", answers: "auto" })).toEqual(["Autonomous Auto"])
    expect(autonomyLabels({ permissions: "auto", guardrails: "yolo", answers: "manual" })).toEqual(["Permissions Auto", "Guardrails YOLO", "Answers Manual"])
  })

  test("the summary carries the trigger text and per-category chips for mixed modes", () => {
    expect(autonomySummary(manual)).toEqual({ label: "Autonomous Manual", chips: [] })
    expect(autonomySummary({ permissions: "auto", guardrails: "auto", answers: "auto" })).toEqual({ label: "Autonomous Auto", chips: [] })
    expect(autonomySummary({ permissions: "yolo", guardrails: "yolo", answers: "yolo" }).label).toBe("Autonomous YOLO")
    expect(autonomySummary({ permissions: "auto", guardrails: "yolo", answers: "manual" })).toEqual({
      label: "Autonomous",
      chips: [
        { key: "permissions", label: "Permissions Auto", mode: "auto" },
        { key: "guardrails", label: "Guardrails YOLO", mode: "yolo" },
        { key: "answers", label: "Answers Manual", mode: "manual" },
      ],
    })
  })

  test("YOLO anywhere draws attention and everything else stays neutral", () => {
    expect(autonomyTone(manual)).toBe("neutral")
    expect(autonomyTone({ permissions: "auto", guardrails: "auto", answers: "auto" })).toBe("neutral")
    expect(autonomyTone({ permissions: "auto", guardrails: "yolo", answers: "manual" })).toBe("attention")
  })
})

describe("announcements", () => {
  const rowsFor = (own: AutonomyModes, change: Partial<EffectiveAutonomyView> = {}) => autonomyRows({ ...own, effective: effective({ ...own, ...change }) })

  test("a local write reads as this Session's own setting", () => {
    const all = { permissions: "manual", guardrails: "manual", answers: "manual" } as const
    expect(autonomyAnnouncement(all, rowsFor(all))).toBe("This Session's categories set to Manual")
    const one = { ...manual, answers: "auto" } as const
    expect(autonomyAnnouncement({ answers: "auto" }, rowsFor(one))).toBe("Answers set to Auto for this Session")
  })

  test("a set-all that inherited authority outranks still announces the mode in effect and its source", () => {
    const own = { permissions: "manual", guardrails: "manual", answers: "manual" } as const
    const rows = rowsFor(own, { permissions: "auto", answers: "yolo", inherited: { permissions: "ses_parent", answers: "ses_root" } })
    expect(autonomyAnnouncement(own, rows)).toBe("This Session's categories set to Manual; in effect Permissions Auto (inherited from ses_parent), Answers YOLO (inherited from ses_root)")
    expect(autonomyAnnouncement(own, rows)).not.toBe("This Session's categories set to Manual")
  })

  test("a single change announces the inherited mode in effect", () => {
    const own = { ...manual, permissions: "manual" } as const
    const rows = rowsFor(own, { permissions: "auto", inherited: { permissions: "ses_parent" } })
    expect(autonomyAnnouncement({ permissions: "manual" }, rows)).toBe("Permissions set to Manual for this Session; in effect Auto (inherited from ses_parent)")
  })

  test("a set-all with mixed values lists each category", () => {
    const own = { permissions: "auto", guardrails: "auto", answers: "auto" } as const
    expect(autonomyAnnouncement(own, rowsFor(own))).toBe("This Session's categories set to Auto")
    expect(autonomyAnnouncement({ permissions: "auto", guardrails: "yolo" }, rowsFor({ permissions: "auto", guardrails: "yolo", answers: "manual" })))
      .toBe("Permissions set to Auto, Guardrails set to YOLO for this Session")
  })
})
