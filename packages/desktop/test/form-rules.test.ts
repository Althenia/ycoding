import { expect, test } from "bun:test"
import type { Messages, ModelOption, SessionItem, Sessions } from "../src/contract"
import { DESKTOP_BUILT_IN_SLASH_COMMANDS, DESKTOP_THEMES, desktopSlashCommand, formatSessionExportMarkdown, isDesktopThemeID, parsePromptStashes, pushPromptStash, resolveDesktopTheme, validateFolderSegment, type DesktopThemeID } from "../src/form-rules"
import { classifyDesktopSynthetic, desktopMessageVisible, desktopPartVisible, effortStopFraction, effortStopIndex, effortStopsFor, groupAssistantParts, isInternalTranscriptEnvelope, toolDisplaySummary, visibleDesktopMessages, type AssistantContentPart, activeFields, answerOf, appendPage, buildAnswer, choiceProblem, composerTrigger, insertCompletion, invalidIndexes, mentionPayload, restoresFocus, samePaging, slashAction, visibleModels, workspaceBase, mergeItems, pagedItems, pagingFor, railGroups, searchLimit, searchTerm, chooseModel, chooseProfile, choiceFor, initialValues, matches, modelLabel, problemOf, profileLabel, sameSelection, selectionFor, valueFor, variantsFor, withValue, type Field } from "../src/form-rules"

import { formatCompactCount, formatCount, formatDurationMs, formatPercent, formatQuotaProviders, formatQuotaWindow, formatUsd } from "../src/form-rules"

const text = (key: string, extra: Partial<Extract<Field, { type: "string" }>> = {}): Field => ({ key, type: "string", ...extra })

test("when rules compare typed values", () => {
  expect(matches({ key: "n", op: "eq", value: 3 }, 3)).toBe(true)
  expect(matches({ key: "n", op: "eq", value: 3 }, "3")).toBe(false)
  expect(matches({ key: "b", op: "eq", value: true }, true)).toBe(true)
  expect(matches({ key: "b", op: "neq", value: true }, false)).toBe(true)
  expect(matches({ key: "s", op: "neq", value: "a" }, "b")).toBe(true)
})

test("a multiselect answer matches eq when it includes the value and neq when it does not", () => {
  expect(matches({ key: "m", op: "eq", value: "a" }, ["a", "b"])).toBe(true)
  expect(matches({ key: "m", op: "eq", value: "a,b" }, ["a", "b"])).toBe(false)
  expect(matches({ key: "m", op: "neq", value: "c" }, ["a", "b"])).toBe(true)
  expect(matches({ key: "m", op: "neq", value: "a" }, ["a", "b"])).toBe(false)
})

test("an unanswered referenced field makes the condition false for both operators", () => {
  expect(matches({ key: "x", op: "eq", value: "a" }, undefined)).toBe(false)
  expect(matches({ key: "x", op: "neq", value: "a" }, undefined)).toBe(false)
})

