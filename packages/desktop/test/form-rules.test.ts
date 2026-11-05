import { expect, test } from "bun:test"
import type { ModelOption, SessionItem, Sessions } from "../src/contract"
import { activeFields, answerOf, appendPage, buildAnswer, choiceProblem, invalidIndexes, restoresFocus, samePaging, visibleModels, mergeItems, pagedItems, pagingFor, railGroups, searchLimit, searchTerm, chooseModel, chooseProfile, choiceFor, initialValues, matches, modelLabel, problemOf, profileLabel, sameSelection, selectionFor, valueFor, variantsFor, withValue, type Field } from "../src/form-rules"

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
