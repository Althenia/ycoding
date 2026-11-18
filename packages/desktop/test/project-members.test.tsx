import { expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { ProjectMutationInput, ProjectsSnapshot, SessionItem } from "../src/contract"

type Node = { readonly type: unknown; readonly props: Record<string, unknown> }
const jsxRuntime = () => ({ jsxDEV: (type: unknown, props: unknown) => ({ type, props }), jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }), Fragment: (props: { children?: unknown }) => props.children })
mock.module("solid-js/jsx-dev-runtime", jsxRuntime)
mock.module("solid-js/jsx-runtime", jsxRuntime)

const { DesktopProjectMembers, DesktopProjectRoster, memberCandidates, memberChange, newDirectoryProjectConfirmation } = await import("../src/project-members")
const { For, Show } = await import("solid-js")

type Group = ProjectsSnapshot["groups"][number]
const participant = (sessionID: string, title: string) => ({ sessionID, title, location: { directory: "/synthetic/repo" }, state: "idle", lastActivity: 1, pending: [] })
const group = (overrides: Partial<Record<string, unknown>> = {}) => ({ id: "cgrp_team", name: "Team", revision: 7, active: true, master: participant("ses_master", "Lead"), members: [participant("ses_a", "Alpha"), participant("ses_b", "Beta")], settings: { concurrency: null }, time: { created: 1, updated: 2 }, ...overrides }) as unknown as Group
const session = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, location: { directory: "/synthetic/repo" }, time: { updated: 1 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, ...extra }) as SessionItem
const sessions = [session("ses_master", "Lead"), session("ses_a", "Alpha"), session("ses_c", "Gamma"), session("ses_child", "Child", { parentID: "ses_c" }), session("ses_old", "Archived", { time: { updated: 1, archived: 2 } })]

function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (typeof value !== "object" || value === null || !("type" in value) || !("props" in value)) return []
  const node = value as Node
  if (node.type === For) {
    const each = (node.props.each ?? []) as readonly unknown[]
    const render = node.props.children as (item: unknown, index: () => number) => unknown
    return each.flatMap((item, index) => nodes(render(item, () => index)))
  }
  if (node.type === Show) return nodes(node.props.when ? node.props.children : node.props.fallback)
  return [node, ...nodes(node.props.children)]
}
const action = (tree: unknown, id: string) => nodes(tree).filter((node) => node.props["data-action-id"] === id)
const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join("") : typeof value === "string" || typeof value === "number" ? String(value) : typeof value === "object" && value !== null && "props" in value ? text((value as Node).props.children) : ""

test("candidates are loaded root Sessions outside the Project and the catalog states that scope", () => {
  expect(memberCandidates(group(), sessions).map((item) => item.id)).toEqual(["ses_c"])
  createRoot((dispose) => {
    const tree = DesktopProjectMembers({ group: group(), revision: 3, sessions, disabled: false, onChange: () => {}, onBrowseFolder: () => {} })
    expect(text(tree)).toContain("1 eligible of 5 Sessions loaded in the rail")
    dispose()
  })
})

test("member changes carry connection revision, group identity and accurate confirmations", () => {
  const state = { group: group(), revision: 3, sessions, disabled: false }
  expect(memberChange(state, { kind: "add", sessionID: "ses_c" })).toEqual({ input: { kind: "update", revision: 3, groupID: "cgrp_team", groupRevision: 7, memberSessionIDs: ["ses_a", "ses_b", "ses_c"] }, confirmation: "Add “Gamma” as a member of project “Team”?" })
  expect(memberChange(state, { kind: "remove", sessionID: "ses_a" })).toEqual({ input: { kind: "update", revision: 3, groupID: "cgrp_team", groupRevision: 7, memberSessionIDs: ["ses_b"] }, confirmation: "Remove “Alpha” from project “Team”? The Session and its stored data stay available in Sessions." })
  const deleted = memberChange(state, { kind: "delete", sessionID: "ses_b" })
  expect(deleted).toEqual({ input: { kind: "delete-member", revision: 3, groupID: "cgrp_team", groupRevision: 7, sessionID: "ses_b" }, confirmation: "Delete member Session “Beta”? This permanently deletes its stored Session data, including its transcript, and removes it from project “Team”." })
  expect(memberChange(state, { kind: "new", directory: "/synthetic/work", title: "  Helper  " })).toEqual({ input: { kind: "new-member", revision: 3, groupID: "cgrp_team", groupRevision: 7, directory: "/synthetic/work", title: "Helper" }, confirmation: "Create a new Session titled “Helper” in /synthetic/work and add it as a member of project “Team”? A missing folder is created." })
  expect(memberChange(state, { kind: "new", directory: "/synthetic/work", title: " " })).toEqual({ input: { kind: "new-member", revision: 3, groupID: "cgrp_team", groupRevision: 7, directory: "/synthetic/work" }, confirmation: "Create a new Session in /synthetic/work and add it as a member of project “Team”? A missing folder is created." })
})