test("hiding a field falsifies every condition that references it", () => {
  const fields: Field[] = [
    { key: "kind", type: "string", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    { key: "detail", type: "string", when: [{ key: "kind", op: "eq", value: "a" }] },
    { key: "extra", type: "string", when: [{ key: "detail", op: "neq", value: "x" }] },
  ]
  expect(activeFields(fields, { kind: "a", detail: "y", extra: "" }).map((item) => item.key)).toEqual(["kind", "detail", "extra"])
  expect(activeFields(fields, { kind: "b", detail: "y", extra: "" }).map((item) => item.key)).toEqual(["kind"])
  expect(activeFields(fields, { kind: "a", detail: "", extra: "" }).map((item) => item.key)).toEqual(["kind", "detail"])
})

test("number answers are typed and empty answers are absent", () => {
  expect(answerOf({ key: "n", type: "number" }, "4.5")).toBe(4.5)
  expect(answerOf({ key: "n", type: "integer" }, "")).toBeUndefined()
  expect(answerOf({ key: "n", type: "number" }, "abc")).toBeUndefined()
  expect(answerOf({ key: "m", type: "multiselect", options: [] }, [])).toBeUndefined()
  expect(answerOf({ key: "b", type: "boolean" }, false)).toBe(false)
})

test("string constraints, pattern and formats follow the server rules", () => {
  expect(problemOf(text("a", { required: true }), "")).toBe("Required.")
  expect(problemOf(text("a", { minLength: 3 }), "ab")).toBe("Use at least 3 characters.")
  expect(problemOf(text("a", { maxLength: 2 }), "abc")).toBe("Use at most 2 characters.")
  expect(problemOf(text("a", { pattern: "^[a-z]+$" }), "abc")).toBeUndefined()
  expect(problemOf(text("a", { pattern: "^[a-z]+$" }), "ab1")).toBe("Does not match the required pattern.")
  expect(problemOf(text("a", { pattern: "(" }), "x")).toContain("pattern is invalid")
  expect(problemOf(text("a", { format: "email" }), "a@b.co")).toBeUndefined()
  expect(problemOf(text("a", { format: "email" }), "a@b")).toBe("Enter an email address.")
  expect(problemOf(text("a", { format: "uri" }), "https://example.com/x")).toBeUndefined()
  expect(problemOf(text("a", { format: "uri" }), "not a url")).toBe("Enter a full URL such as https://example.com.")
  expect(problemOf(text("a", { format: "date" }), "2026-02-28")).toBeUndefined()
  expect(problemOf(text("a", { format: "date" }), "2026-02-30")).toBe("Enter a real date as YYYY-MM-DD.")
  expect(problemOf(text("a", { format: "date" }), "2026-2-3")).toBe("Enter a real date as YYYY-MM-DD.")
  expect(problemOf(text("a", { format: "date-time" }), "2026-11-04T10:00:00Z")).toBeUndefined()
  expect(problemOf(text("a", { format: "date-time" }), "yesterday-ish")).toBe("Enter a valid date and time.")
})

test("number, integer and multiselect bounds are enforced", () => {
  expect(problemOf({ key: "n", type: "number", minimum: 1, maximum: 3 }, "0")).toBe("Use 1 or more.")
  expect(problemOf({ key: "n", type: "number", minimum: 1, maximum: 3 }, "4")).toBe("Use 3 or less.")
  expect(problemOf({ key: "n", type: "integer" }, "1.5")).toBe("Enter a whole number.")
  expect(problemOf({ key: "n", type: "number" }, "x")).toBe("Enter a number.")
  expect(problemOf({ key: "m", type: "multiselect", options: [], minItems: 2 }, ["a"])).toBe("Choose at least 2.")
  expect(problemOf({ key: "m", type: "multiselect", options: [], maxItems: 1 }, ["a", "b"])).toBe("Choose at most 1.")
})

test("initial values come from field defaults", () => {
  const values = initialValues([
    { key: "s", type: "string", default: "d" },
    { key: "n", type: "number", default: 2 },
    { key: "b", type: "boolean" },
    { key: "m", type: "multiselect", options: [], default: ["a"] },
    { key: "x", type: "external", url: "https://example.com" },
  ])
  expect(values).toEqual({ s: "d", n: "2", b: false, m: ["a"], x: false })
})

test("an external step is always active and needs an explicit acknowledgement", () => {
  const field: Field = { key: "x", type: "external", url: "https://example.com" }
  expect(activeFields([field], { x: false }).map((item) => item.key)).toEqual(["x"])
  expect(answerOf(field, false)).toBeUndefined()
  expect(answerOf(field, undefined)).toBeUndefined()
  expect(answerOf(field, "true")).toBeUndefined()
  expect(answerOf(field, true)).toBe(true)
  expect(problemOf(field, false)).toBe("Acknowledge this step to continue.")
  expect(problemOf(field, undefined)).toBe("Acknowledge this step to continue.")
  expect(problemOf(field, true)).toBeUndefined()
  expect(buildAnswer([field], initialValues([field]))).toEqual({})
  expect(buildAnswer([field], { x: true })).toEqual({ x: true })
})

test("a field that depends on an acknowledged external step follows the answer", () => {
  const fields: Field[] = [
    { key: "ext", type: "external", url: "https://example.com" },
    text("after", { when: [{ key: "ext", op: "eq", value: true }] }),
  ]
  expect(activeFields(fields, { ext: false, after: "" }).map((item) => item.key)).toEqual(["ext"])
  expect(activeFields(fields, { ext: true, after: "" }).map((item) => item.key)).toEqual(["ext", "after"])
  expect(buildAnswer(fields, { ext: true, after: "v" })).toEqual({ ext: true, after: "v" })
})

test("an external step keyed __proto__ is acknowledged as an own key", () => {
  const field: Field = { key: "__proto__", type: "external", url: "https://example.com" }
  const values = withValue(initialValues([field]), "__proto__", true)
  const answer = buildAnswer([field], values)
  expect(Object.hasOwn(answer, "__proto__")).toBe(true)
  expect(Object.getPrototypeOf(answer)).toBe(Object.prototype)
  expect(JSON.stringify(answer)).toBe('{"__proto__":true}')
  expect(JSON.stringify(buildAnswer([field], initialValues([field])))).toBe("{}")
})

test("answers keep a field keyed __proto__ as an own property without changing any prototype", () => {
  const fields: Field[] = [text("__proto__"), { key: "tags", type: "multiselect", options: [] }, { key: "constructor", type: "string" }]
  const values = withValue(withValue(withValue(initialValues(fields), "__proto__", "x"), "tags", ["a", "b"]), "constructor", "y")
  expect(Object.hasOwn(values, "__proto__")).toBe(true)
  expect(Object.getPrototypeOf(values)).toBe(Object.prototype)
  expect(valueFor(values, "__proto__")).toBe("x")
  const answer = buildAnswer(fields, values)
  expect(Object.hasOwn(answer, "__proto__")).toBe(true)
  expect(Object.getPrototypeOf(answer)).toBe(Object.prototype)
  expect(Object.keys(answer).sort()).toEqual(["__proto__", "constructor", "tags"])
  expect(JSON.stringify(answer)).toContain('"__proto__":"x"')
  expect(JSON.parse(JSON.stringify(answer))).toEqual(JSON.parse('{"__proto__":"x","tags":["a","b"],"constructor":"y"}'))
  expect(Object.keys(Object.prototype)).toEqual([])
  expect(Reflect.get({}, "x")).toBeUndefined()
})

test("an array value under __proto__ stays an own key and an absent key never reads the prototype", () => {
  const fields: Field[] = [{ key: "__proto__", type: "multiselect", options: [] }]
  const values = withValue(initialValues(fields), "__proto__", ["a"])
  expect(JSON.stringify(buildAnswer(fields, values))).toBe('{"__proto__":["a"]}')
  expect(Object.getPrototypeOf(buildAnswer(fields, values))).toBe(Object.prototype)
  expect(valueFor({}, "__proto__")).toBeUndefined()
  expect(valueFor({}, "constructor")).toBeUndefined()
  expect(buildAnswer([text("__proto__")], {})).toEqual({})
})

const option = (id: string, extra: Partial<ModelOption> = {}): ModelOption => ({ id, providerID: "p", name: id.toUpperCase(), enabled: true, status: "active", limit: { context: 1, output: 1 }, variants: [], profiles: [], ...extra })

test("model selection mirrors the backend rules for enabled models, profiles and variants", () => {
  const models = [
    option("a", { variants: ["fast"] }),
    option("b", { enabled: false, profiles: [{ name: "work", active: false, variants: ["deep"] }, { name: "home", active: true, variants: [] }] }),
  ]
  expect(selectionFor(models, { model: 0, profile: "", variant: "" })).toEqual({ id: "a", providerID: "p" })
  expect(selectionFor(models, { model: 0, profile: "", variant: "fast" })).toEqual({ id: "a", providerID: "p", variant: "fast" })
  expect(selectionFor(models, { model: 0, profile: "", variant: "deep" })).toBeUndefined()
  expect(selectionFor(models, { model: 1, profile: "", variant: "" })).toBeUndefined()
  expect(selectionFor(models, { model: 1, profile: "work", variant: "deep" })).toEqual({ id: "b", providerID: "p", variant: "deep", profile: "work" })
  expect(selectionFor(models, { model: 1, profile: "other", variant: "" })).toBeUndefined()
  expect(selectionFor(models, { model: 0, profile: "work", variant: "" })).toBeUndefined()
  expect(selectionFor(models, { model: -1, profile: "", variant: "" })).toBeUndefined()
  expect(variantsFor(models[1], "")).toEqual([])
  expect(variantsFor(models[1], "work")).toEqual(["deep"])
  expect(variantsFor(undefined, "")).toEqual([])
})

test("choosing a model or profile keeps only values that remain valid", () => {
  const models = [option("a"), option("b", { enabled: false, profiles: [{ name: "work", active: false, variants: ["deep"] }, { name: "home", active: true, variants: ["deep", "slow"] }] })]
  expect(chooseModel(models, 0)).toEqual({ model: 0, profile: "", variant: "" })
  expect(chooseModel(models, 1)).toEqual({ model: 1, profile: "home", variant: "" })
  expect(chooseModel(models, 5)).toEqual({ model: -1, profile: "", variant: "" })
  expect(chooseProfile(models, { model: 1, profile: "home", variant: "slow" }, "work")).toEqual({ model: 1, profile: "work", variant: "" })
  expect(chooseProfile(models, { model: 1, profile: "home", variant: "deep" }, "work")).toEqual({ model: 1, profile: "work", variant: "deep" })
})

test("the current selection maps back to a choice and compares by every field", () => {
  const models = [option("a"), option("b", { providerID: "q" })]
  expect(choiceFor(models, { id: "b", providerID: "q", variant: "v", profile: "w" })).toEqual({ model: 1, profile: "w", variant: "v" })
  expect(choiceFor(models, { id: "b", providerID: "p" })).toEqual({ model: -1, profile: "", variant: "" })
  expect(choiceFor(models, null)).toEqual({ model: -1, profile: "", variant: "" })
  expect(sameSelection({ id: "a", providerID: "p" }, { id: "a", providerID: "p" })).toBe(true)
  expect(sameSelection({ id: "a", providerID: "p" }, { id: "a", providerID: "p", variant: "v" })).toBe(false)
  expect(sameSelection({ id: "a", providerID: "p", profile: "x" }, { id: "a", providerID: "p" })).toBe(false)
  expect(sameSelection(null, null)).toBe(false)
})

test("labels state status, enablement and the active profile in words", () => {
  expect(modelLabel(option("a"))).toBe("A")
  expect(modelLabel(option("a", { status: "beta", enabled: false }))).toBe("A (beta) — not enabled")
  expect(profileLabel({ name: "home", active: true, variants: [] })).toBe("home (active)")
  expect(profileLabel({ name: "work", active: false, variants: [] })).toBe("work")
})

const row = (id: string, extra: Omit<Partial<SessionItem>, "time"> & { time?: Partial<SessionItem["time"]> } = {}): SessionItem => ({
  id, title: id, location: { directory: "/r" }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0,
  ...extra, time: { updated: 1, ...extra.time },
})
const page = (revision: number, ids: string[], next?: string): Sessions => ({ revision, items: ids.map((id) => row(id)), ...(next === undefined ? {} : { next }) })

test("search is trimmed, empty means none, and over 256 UTF-8 bytes is an error", () => {
  expect(searchTerm("  abc  ")).toEqual({ value: "abc" })
  expect(searchTerm("   ")).toEqual({ value: "" })
  expect(searchTerm("a".repeat(searchLimit))).toEqual({ value: "a".repeat(searchLimit) })
  expect(searchTerm("a".repeat(searchLimit + 1)).error).toBeDefined()
  expect(searchTerm("é".repeat(129))).toEqual({ value: "", error: "Search is limited to 256 bytes. Shorten it." })
  expect(searchTerm("é".repeat(128))).toEqual({ value: "é".repeat(128) })
  expect(searchTerm(` ${"a".repeat(searchLimit)} `).error).toBeUndefined()
})

test("pages append without duplicates and keep the first copy and the order", () => {
  const first = page(3, ["a", "b"], "c1")
  const start = pagingFor(first, "", undefined)
  expect(start).toEqual({ revision: 3, search: "", firstNext: "c1", extra: [], next: "c1" })
  const more = appendPage(start, page(3, ["b", "c"], "c2"))
  expect(more?.next).toBe("c2")
  expect(pagedItems(first, more!).map((item) => item.id)).toEqual(["a", "b", "c"])
  const last = appendPage(more!, page(3, ["d"]))
  expect(last).toEqual({ revision: 3, search: "", firstNext: "c1", extra: [row("b"), row("c"), row("d")] })
  expect(last && "next" in last).toBe(false)
  expect(mergeItems([row("x", { title: "old" })], [row("x", { title: "new" })])[0]?.title).toBe("old")
})

test("paging resets on a search change or a revision change and refuses a page from another revision", () => {
  const first = page(3, ["a"], "c1")
  const more = appendPage(pagingFor(first, "q", undefined), page(3, ["b"], "c2"))!
  expect(pagingFor(first, "q", more)).toBe(more)
  expect(pagingFor(first, "other", more)).toEqual({ revision: 3, search: "other", firstNext: "c1", extra: [], next: "c1" })
  expect(pagingFor(page(4, ["a"], "d1"), "q", more)).toEqual({ revision: 4, search: "q", firstNext: "d1", extra: [], next: "d1" })
  expect(appendPage(more, page(4, ["z"]))).toBeUndefined()
})

test("a first-page refetch with the same revision starts over only when its cursor chain changed", () => {
  const first = page(3, ["a"], "c1")
  const more = appendPage(pagingFor(first, "", undefined), page(3, ["b"], "c2"))!
  expect(pagingFor(page(3, ["a"], "c1"), "", more)).toBe(more)
  expect(pagingFor(page(3, ["a", "n"], "c9"), "", more)).toEqual({ revision: 3, search: "", firstNext: "c9", extra: [], next: "c9" })
  expect(pagingFor(page(3, ["a"]), "", more)).toEqual({ revision: 3, search: "", extra: [] })
  const single = pagingFor(page(3, ["a"]), "", undefined)
  expect(pagingFor(page(3, ["a", "n"]), "", single)).toBe(single)
})

test("rail groups place a Session in the first matching group and use time.pinned for Pinned", () => {
  const idle = { busy: new Set<string>(), waiting: new Map<string, ReadonlySet<string>>() }
  const rows = [row("recent", { time: { updated: 5 } }), row("pin", { time: { updated: 1, pinned: 9 } }), row("run", { time: { updated: 2, pinned: 9 } }),
    row("need", { time: { updated: 3, pinned: 9 } }), row("old", { time: { updated: 4, archived: 8 } }), row("oldpin", { time: { updated: 4, pinned: 1, archived: 8 } })]
  const grouped = railGroups(rows, { busy: new Set(["run", "need"]), waiting: new Map([["need", new Set(["r1"])]]) })
  expect(grouped.groups.map((group) => [group.key, group.rows.map((item) => item.id)])).toEqual([["needs", ["need"]], ["running", ["run"]], ["pinned", ["pin"]], ["recent", ["recent"]]])
  expect(grouped.groups.map((group) => group.label)).toEqual(["Needs action", "Running", "Pinned", "Recent"])
  expect(grouped.archived).toBe(2)
  expect(railGroups(rows.slice(0, 2), idle).groups.map((group) => group.key)).toEqual(["pinned", "recent"])
})

test("a subagent shows under its root and orders by activity then ID", () => {
  const rows = [row("root", { time: { updated: 1, active: 5 } }), row("child", { parentID: "root", time: { updated: 9 } }), row("b", { time: { updated: 5 } }), row("a", { time: { updated: 5 } })]
  const grouped = railGroups(rows, { busy: new Set(["child"]), waiting: new Map() })
  expect(grouped.groups.map((group) => [group.key, group.rows.map((item) => item.id)])).toEqual([["running", ["root"]], ["recent", ["a", "b"]]])
})

test("deprecated models are hidden unless one is the current model", () => {
  const models = [option("a"), option("old", { status: "deprecated" }), option("older", { status: "deprecated", providerID: "q" }), option("beta", { status: "beta" })]
  expect(visibleModels(models, null).map((model) => model.id)).toEqual(["a", "beta"])
  expect(visibleModels(models, { id: "old", providerID: "p" }).map((model) => model.id)).toEqual(["a", "old", "beta"])
  expect(visibleModels(models, { id: "old", providerID: "other" }).map((model) => model.id)).toEqual(["a", "beta"])
  expect(visibleModels(models, undefined).length).toBe(2)
})

test("a listed-profile problem has its own message and a valid choice has none", () => {
  const models = [option("a"), option("b", { enabled: false, profiles: [{ name: "work", active: true, variants: ["deep"] }] })]
  expect(choiceProblem(models, { model: 0, profile: "", variant: "" })).toBeUndefined()
  expect(choiceProblem(models, { model: 1, profile: "", variant: "" })).toMatch(/not enabled/)
  expect(choiceProblem(models, { model: 1, profile: "gone", variant: "" })).toMatch(/profile is no longer listed/)
  expect(choiceProblem(models, { model: 1, profile: "gone", variant: "" })).not.toMatch(/not enabled/)
  expect(choiceProblem(models, { model: 1, profile: "work", variant: "slow" })).toMatch(/variant is no longer listed/)
  expect(choiceProblem(models, { model: 1, profile: "work", variant: "deep" })).toBeUndefined()
  expect(choiceProblem(models, { model: -1, profile: "", variant: "" })).toBeUndefined()
  expect(choiceProblem(models, { model: 0, profile: "", variant: "gone" })).toMatch(/variant is no longer listed/)
  expect(choiceProblem(models, { model: 1, profile: "", variant: "gone" })).toMatch(/not enabled/)
})

test("search trims tabs and newlines and measures bytes at the 256 boundary", () => {
  expect(searchTerm("\t\n abc \n\t")).toEqual({ value: "abc" })
  expect(searchTerm("a\tb")).toEqual({ value: "a\tb" })
  expect(searchTerm("\n\t ")).toEqual({ value: "" })
  expect(searchTerm("€".repeat(85) + "a").error).toBeUndefined()
  expect(searchTerm("€".repeat(85) + "é").error).toBeDefined()
  expect(searchTerm("😀".repeat(64)).error).toBeUndefined()
  expect(searchTerm("😀".repeat(64) + "a").error).toBeDefined()
})

test("an archived Session that needs action or is running is still shown", () => {
  const rows = [row("need", { time: { updated: 1, archived: 5 } }), row("run", { time: { updated: 1, archived: 5 } }), row("quiet", { time: { updated: 1, archived: 5 } })]
  const grouped = railGroups(rows, { busy: new Set(["run"]), waiting: new Map([["need", new Set(["r"])]]) })
  expect(grouped.groups.map((group) => [group.key, group.rows.map((item) => item.id)])).toEqual([["needs", ["need"]], ["running", ["run"]]])
  expect(grouped.archived).toBe(1)
})

test("a child whose parent is not loaded shows as a root and keeps its own state", () => {
  const rows = [row("child", { parentID: "missing" })]
  expect(railGroups(rows, { busy: new Set(), waiting: new Map() }).groups.map((group) => [group.key, group.rows.map((item) => item.id)])).toEqual([["recent", ["child"]]])
  expect(railGroups(rows, { busy: new Set(["child"]), waiting: new Map() }).groups.map((group) => group.key)).toEqual(["running"])
})

test("only invalid visible fields are reported, in form order, and hidden ones are ignored", () => {
  const fields: Field[] = [text("a", { required: true }), text("b", { when: [{ key: "a", op: "eq", value: "x" }], required: true }), text("c", { required: true })]
  expect(invalidIndexes(fields, withValue(withValue(initialValues(fields), "a", "y"), "c", "ok"))).toEqual([])
  expect(invalidIndexes(fields, initialValues(fields))).toEqual([0, 2])
  expect(invalidIndexes(fields, withValue(initialValues(fields), "a", "x"))).toEqual([1, 2])
})

test("Load more outcomes apply only to the paging they started from", () => {
  const first = page(3, ["a"], "c1")
  const start = pagingFor(first, "", undefined)
  expect(samePaging(start, pagingFor(first, "", undefined))).toBe(true)
  expect(samePaging(start, pagingFor(page(3, ["a"], "c9"), "", undefined))).toBe(false)
  expect(samePaging(start, pagingFor(first, "q", undefined))).toBe(false)
  expect(samePaging(start, pagingFor(page(4, ["a"], "c1"), "", undefined))).toBe(false)
  expect(samePaging(start, appendPage(start, page(3, ["b"], "c2")))).toBe(false)
  expect(samePaging(undefined, start)).toBe(false)
})

test("focus returns to the card heading only when a lock clears with focus lost to the body or on the card itself", () => {
  expect(restoresFocus(true, false, "card")).toBe(true)
  expect(restoresFocus(true, false, "body")).toBe(true)
  expect(restoresFocus(true, false, "control")).toBe(false)
  expect(restoresFocus(true, false, "elsewhere")).toBe(false)
  expect(restoresFocus(false, false, "body")).toBe(false)
  expect(restoresFocus(true, true, "card")).toBe(false)
})

test("composer triggers open only at token boundaries", () => {
  expect(composerTrigger("/mo", 3)).toEqual({ kind: "command", start: 0, query: "mo" })
  expect(composerTrigger("hello\n/ne", 9)).toEqual({ kind: "command", start: 6, query: "ne" })
  expect(composerTrigger("see https://x.dev/a", 19)).toBeUndefined()
  expect(composerTrigger("a/b", 3)).toBeUndefined()
  expect(composerTrigger(" /mo", 4)).toBeUndefined()
  expect(composerTrigger("use $garm now", 9)).toEqual({ kind: "skill", start: 4, query: "garm" })
  expect(composerTrigger("cost is $5", 10)).toEqual({ kind: "skill", start: 8, query: "5" })
  expect(composerTrigger("mail a@b.co", 11)).toBeUndefined()
  expect(composerTrigger("open @src/ap", 12)).toEqual({ kind: "mention", start: 5, query: "src/ap" })
  expect(composerTrigger("@", 1)).toEqual({ kind: "mention", start: 0, query: "" })
  expect(composerTrigger("plain text", 5)).toBeUndefined()
  expect(composerTrigger("/mo", 2)).toEqual({ kind: "command", start: 0, query: "m" })
  expect(composerTrigger("", 0)).toBeUndefined()
})

test("insertCompletion replaces the trigger span and reports the caret", () => {
  expect(insertCompletion("open @sr please", 5, 8, "@src/app.ts ")).toEqual({ text: "open @src/app.ts  please", caret: 17 })
  expect(insertCompletion("@sr", 0, 3, "@src/")).toEqual({ text: "@src/", caret: 5 })
})

test("mentionPayload emits UTF-16 offsets for files and agents", () => {
  const text = "🔥 see @src/app.ts and @scout and @src/app.ts"
  const payload = mentionPayload(text, [
    { kind: "file", display: "@src/app.ts", uri: "file:///repo/src/app.ts" },
    { kind: "agent", display: "@scout", name: "scout" },
    { kind: "file", display: "@src/app.ts", uri: "file:///repo/src/app.ts" },
    { kind: "file", display: "@gone.ts", uri: "file:///repo/gone.ts" },
  ])
  expect(payload.files).toEqual([
    { uri: "file:///repo/src/app.ts", name: "app.ts", mention: { start: 7, end: 18, text: "@src/app.ts" } },
    { uri: "file:///repo/src/app.ts", name: "app.ts", mention: { start: 34, end: 45, text: "@src/app.ts" } },
  ])
  expect(payload.agents).toEqual([{ name: "scout", mention: { start: 23, end: 29, text: "@scout" } }])
  for (const file of payload.files) expect(text.slice(file.mention.start, file.mention.end)).toBe(file.mention.text)
})

test("slashAction routes local, backend and plain prompts", () => {
  const local = ["new", "theme", "compact"]
  const backend = ["review", "compact"]
  expect(slashAction("/theme dark", local, backend)).toEqual({ kind: "local", name: "theme", args: "dark" })
  expect(slashAction("/compact", local, backend)).toEqual({ kind: "local", name: "compact", args: "" })
  expect(slashAction("/review src/app.ts", local, backend)).toEqual({ kind: "backend", name: "review", args: "src/app.ts" })
  expect(slashAction("/unknown thing", local, backend)).toEqual({ kind: "prompt" })
  expect(slashAction("hello /theme", local, backend)).toEqual({ kind: "prompt" })
  expect(slashAction("/", local, backend)).toEqual({ kind: "prompt" })
})

test("workspaceBase reads folder names for rail and workspace titles", () => {
  expect(workspaceBase("/tmp/project")).toBe("project")
  expect(workspaceBase("/tmp/project/")).toBe("project")
  expect(workspaceBase("/")).toBe("Root (/)")
  expect(workspaceBase("")).toBe("Root (/)")
})

type Message = Messages[number]
const msg = (value: Record<string, unknown>) => ({ time: { created: 1 }, ...value }) as unknown as Message
const synthetic = (id: string, text: string, extra: Record<string, unknown> = {}) => msg({ id, type: "synthetic", text, ...extra })
const part = (value: Record<string, unknown>) => value as unknown as AssistantContentPart
const toolPart = (id: string, name: string, state: Record<string, unknown> = { status: "completed", input: {}, content: [], structured: {} }): Extract<AssistantContentPart, { type: "tool" }> => part({ type: "tool", id, name, state, time: { created: 1 } }) as Extract<AssistantContentPart, { type: "tool" }>
const assistant = (id: string, content: AssistantContentPart[], extra: Record<string, unknown> = {}) => msg({ id, type: "assistant", content, time: { created: 1 }, ...extra })
const compaction = (id: string, extra: Record<string, unknown>) => msg({ id, type: "compaction", ...extra })

test("internal envelopes are hidden by metadata source and by text marker", () => {
  const hidden = [
    synthetic("a", "x", { metadata: { contextSource: "session-state" } }),
    synthetic("b", "x", { metadata: { contextSource: "team-view" } }),
    synthetic("c", "x", { metadata: { compactionCheckpoint: {} } }),
    synthetic("d", "x", { metadata: { decisionInputID: "d1" } }),
    synthetic("e", "Authoritative current Session state (JSON):\n{}"),
    synthetic("f", "Internal orchestration context (JSON). Use it"),
    synthetic("g", "  <system-update>\nx"),
    synthetic("h", "\n<conversation-checkpoint>x"),
    synthetic("i", "Instructions from: /repo/AGENTS.md"),
    msg({ id: "j", type: "system", text: "<system-update>x" }),
  ]
  for (const item of hidden) {
    expect(isInternalTranscriptEnvelope(item)).toBe(true)
    expect(desktopMessageVisible(item)).toBe(false)
    expect(classifyDesktopSynthetic(item)).toBeUndefined()
  }
  expect(isInternalTranscriptEnvelope(msg({ id: "k", type: "user", text: "<system-update>" }))).toBe(false)
  expect(desktopMessageVisible(msg({ id: "k", type: "user", text: "<system-update>" }))).toBe(true)
  expect(isInternalTranscriptEnvelope(synthetic("l", "hello", { description: "Note" }))).toBe(false)
})

test("system messages show only with text and bare synthetic messages are hidden", () => {
  expect(desktopMessageVisible(msg({ id: "s", type: "system", text: "  " }))).toBe(false)
  expect(desktopMessageVisible(msg({ id: "s", type: "system", text: "Notice" }))).toBe(true)
  expect(desktopMessageVisible(synthetic("b", "body"))).toBe(false)
  expect(classifyDesktopSynthetic(msg({ id: "u", type: "user", text: "x" }))).toBeUndefined()
})

test("subagent notifications classify status, label and excerpt", () => {
  expect(classifyDesktopSynthetic(synthetic("a", "x", { metadata: { source: "subagent_notification", type: "completed", agent: "Review", excerpt: "  done  " } })))
    .toEqual({ kind: "subagent", label: "Review", status: "completed", excerpt: "done" })
  expect(classifyDesktopSynthetic(synthetic("b", "x", { metadata: { source: "subagent_notification", type: "failed", childID: "ses_1", excerpt: " " } })))
    .toEqual({ kind: "subagent", label: "ses_1", status: "failed" })
  expect(classifyDesktopSynthetic(synthetic("c", "x", { metadata: { source: "subagent_notification", type: "waiting", agent: "" } })))
    .toEqual({ kind: "subagent", label: "Subagent", status: "waiting" })
  expect(classifyDesktopSynthetic(synthetic("d", "x", { metadata: { source: "subagent_notification", type: "other" } })))
    .toEqual({ kind: "subagent", label: "Subagent", status: "updated" })
})

test("project notifications classify members and reject unknown events or missing member ids", () => {
  expect(classifyDesktopSynthetic(synthetic("a", "x", { metadata: { source: "project_notification", event: "escalated", memberSessionID: "ses_m", title: "Builder", excerpt: "stuck", escalatedBy: { sessionID: "ses_p", title: "Lead" } } })))
    .toEqual({ kind: "member", label: "Builder", event: "escalated", memberSessionID: "ses_m", excerpt: "stuck", escalatedBy: "Lead" })
  expect(classifyDesktopSynthetic(synthetic("b", "x", { metadata: { source: "project_notification", event: "started", memberSessionID: "ses_m" } })))
    .toEqual({ kind: "member", label: "ses_m", event: "started", memberSessionID: "ses_m" })
  expect(classifyDesktopSynthetic(synthetic("c", "x", { metadata: { source: "project_notification", event: "started", memberSessionID: "" } }))).toBeUndefined()
  expect(classifyDesktopSynthetic(synthetic("d", "x", { metadata: { source: "project_notification", event: "bogus", memberSessionID: "ses_m" } }))).toBeUndefined()
  expect(classifyDesktopSynthetic(synthetic("e", "x", { metadata: { source: "project_notification", event: "escalated", memberSessionID: "ses_m", escalatedBy: { sessionID: "ses_p" } } })))
    .toEqual({ kind: "member", label: "ses_m", event: "escalated", memberSessionID: "ses_m", escalatedBy: "ses_p" })
})

test("subagent and shell completions need a description and map states", () => {
  expect(classifyDesktopSynthetic(synthetic("a", "x", { description: " Ran tests ", metadata: { source: "shell", state: "error" } })))
    .toEqual({ kind: "completion", label: "Shell", status: "failed", description: "Ran tests" })
  expect(classifyDesktopSynthetic(synthetic("b", "x", { description: "Done", metadata: { source: "subagent", agent: "Scout", state: "completed" } })))
    .toEqual({ kind: "completion", label: "Scout", status: "finished", description: "Done" })
  expect(classifyDesktopSynthetic(synthetic("c", "x", { description: "Stopped", metadata: { source: "subagent", state: "cancelled" } })))
    .toEqual({ kind: "completion", label: "Subagent", status: "cancelled", description: "Stopped" })
  expect(classifyDesktopSynthetic(synthetic("d", "x", { description: "Custom", metadata: { source: "subagent", state: "queued" } })))
    .toEqual({ kind: "completion", label: "Subagent", status: "queued", description: "Custom" })
  expect(classifyDesktopSynthetic(synthetic("e", "x", { description: "Fine", metadata: { source: "subagent" } })))
    .toEqual({ kind: "completion", label: "Subagent", status: "finished", description: "Fine" })
  expect(classifyDesktopSynthetic(synthetic("f", "x", { metadata: { source: "shell", state: "completed" } }))).toBeUndefined()
})

test("goal synthetic messages show their text and a described synthetic becomes a note", () => {
  expect(classifyDesktopSynthetic(synthetic("a", "Ship it", { metadata: { autonomy: { goal: true } } }))).toEqual({ kind: "goal", text: "Ship it" })
  expect(classifyDesktopSynthetic(synthetic("b", "  ", { metadata: { autonomy: { goal: true } } }))).toBeUndefined()
  expect(classifyDesktopSynthetic(synthetic("c", "x", { description: " Context loaded " }))).toEqual({ kind: "note", text: "Context loaded" })
  expect(classifyDesktopSynthetic(synthetic("d", "x", { description: "  " }))).toBeUndefined()
  expect(desktopMessageVisible(synthetic("e", "x", { description: "Note" }))).toBe(true)
})

test("parent answers combine text and data only for the matching question", () => {
  const answer = (payload: unknown, questionID = "q1", extra: Record<string, unknown> = {}) =>
    synthetic("p", `Parent answer:\n${JSON.stringify(payload)}`, { metadata: { source: "subagent_parent", kind: "answer", questionID, ...extra } })
  expect(classifyDesktopSynthetic(answer({ questionID: "q1", text: "Use A", data: { a: 1 } })))
    .toEqual({ kind: "parent-answer", text: "Use A\n\n```json\n{\n  \"a\": 1\n}\n```" })
  expect(classifyDesktopSynthetic(answer({ questionID: "q1", text: "Use A" }))).toEqual({ kind: "parent-answer", text: "Use A" })
  expect(classifyDesktopSynthetic(answer({ questionID: "q2", text: "Use A" }))).toBeUndefined()
  expect(classifyDesktopSynthetic(answer({ questionID: "q1" }))).toBeUndefined()
  expect(classifyDesktopSynthetic(synthetic("bad", "Parent answer:\nnot json", { metadata: { source: "subagent_parent", kind: "answer", questionID: "q1" } }))).toBeUndefined()
})

test("goal tools and already-active skills are hidden while other parts stay visible", () => {
  expect(desktopPartVisible(part({ type: "text", text: "  " }))).toBe(false)
  expect(desktopPartVisible(part({ type: "text", text: "hi" }))).toBe(true)
  expect(desktopPartVisible(part({ type: "reasoning", text: "" }))).toBe(false)
  expect(desktopPartVisible(part({ type: "reasoning", text: "think" }))).toBe(true)
  expect(desktopPartVisible(toolPart("t1", "goal"))).toBe(false)
  expect(desktopPartVisible(toolPart("t2", "skill", { status: "completed", input: {}, content: [], structured: { alreadyActive: true } }))).toBe(false)
  expect(desktopPartVisible(toolPart("t3", "skill", { status: "completed", input: {}, content: [], structured: { alreadyActive: false } }))).toBe(true)
  expect(desktopPartVisible(toolPart("t4", "skill", { status: "running", input: {}, content: [], structured: { alreadyActive: true } }))).toBe(true)
  expect(desktopPartVisible(toolPart("t5", "shell"))).toBe(true)
})

test("assistant messages are visible with content, completion, error or retry", () => {
  expect(desktopMessageVisible(assistant("a", [part({ type: "text", text: "" })]))).toBe(false)
  expect(desktopMessageVisible(assistant("a", [toolPart("t", "goal")]))).toBe(false)
  expect(desktopMessageVisible(assistant("a", [part({ type: "text", text: "hi" })]))).toBe(true)
  expect(desktopMessageVisible(assistant("a", [], { time: { created: 1, completed: 2 } }))).toBe(true)
  expect(desktopMessageVisible(assistant("a", [], { error: { message: "boom" } }))).toBe(true)
  expect(desktopMessageVisible(assistant("a", [], { retry: { attempt: 1 } }))).toBe(true)
  for (const type of ["user", "shell", "model-switched", "agent-switched", "skill"]) expect(desktopMessageVisible(msg({ id: type, type }))).toBe(true)
})

test("compaction messages show when running, completed, cancelled or superseded", () => {
  expect(desktopMessageVisible(compaction("c", { status: "pending", jobID: "j" }))).toBe(false)
  expect(desktopMessageVisible(compaction("c", { status: "running", jobID: "j" }))).toBe(true)
  expect(desktopMessageVisible(compaction("c", { status: "completed", jobID: "j" }))).toBe(true)
  expect(desktopMessageVisible(compaction("c", { status: "failed", jobID: "j", code: "cancelled", error: { code: "x" } }))).toBe(true)
  expect(desktopMessageVisible(compaction("c", { status: "failed", jobID: "j", code: "superseded", error: { code: "x" } }))).toBe(true)
  expect(desktopMessageVisible(compaction("c", { status: "failed", jobID: "j", code: "invalid_manifest", error: { code: "x" } }))).toBe(false)
  expect(desktopMessageVisible(compaction("c", { status: "failed", reason: "auto", error: { code: "aborted" } }))).toBe(true)
  expect(desktopMessageVisible(compaction("c", { status: "failed", reason: "auto", error: { code: "other" } }))).toBe(false)
  expect(desktopMessageVisible(compaction("c", { status: "failed", jobID: "j", error: { code: "aborted" } }))).toBe(false)
})

test("transcript slicing drops messages through the latest compaction boundary and keeps one divider", () => {
  const done = (id: string, boundary: string) => compaction(id, { status: "completed", jobID: id, boundary: { messageID: boundary, seq: 1 } })
  const messages = [
    msg({ id: "u1", type: "user", text: "old" }),
    msg({ id: "u2", type: "user", text: "kept-boundary" }),
    done("c1", "u1"),
    msg({ id: "u3", type: "user", text: "new" }),
    done("c2", "u2"),
    synthetic("s", "x", { metadata: { contextSource: "session-state" } }),
    msg({ id: "u4", type: "user", text: "latest" }),
  ]
  expect(visibleDesktopMessages(messages).map((item) => item.id)).toEqual(["u3", "c2", "u4"])
  const plain = [msg({ id: "u1", type: "user", text: "a" }), compaction("c1", { status: "running", jobID: "j" }), compaction("c2", { status: "running", jobID: "k" }), msg({ id: "u2", type: "user", text: "b" })]
  expect(visibleDesktopMessages(plain).map((item) => item.id)).toEqual(["u1", "c2", "u2"])
  const forward = [done("c1", "u9"), msg({ id: "u9", type: "user", text: "after" })]
  expect(visibleDesktopMessages(forward).map((item) => item.id)).toEqual(["c1", "u9"])
  expect(visibleDesktopMessages([])).toEqual([])
})

test("assistant parts group adjacent reasoning and tools while text stays separate", () => {
  const groups = groupAssistantParts([
    part({ type: "reasoning", text: "a", time: { created: 10, completed: 20 } }),
    part({ type: "reasoning", text: "", time: { created: 11 } }),
    part({ type: "reasoning", text: "b", time: { created: 21, completed: 30 } }),
    part({ type: "text", text: "answer" }),
    toolPart("t1", "read"),
    toolPart("t2", "goal"),
    toolPart("t3", "shell"),
    part({ type: "reasoning", text: "c" }),
  ])
  expect(groups).toEqual([
    { kind: "reasoning", key: "reasoning:0", text: "a\n\nb", created: 10, completed: 30 },
    { kind: "text", key: "text:3", text: "answer" },
    { kind: "tools", key: "tools:t1", parts: [toolPart("t1", "read"), toolPart("t3", "shell")] },
    { kind: "reasoning", key: "reasoning:7", text: "c" },
  ])
  expect(groupAssistantParts([])).toEqual([])
})

test("tool summaries describe each tool by its input", () => {
  expect(toolDisplaySummary("shell", { command: "ls -la" })).toBe("ls -la")
  expect(toolDisplaySummary("shell", {})).toBe("Shell")
  const long = "a".repeat(40) + "b".repeat(40)
  expect(toolDisplaySummary("shell", { command: long })).toBe(`${"a".repeat(35)}…${"b".repeat(35)}`)
  expect(toolDisplaySummary("shell", { command: "c".repeat(72) })).toBe("c".repeat(72))
  expect(toolDisplaySummary("read", { path: "a.ts" })).toBe("Read a.ts")
  expect(toolDisplaySummary("Write", { path: "a.ts" })).toBe("Write a.ts")
  expect(toolDisplaySummary("edit", { path: "a.ts" })).toBe("Edit a.ts")
  expect(toolDisplaySummary("patch", {})).toBe("Patch file")
  expect(toolDisplaySummary("grep", { pattern: "foo", path: "src" })).toBe('Grep "foo" in src')
  expect(toolDisplaySummary("grep", { pattern: "foo" })).toBe('Grep "foo"')
  expect(toolDisplaySummary("glob", { pattern: "*.ts" })).toBe('Glob "*.ts"')
  expect(toolDisplaySummary("subagent", { agent: "Scout", description: "Map" })).toBe("Scout Subagent — Map")
  expect(toolDisplaySummary("subagent", { subagent_type: "Plan" })).toBe("Plan Subagent — Subagent")
  expect(toolDisplaySummary("subagent", undefined)).toBe("General Subagent — Subagent")
  expect(toolDisplaySummary("skill", { id: "garm" })).toBe('Skill "garm"')
  expect(toolDisplaySummary("skill", null)).toBe('Skill "skill"')
  expect(toolDisplaySummary("custom_tool", { path: "x" })).toBe("custom_tool")
})

test("effort stops add a default stop, label known variants and fall back to medium tone", () => {
  expect(effortStopsFor([])).toEqual([])
  expect(effortStopsFor(["low", "xhigh", "turbo"])).toEqual([
    { value: "", label: "Default", tone: "unselected" },
    { value: "low", label: "Low", tone: "low" },
    { value: "xhigh", label: "X-High", tone: "xhigh" },
    { value: "turbo", label: "turbo", tone: "medium" },
  ])
  expect(effortStopsFor(["none", "minimal", "medium", "high", "max"]).map((stop) => stop.label)).toEqual(["Default", "None", "Minimal", "Medium", "High", "Max"])
  const stops = effortStopsFor(["low", "high"])
  expect(effortStopIndex(stops, "high")).toBe(2)
  expect(effortStopIndex(stops, "")).toBe(0)
  expect(effortStopIndex(stops, "missing")).toBe(0)
  expect(effortStopFraction(0, 1)).toBe(0)
  expect(effortStopFraction(0, 0)).toBe(0)
  expect(effortStopFraction(1, 3)).toBe(0.5)
  expect(effortStopFraction(2, 3)).toBe(1)
  expect(effortStopFraction(9, 3)).toBe(1)
  expect(effortStopFraction(-1, 3)).toBe(0)
})

test("desktop themes list the system, default, One Dark, One Dark Pro and High contrast choices", () => {
  expect(DESKTOP_THEMES.map((theme) => theme.id)).toEqual(["system", "light", "dark", "onedark-light", "onedark-dark", "onedark-pro", "high-contrast-light", "high-contrast-dark"])
  expect(new Set(DESKTOP_THEMES.map((theme) => theme.id)).size).toBe(DESKTOP_THEMES.length)
  for (const theme of DESKTOP_THEMES) {
    expect(theme.label.length).toBeGreaterThan(0)
    expect(theme.description.length).toBeGreaterThan(0)
    expect(isDesktopThemeID(theme.id)).toBe(true)
  }
  expect(isDesktopThemeID("onedark")).toBe(false)
  expect(isDesktopThemeID(undefined)).toBe(false)
  expect(isDesktopThemeID(3)).toBe(false)
})

test("resolveDesktopTheme maps each choice to data-theme and data-scheme", () => {
  const resolved = (choice: DesktopThemeID, systemDark: boolean) => resolveDesktopTheme(choice, systemDark)
  expect(resolved("system", true)).toEqual({ theme: "dark" })
  expect(resolved("system", false)).toEqual({ theme: "light" })
  expect(resolved("light", true)).toEqual({ theme: "light" })
  expect(resolved("dark", false)).toEqual({ theme: "dark" })
  expect(resolved("onedark-light", true)).toEqual({ theme: "light", scheme: "onedark" })
  expect(resolved("onedark-dark", false)).toEqual({ theme: "dark", scheme: "onedark" })
  expect(resolved("onedark-pro", false)).toEqual({ theme: "dark", scheme: "onedark-pro" })
  expect(resolved("high-contrast-light", true)).toEqual({ theme: "light", scheme: "high-contrast" })
  expect(resolved("high-contrast-dark", false)).toEqual({ theme: "dark", scheme: "high-contrast" })
  expect("scheme" in resolved("dark", true)).toBe(false)
})

test("desktopSlashCommand recognizes every built-in command and alias case-insensitively", () => {
  const simple = [
    ["/new", "new"], ["/clear", "new"], ["/compact", "compact"], ["/summarize", "compact"], ["/connect", "connect"], ["/mcp", "mcp"], ["/mcps", "mcp"],
    ["/status", "status"], ["/debug", "debug"], ["/models", "models"], ["/mo", "models"], ["/variants", "variants"], ["/variant", "variants"],
    ["/agents", "agents"], ["/agent", "agents"], ["/skills", "skills"], ["/skill", "skills"], ["/themes", "themes"], ["/theme", "themes"],
    ["/autonomous", "autonomous"], ["/fork", "fork"], ["/move", "move"], ["/undo", "undo"], ["/redo", "redo"], ["/diff", "diff"],
    ["/terminals", "terminals"], ["/terminal", "terminals"], ["/browser", "browser"], ["/chrome", "browser"], ["/artifacts", "artifacts"],
    ["/plugins", "plugins"], ["/pair", "pair"], ["/remote", "remote"], ["/dots", "dots"], ["/keep-awake", "keep-awake"], ["/stash", "stash"],
    ["/timeline", "timeline"], ["/copy", "copy"], ["/export", "export"], ["/help", "help"], ["/shortcuts", "help"], ["/keys", "help"],
    ["/workspaces", "workspaces"], ["/projects", "projects"], ["/project-settings", "projects"], ["/sessions", "sessions"], ["/resume", "sessions"],
    ["/continue", "sessions"], ["/usage", "usage"], ["/settings", "settings"], ["/thinking", "toggle-thinking"], ["/toggle-thinking", "toggle-thinking"],
  ] as const
  for (const [input, kind] of simple) {
    expect(desktopSlashCommand(input, [])).toEqual({ kind })
    expect(desktopSlashCommand(input.toUpperCase(), [])).toEqual({ kind })
  }
  expect(desktopSlashCommand("/models gpt", [])).toEqual({ kind: "models" })
})

test("desktopSlashCommand extracts optional arguments for goal, daybreak, rename and find", () => {
  expect(desktopSlashCommand("/goal finish tests", [])).toEqual({ kind: "goal", argument: "finish tests" })
  expect(desktopSlashCommand("/goal", [])).toEqual({ kind: "goal" })
  expect(desktopSlashCommand("/GOAL   ", [])).toEqual({ kind: "goal" })
  expect(desktopSlashCommand("/daybreak at 9\nthen ship", [])).toEqual({ kind: "daybreak", argument: "at 9\nthen ship" })
  expect(desktopSlashCommand("/rename  New title  ", [])).toEqual({ kind: "rename", argument: "New title" })
  expect(desktopSlashCommand("/rename", [])).toEqual({ kind: "rename" })
  expect(desktopSlashCommand("/find needle in haystack", [])).toEqual({ kind: "find", argument: "needle in haystack" })
})

test("desktopSlashCommand falls back to backend commands and rejects plain prompts", () => {
  expect(desktopSlashCommand("/review src/app.ts", ["review"])).toEqual({ kind: "backend", command: "review", arguments: "src/app.ts" })
  expect(desktopSlashCommand("/review", ["review"])).toEqual({ kind: "backend", command: "review", arguments: "" })
  expect(desktopSlashCommand("/Review x", ["review"])).toEqual({ kind: "backend", command: "review", arguments: "x" })
  expect(desktopSlashCommand("/new", ["new"])).toEqual({ kind: "new" })
  expect(desktopSlashCommand("/review", [])).toBeUndefined()
  expect(desktopSlashCommand("/unknown thing", ["review"])).toBeUndefined()
  expect(desktopSlashCommand("hello /new", [])).toBeUndefined()
  expect(desktopSlashCommand("/", [])).toBeUndefined()
  expect(desktopSlashCommand(" /new", [])).toBeUndefined()
})

test("built-in slash catalog backs autocomplete and parsing", () => {
  const names = DESKTOP_BUILT_IN_SLASH_COMMANDS.map((command) => command.name)
  for (const required of ["connect", "mcp", "status", "models", "agents", "skills", "themes", "rename", "fork", "move", "undo", "redo", "diff", "terminals", "browser", "autonomous", "goal", "export", "stash", "timeline", "help"]) expect(names).toContain(required)
  expect(new Set(names).size).toBe(names.length)
  const everyName = DESKTOP_BUILT_IN_SLASH_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])])
  expect(new Set(everyName).size).toBe(everyName.length)
  for (const command of DESKTOP_BUILT_IN_SLASH_COMMANDS) {
    expect(command.description.length).toBeGreaterThan(0)
    for (const name of [command.name, ...(command.aliases ?? [])]) expect(desktopSlashCommand(`/${name}`, [])?.kind as string | undefined).toBe(command.name)
  }
})

