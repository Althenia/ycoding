import { expect, spyOn, test } from "bun:test"
import { createGroupMarkers } from "../group-marker.js"

function fixture() {
  const tabs = [
    { id: 1, groupId: 7, index: 0, windowId: 1, active: false, pinned: false },
    { id: 2, groupId: 7, index: 1, windowId: 1, active: false, pinned: false },
  ]
  const groups = new Map([[7, { id: 7, color: "blue", title: "Work", collapsed: true }]])
  const mutations = []
  const api = {
    tabs: {
      get: async (id) => ({ ...tabs.find((tab) => tab.id === id) }),
      query: async ({ groupId }) => tabs.filter((tab) => tab.groupId === groupId).map((tab) => ({ ...tab })),
      group: async ({ tabIds }) => {
        mutations.push({ group: tabIds })
        groups.set(8, { id: 8, color: "grey", title: "", collapsed: false })
        for (const tab of tabs) if (tabIds.includes(tab.id)) tab.groupId = 8
        return 8
      },
      ungroup: async (ids) => {
        mutations.push({ ungroup: ids })
        for (const tab of tabs) if (ids.includes(tab.id)) tab.groupId = -1
      },
    },
    tabGroups: {
      get: async (id) => ({ ...groups.get(id) }),
      update: async (id, update) => {
        mutations.push({ id, update })
        Object.assign(groups.get(id), update)
      },
    },
  }
  return { tabs, groups, mutations, controller: createGroupMarkers(api), api }
}

test("green group marker refuses a missing member grant without mutations", async () => {
  const state = fixture()
  expect(await state.controller.ensure(1, undefined, true, [1, 2]).catch((error) => error.message)).toContain("grant is missing")
  await state.controller.setGrants("owner", [1])
  expect(await state.controller.ensure(1, "owner", true, [1, 2]).catch((error) => error.message)).toContain("Every group member")
  expect(state.mutations).toEqual([])
})

test("green group marker requires an explicit grant and restores the saved appearance", async () => {
  const state = fixture()
  await state.controller.setGrants("owner", [1, 2])
  expect(await state.controller.ensure(1, "owner").catch((error) => error.message)).toContain("explicit")
  expect(state.mutations).toEqual([])
  await state.controller.ensure(1, "owner", true, [1, 2])
  expect(state.groups.get(7)).toEqual({ id: 7, color: "green", title: "Work", collapsed: true })
  expect(await state.controller.release(1)).toEqual([2])
  expect(state.groups.get(7)).toEqual({ id: 7, color: "blue", title: "Work", collapsed: true })
  expect(state.tabs.map((tab) => [tab.id, tab.index, tab.windowId])).toEqual([[1, 0, 1], [2, 1, 1]])
})

test("green group marker stops on membership changes without modifying the changed group", async () => {
  const state = fixture()
  await state.controller.setGrants("owner", [1, 2])
  await state.controller.ensure(1, "owner", true, [1, 2])
  state.tabs.push({ id: 3, groupId: 7, index: 2, windowId: 1, active: false, pinned: false })
  expect(await state.controller.validate()).toEqual([1, 2])
  expect(await state.controller.release(1)).toEqual([])
  expect(state.mutations).toEqual([{ id: 7, update: { color: "green" } }])
  expect(state.tabs[2].groupId).toBe(7)
})

test("green group marker stops on grant withdrawal or replacement without restoration", async () => {
  for (const replacement of [false, true]) {
    const state = fixture()
    await state.controller.setGrants("owner", [1, 2])
    await state.controller.ensure(1, "owner", true, [1, 2])
    const lost = replacement
      ? await state.controller.setGrants("other", [2])
      : await state.controller.setGrants("owner", [1])
    expect(lost).toEqual([1, 2])
    expect(state.mutations).toEqual([{ id: 7, update: { color: "green" } }])
  }
})

test("green group marker preserves user appearance and position changes", async () => {
  for (const change of ["color", "title", "collapsed", "position", "navigation"]) {
    const state = fixture()
    await state.controller.setGrants("owner", [1, 2])
    await state.controller.ensure(1, "owner", true, [1, 2])
    if (change === "color") state.groups.get(7).color = "red"
    if (change === "title") state.groups.get(7).title = "Personal"
    if (change === "collapsed") state.groups.get(7).collapsed = false
    if (change === "position") state.tabs[0].index = 3
    if (change === "navigation") state.tabs[0].url = "https://different.test/"
    expect(await state.controller.validate()).toEqual([1, 2])
    await state.controller.release(1)
    expect(state.mutations).toEqual([{ id: 7, update: { color: "green" } }])
  }
})

test("green group marker never cleans stale appearance after controller restart", async () => {
  const state = fixture()
  await state.controller.setGrants("owner", [1, 2])
  await state.controller.ensure(1, "owner", true, [1, 2])
  const restarted = createGroupMarkers(state.api)
  expect(await restarted.validate()).toEqual([])
  expect(await restarted.release(1)).toEqual([])
  expect(state.groups.get(7).color).toBe("green")
  expect(state.mutations).toEqual([{ id: 7, update: { color: "green" } }])
})

test("green group marker preserves active ungrouped control and refuses active or pinned group mutation", async () => {
  const state = fixture()
  state.tabs[0].groupId = -1
  state.tabs[0].active = true
  await state.controller.setGrants("owner", [1, 2])
  await state.controller.ensure(1, "owner")
  expect(state.mutations).toEqual([])
  expect(await state.controller.ensure(1, "owner", true, [1]).catch((error) => error.message)).toContain("inactive")
  state.tabs[0].active = false
  state.tabs[0].pinned = true
  expect(await state.controller.ensure(1, "owner").catch((error) => error.message)).toContain("Pinned")
  expect(state.mutations).toEqual([])
})

test("green group marker restores only its unchanged inactive singleton", async () => {
  const state = fixture()
  state.tabs[0].groupId = -1
  await state.controller.setGrants("owner", [1])
  await state.controller.ensure(1, "owner")
  expect(state.tabs[0].groupId).toBe(8)
  await state.controller.release(1)
  expect(state.tabs[0].groupId).toBe(-1)
  expect(state.tabs[0].index).toBe(0)
  expect(state.tabs[1].groupId).toBe(7)
})

test("green group marker leaves an active group's appearance on release", async () => {
  const state = fixture()
  await state.controller.setGrants("owner", [1, 2])
  await state.controller.ensure(1, "owner", true, [1, 2])
  state.tabs[1].active = true
  await state.controller.release(1)
  expect(state.groups.get(7).color).toBe("green")
  expect(state.mutations).toHaveLength(1)
})

test("green group marker reports a restoration failure without retrying or blocking release", async () => {
  const state = fixture()
  await state.controller.setGrants("owner", [1, 2])
  await state.controller.ensure(1, "owner", true, [1, 2])
  let attempts = 0
  state.api.tabGroups.update = async () => { attempts++; throw new Error("Chrome denied restoration") }
  const warning = spyOn(console, "warn").mockImplementation(() => {})
  try {
    expect(await state.controller.release(1)).toEqual([2])
    expect(await state.controller.release(1)).toEqual([])
    expect(attempts).toBe(1)
    expect(warning).toHaveBeenCalledWith("Native group marker restoration failed; no retry attempted")
  } finally {
    warning.mockRestore()
  }
})