test("typed member folders accept absolute and home addresses unchanged and trimmed", () => {
  const state = { group: group(), revision: 3, sessions, disabled: false }
  for (const directory of ["~", "~/work/new", "/synthetic/a b"]) expect(memberChange(state, { kind: "new", directory: `  ${directory}  `, title: "" })).toMatchObject({ input: { kind: "new-member", directory } })
  expect(newDirectoryProjectConfirmation("Team", "~/work")).toBe("Create project Team with a new Master Session in ~/work? A missing folder is created.")
})

test("master, stale candidates, non-members and missing folders are refused", () => {
  const state = { group: group(), revision: 3, sessions, disabled: false }
  for (const kind of ["remove", "delete"] as const) expect(memberChange(state, { kind, sessionID: "ses_master" })).toEqual({ error: "The master Session cannot be removed or deleted here. Change the master in project settings first." })
  for (const kind of ["remove", "delete"] as const) expect(memberChange(state, { kind, sessionID: "ses_c" })).toEqual({ error: "This Session is no longer a member of the project. Refresh projects." })
  for (const sessionID of ["ses_a", "ses_master", "ses_child", "ses_old", "ses_missing", ""]) expect(memberChange(state, { kind: "add", sessionID })).toEqual({ error: "Choose a loaded Session that is not already in the project." })
  for (const directory of ["", "   "]) expect(memberChange(state, { kind: "new", directory, title: "" })).toEqual({ error: "Choose a folder for the new member Session." })
  for (const directory of ["relative/path", "./here", "~someone/work", "../up"]) expect(memberChange(state, { kind: "new", directory, title: "" })).toEqual({ error: "Enter an absolute folder path or one starting with ~/." })
  expect(memberChange({ ...state, disabled: true }, { kind: "remove", sessionID: "ses_a" })).toBeUndefined()
})

test("rendered controls dispatch exact changes, never offer master actions and stay inert while disabled", () => {
  createRoot((dispose) => {
    const changes: [ProjectMutationInput, string][] = []
    let browse: [string, (directory: string) => void] | undefined
    const [disabled, setDisabled] = createSignal(false)
    const props = { group: group(), revision: 3, sessions, get disabled() { return disabled() }, onChange: (input: ProjectMutationInput, confirmation: string) => { changes.push([input, confirmation]) }, onBrowseFolder: (initial: string, choose: (directory: string) => void) => { browse = [initial, choose] } }
    const workflows = DesktopProjectMembers(props)
    const roster = DesktopProjectRoster({ group: props.group, revision: props.revision, get disabled() { return disabled() }, onChange: props.onChange, onOpen: () => {} })
    const tree = [workflows, roster]
    expect(action(workflows, "project-member-remove")).toEqual([])
    expect(action(workflows, "project-member-delete")).toEqual([])
    expect(action(tree, "project-member-remove").map((node) => node.props["aria-label"])).toEqual(["Remove Alpha from project", "Remove Beta from project"])
    expect(action(tree, "project-member-delete").map((node) => node.props["aria-label"])).toEqual(["Delete member Session Alpha", "Delete member Session Beta"])
    expect(nodes(roster).some(node => node.type === "small" && text(node) === "Master")).toBe(true)
    ;(action(tree, "project-member-remove")[1]!.props.onClick as () => void)()
    expect(changes.at(-1)?.[0]).toEqual({ kind: "update", revision: 3, groupID: "cgrp_team", groupRevision: 7, memberSessionIDs: ["ses_a"] })
    ;(action(tree, "project-member-delete")[0]!.props.onClick as () => void)()
    expect(changes.at(-1)?.[0]).toMatchObject({ kind: "delete-member", sessionID: "ses_a" })

    const picker = nodes(tree).find((node) => typeof node.props.onChange === "function" && node.props.label === "Session to add")!
    expect((picker.props.options as { value: string }[]).map((option) => option.value)).toEqual(["ses_c"])
    ;(picker.props.onChange as (value: string) => void)("ses_c")
    ;(action(tree, "project-member-add")[0]!.props.onClick as () => void)()
    expect(changes.at(-1)?.[0]).toEqual({ kind: "update", revision: 3, groupID: "cgrp_team", groupRevision: 7, memberSessionIDs: ["ses_a", "ses_b", "ses_c"] })

    ;(action(tree, "project-member-browse")[0]!.props.onClick as () => void)()
    expect(browse?.[0]).toBe("/synthetic/repo")
    browse?.[1]("/synthetic/new")
    ;(nodes(tree).find((node) => node.type === "input" && node.props["aria-label"] !== "Member folder path")!.props.onInput as (event: unknown) => void)({ currentTarget: { value: "Helper" } })
    const count = changes.length
    setDisabled(true)
    for (const id of ["project-member-new", "project-member-add", "project-member-remove", "project-member-delete"]) for (const node of action(tree, id)) (node.props.onClick as () => void)()
    expect(changes).toHaveLength(count)
    setDisabled(false)
    ;(action(tree, "project-member-new")[0]!.props.onClick as () => void)()
    expect(changes.at(-1)).toEqual([{ kind: "new-member", revision: 3, groupID: "cgrp_team", groupRevision: 7, directory: "/synthetic/new", title: "Helper" }, "Create a new Session titled “Helper” in /synthetic/new and add it as a member of project “Team”? A missing folder is created."])
    dispose()
  })
})