test("validateFolderSegment trims and rejects unsafe folder names", () => {
  expect(validateFolderSegment("  my-app  ")).toEqual({ valid: true, name: "my-app" })
  expect(validateFolderSegment("café 日本")).toEqual({ valid: true, name: "café 日本" })
  expect(validateFolderSegment(".hidden")).toEqual({ valid: true, name: ".hidden" })
  for (const bad of ["", "   ", ".", " .. ", "a/b", "a\\b", "/", "a\u0000b", "a\nb", "a\u007fb"]) {
    const result = validateFolderSegment(bad)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error.length).toBeGreaterThan(0)
  }
  expect(validateFolderSegment("a".repeat(255))).toEqual({ valid: true, name: "a".repeat(255) })
  expect(validateFolderSegment("a".repeat(256)).valid).toBe(false)
  expect(validateFolderSegment("é".repeat(128)).valid).toBe(false)
  expect(validateFolderSegment("é".repeat(127)).valid).toBe(true)
})

test("formatSessionExportMarkdown renders visible messages as standalone Markdown", () => {
  const messages = [
    msg({ id: "u1", type: "user", text: "Fix the bug" }),
    synthetic("s1", "x", { metadata: { contextSource: "session-state" } }),
    assistant("a1", [
      part({ type: "reasoning", text: "Thinking about it" }),
      part({ type: "text", text: "Done." }),
      toolPart("t1", "read", { status: "completed", input: { path: "src/a.ts" }, content: [], structured: {} }),
      part({ type: "text", text: "   " }),
    ]),
    msg({ id: "sh", type: "shell", command: "ls -la" }),
  ]
  const markdown = formatSessionExportMarkdown({ title: "Bug fix", sessionID: "ses_1", directory: "/repo", updatedAt: Date.UTC(2026, 10, 12), messages })
  expect(markdown.startsWith("# Bug fix\n")).toBe(true)
  expect(markdown).toContain("ses_1")
  expect(markdown).toContain("/repo")
  expect(markdown).toContain("2026-11-12T00:00:00.000Z")
  expect(markdown).toContain("## You\n\nFix the bug")
  expect(markdown).toContain("## Assistant")
  expect(markdown).toContain("> Thinking about it")
  expect(markdown).toContain("Done.")
  expect(markdown).toContain("Read src/a.ts")
  expect(markdown).toContain("ls -la")
  expect(markdown).not.toContain("session-state")
  expect(markdown.indexOf("Fix the bug")).toBeLessThan(markdown.indexOf("Done."))
  expect(markdown.endsWith("\n")).toBe(true)
})

test("formatSessionExportMarkdown omits the updated line and handles empty transcripts", () => {
  const markdown = formatSessionExportMarkdown({ title: "Empty", sessionID: "ses_2", directory: "/x", messages: [] })
  expect(markdown).toContain("# Empty")
  expect(markdown).not.toContain("Updated")
  expect(markdown).not.toContain("## You")
})

test("prompt stashes parse safely and stay capped", () => {
  expect(parsePromptStashes(null)).toEqual([])
  expect(parsePromptStashes("")).toEqual([])
  expect(parsePromptStashes("{not json")).toEqual([])
  expect(parsePromptStashes('{"id":"a"}')).toEqual([])
  const valid = { id: "a", text: "hello", directory: "/repo", createdAt: 1 }
  const noDirectory = { id: "b", text: "world", createdAt: 2 }
  expect(parsePromptStashes(JSON.stringify([valid, noDirectory, null, 3, { id: "c", text: 5, createdAt: 1 }, { id: "d", text: "", createdAt: 1 }, { id: "e", text: "x", createdAt: "1" }, { text: "x", createdAt: 1 }]))).toEqual([valid, noDirectory])
  const many = Array.from({ length: 40 }, (_, index) => ({ id: `i${index}`, text: `t${index}`, createdAt: index }))
  expect(parsePromptStashes(JSON.stringify(many))).toHaveLength(25)
  expect(parsePromptStashes(JSON.stringify(many))[0]?.id).toBe("i0")
})