test("staged input clears when the Project identity or revision changes", () => {
  const changes: ProjectMutationInput[] = []
  const [current, setCurrent] = createSignal(group())
  const props = { get group() { return current() }, revision: 3, sessions, disabled: false, onChange: (input: ProjectMutationInput) => { changes.push(input) }, onBrowseFolder: (_initial: string, choose: (directory: string) => void) => choose("/synthetic/new") }
  const { tree, dispose } = createRoot((dispose) => ({ tree: DesktopProjectMembers(props), dispose }))
  try {
    const pick = nodes(tree).find((node) => node.props.label === "Session to add")!.props.onChange as (value: string) => void
    pick("ses_c")
    ;(action(tree, "project-member-browse")[0]!.props.onClick as () => void)()
    setCurrent(group({ id: "cgrp_other", revision: 1 }))
    ;(action(tree, "project-member-add")[0]!.props.onClick as () => void)()
    ;(action(tree, "project-member-new")[0]!.props.onClick as () => void)()
    expect(changes).toEqual([])
    pick("ses_c")
    ;(action(tree, "project-member-add")[0]!.props.onClick as () => void)()
    expect(changes).toEqual([{ kind: "update", revision: 3, groupID: "cgrp_other", groupRevision: 1, memberSessionIDs: ["ses_a", "ses_b", "ses_c"] }])
  } finally { dispose() }
})

test("the member folder field mirrors the Master path entry, accepts typed paths and sits beside Choose folder…", () => {
  const changes: [ProjectMutationInput, string][] = []
  const { tree, dispose } = createRoot((dispose) => ({ tree: DesktopProjectMembers({ group: group(), revision: 3, sessions, disabled: false, onChange: (input, confirmation) => { changes.push([input, confirmation]) }, onBrowseFolder: () => {} }), dispose }))
  try {
    const field = nodes(tree).find((node) => node.type === "input" && node.props["aria-label"] === "Member folder path")!
    expect(field.props.placeholder).toBe("/path/to/folder or ~/folder")
    expect(text(tree)).toContain("Folder path")
    expect(text(action(tree, "project-member-browse")[0])).toBe("Choose folder…")
    ;(action(tree, "project-member-new")[0]!.props.onClick as () => void)()
    expect(changes).toEqual([])
    ;(field.props.onInput as (event: unknown) => void)({ currentTarget: { value: "~/projects/helper" } })
    ;(action(tree, "project-member-new")[0]!.props.onClick as () => void)()
    expect(changes.at(-1)).toEqual([{ kind: "new-member", revision: 3, groupID: "cgrp_team", groupRevision: 7, directory: "~/projects/helper" }, "Create a new Session in ~/projects/helper and add it as a member of project “Team”? A missing folder is created."])
    ;(field.props.onInput as (event: unknown) => void)({ currentTarget: { value: "relative/dir" } })
    ;(action(tree, "project-member-new")[0]!.props.onClick as () => void)()
    expect(changes).toHaveLength(1)
  } finally { dispose() }
})