test("pushPromptStash puts the newest first, replaces the same id and caps the list", () => {
  const entry = (id: string, createdAt = 1) => ({ id, text: `text ${id}`, createdAt })
  const first = pushPromptStash([], entry("a"))
  expect(first).toEqual([entry("a")])
  const second = pushPromptStash(first, entry("b", 2))
  expect(second.map((item) => item.id)).toEqual(["b", "a"])
  expect(pushPromptStash(second, { ...entry("a", 3), text: "edited" }).map((item) => [item.id, item.text])).toEqual([["a", "edited"], ["b", "text b"]])
  expect(second.map((item) => item.id)).toEqual(["b", "a"])
  let list: readonly ReturnType<typeof entry>[] = []
  for (let index = 0; index < 30; index++) list = pushPromptStash(list, entry(`i${index}`, index))
  expect(list).toHaveLength(25)
  expect(list[0]?.id).toBe("i29")
  expect(list.at(-1)?.id).toBe("i5")
  expect(pushPromptStash(list, entry("z"), 3)).toHaveLength(3)
  expect(pushPromptStash([], entry("z"), 0)).toEqual([])
})

test("quota windows report a bounded percent, level and unit-aware detail", () => {
  expect(formatQuotaWindow({ label: "5h", used: 25, limit: 100, unit: "requests" })).toEqual({ label: "5h", used: 25, detail: "25 / 100 requests", level: "ok" })
  expect(formatQuotaWindow({ label: "5h", used: 250, limit: 100, unit: "requests" }).used).toBe(100)
  expect(formatQuotaWindow({ label: "wk", used: 42, unit: "percent" })).toEqual({ label: "wk", used: 42, detail: "42%", level: "ok" })
  expect(formatQuotaWindow({ label: "wk", used: 142, unit: "percent" }).used).toBe(100)
  expect(formatQuotaWindow({ label: "wk", used: -5, unit: "percent" }).used).toBe(0)
  expect(formatQuotaWindow({ label: "m", unit: "tokens" })).toEqual({ label: "m", used: undefined, detail: "Unreported / Unreported tokens" })
  expect(formatQuotaWindow({ label: "m", used: 3, unit: "tokens" })).toEqual({ label: "m", used: undefined, detail: "3 / Unreported tokens" })
})

test("quota windows format percent without float tails and classify levels", () => {
  expect(formatQuotaWindow({ label: "w", used: 94.423121, unit: "percent" })).toEqual({ label: "w", used: 94.4, detail: "94.4%", level: "danger" })
  expect(formatQuotaWindow({ label: "w", used: 60.872389999999996, unit: "percent" })).toMatchObject({ detail: "60.9%", level: "warn" })
  expect(formatQuotaWindow({ label: "w", used: 59.9, unit: "percent" }).level).toBe("ok")
  expect(formatQuotaWindow({ label: "w", used: 84.9, unit: "percent" }).level).toBe("warn")
  expect(formatQuotaWindow({ label: "w", used: 85, unit: "percent" }).level).toBe("danger")
  expect(formatQuotaWindow({ label: "t", used: 94_252_459_504, limit: 100_000_000_000, unit: "tokens" }).detail).toBe("94.3B / 100B tokens")
  expect(formatQuotaWindow({ label: "c", used: 1.5, limit: 10, unit: "usd" }).detail).toBe("$1.50 / $10.00")
  expect(formatQuotaWindow({ label: "u", unlimited: true, group: "G", unit: "tokens" })).toEqual({ label: "u", group: "G", detail: "Unlimited" })
})

test("quota windows describe the reset time", () => {
  const reset = (resetAt: number) => formatQuotaWindow({ label: "w", used: 1, limit: 2, unit: "requests", resetAt }, 1_000_000).reset
  expect(reset(1_000_000)).toBe("Reset due")
  expect(reset(900_000)).toBe("Reset due")
  expect(reset(1_000_000 + 61_000)).toBe("Resets in 2m")
  expect(reset(1_000_000 + 3_600_000)).toBe("Resets in 1h")
  expect(reset(1_000_000 + 86_400_000 + 1_000)).toBe("Resets in 2d")
  expect(formatQuotaWindow({ label: "w", used: 1, limit: 2, unit: "requests", resetAt: 5 }).reset).toBeUndefined()
})

test("counts, percents and durations format without raw float or digit noise", () => {
  expect(formatCount(94252459504)).toBe("94,252,459,504")
  expect(formatCount(Number.NaN)).toBe("0")
  expect(formatCount(Number.POSITIVE_INFINITY)).toBe("0")
  expect(formatCount(-0)).toBe("0")
  expect(formatCompactCount(94_252_459_504)).toBe("94.3B")
  expect(formatCompactCount(12_400)).toBe("12.4K")
  expect(formatCompactCount(1_000)).toBe("1K")
  expect(formatCompactCount(999)).toBe("999")
  expect(formatCompactCount(999_950)).toBe("1M")
  expect(formatCompactCount(Number.NaN)).toBe("0")
  expect(formatPercent(94.423121)).toBe("94.4%")
  expect(formatPercent(60.872389999999996)).toBe("60.9%")
  expect(formatPercent(4)).toBe("4%")
  expect(formatPercent(100)).toBe("100%")
  expect(formatPercent(-0)).toBe("0%")
  expect(formatPercent(Number.NaN)).toBe("0%")
  expect(formatDurationMs(142.83910000000002)).toBe("143 ms")
  expect(formatDurationMs(4.26)).toBe("4.3 ms")
  expect(formatDurationMs(0.2)).toBe("<1 ms")
  expect(formatDurationMs(0)).toBe("0 ms")
  expect(formatDurationMs(-5)).toBe("0 ms")
  expect(formatDurationMs(1420)).toBe("1.42 s")
  expect(formatDurationMs(125_000)).toBe("2m 5s")
})

test("quota providers with the same label are distinguishable", () => {
  const claude = formatQuotaProviders([
    { providerID: "anthropic", label: "Claude · Max", status: "available", source: "provider_api", windows: [] },
    { providerID: "anthropic", label: "Claude · Max", status: "available", source: "response_headers", windows: [] },
    { providerID: "anthropic", label: "Claude", status: "unsupported", windows: [] },
    { providerID: "anthropic", label: "Claude", status: "unsupported", windows: [] },
    { providerID: "anthropic", label: "Claude", profile: "home", status: "unsupported", windows: [] },
    { providerID: "anthropic", label: "Claude", profile: "work", status: "unsupported", windows: [] },
  ])
  expect(claude.map((row) => [row.provider, row.account])).toEqual([["Claude", "Max · Provider API"], ["Claude", "Max · Response headers"], ["Claude", undefined], ["Claude", "home"], ["Claude", "work"]])
  expect(claude[2]).toMatchObject({ status: "unsupported", statusTone: "muted", note: "Quota windows are not reported for this account." })
  expect(new Set(claude.map((row) => `${row.provider}|${row.account ?? ""}|${row.status}`)).size).toBe(claude.length)
  expect(new Set(claude.map((row) => row.key)).size).toBe(claude.length)
})

test("quota providers with no distinguishing data are numbered and tones follow status", () => {
  const rows = formatQuotaProviders([
    { label: "Codex", status: "available", windows: [] },
    { label: "Codex", status: "available", windows: [] },
    { label: "Z", status: "stale", windows: [] },
    { label: "Z", profile: "p", status: "error", message: " Down ", windows: [] },
    { label: "Y", profile: "p", status: "unauthorized", windows: [] },
  ])
  expect(rows.map((row) => row.account)).toEqual(["Account 1", "Account 2", undefined, "p", "p"])
  expect(rows.map((row) => row.statusTone)).toEqual(["ok", "ok", "warn", "bad", "bad"])
  expect(rows[3]?.note).toBe("Down")
})

test("quota windows repeating a label are disambiguated by group then id then position", () => {
  const [provider] = formatQuotaProviders([{ label: "Antigravity", status: "available", windows: [
    { id: "a", label: "Weekly limit", group: "Claude", used: 10, limit: 100, unit: "requests" },
    { id: "b", label: "Weekly limit", group: "Gemini Pro", used: 90, limit: 100, unit: "requests" },
    { id: "claude_weekly", label: "Daily limit", used: 1, limit: 100, unit: "requests" },
    { id: "gemini_weekly", label: "Daily limit", used: 1, limit: 100, unit: "requests" },
    { id: "x", label: "Hourly", used: 1, limit: 100, unit: "requests" },
    { id: "x", label: "Hourly", used: 1, limit: 100, unit: "requests" },
  ] }])
  expect(provider?.windows.map((window) => window.label)).toEqual(["Claude · Weekly limit", "Gemini Pro · Weekly limit", "Daily limit · claude weekly", "Daily limit · gemini weekly", "Hourly · x #1", "Hourly · x #2"])
  expect(provider?.windows[0]).toMatchObject({ group: "Claude", level: "ok" })
  expect(provider?.windows[1]).toMatchObject({ group: "Gemini Pro", level: "danger" })
})

test("USD amounts group thousands and always show two decimals", () => {
  expect(formatUsd(31544.36)).toBe("$31,544.36")
  expect(formatUsd(0)).toBe("$0.00")
  expect(formatUsd(1234567.891)).toBe("$1,234,567.89")
  expect(formatUsd(Number.NaN)).toBe("$0.00")
  expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("$0.00")
  expect(formatQuotaWindow({ label: "Budget", used: 12345.5, limit: 31544.36, unit: "usd" }).detail).toBe("$12,345.50 / $31,544.36")
})
