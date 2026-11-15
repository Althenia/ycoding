export function createGroupMarkers(api) {
  const grants = new Map()
  const markers = new Map()

  const appearance = (group) => ({ color: group.color, title: group.title ?? "", collapsed: group.collapsed })
  const sameAppearance = (left, right) =>
    left.color === right.color && left.title === right.title && left.collapsed === right.collapsed
  const sameMembers = (saved, current) => saved.length === current.length && saved.every((member) =>
    current.some((tab) => tab.id === member.id && tab.index === member.index && tab.windowId === member.windowId &&
      tab.url === member.url && !tab.pinned))

  async function current(entry) {
    const [group, members] = await Promise.all([api.tabGroups.get(entry.id), api.tabs.query({ groupId: entry.id })])
    return { group, members, owned: sameMembers(entry.members, members) &&
      members.every((tab) => grants.get(tab.id) === entry.owner) &&
      sameAppearance(appearance(group), { ...entry.appearance, color: "green" }) }
  }

  async function validate() {
    const existing = [...markers.values()]
    const lost = []
    for (const entry of existing) {
      const state = await current(entry).catch(() => undefined)
      if (markers.get(entry.id) !== entry) continue
      if (state?.owned) continue
      markers.delete(entry.id)
      lost.push(...entry.members.map((tab) => tab.id))
    }
    return [...new Set(lost)]
  }

  async function setGrants(owner, ids) {
    const selected = new Set(ids)
    for (const [id, held] of grants) if (held === owner && !selected.has(id)) grants.delete(id)
    for (const id of ids) grants.set(id, owner)
    return validate()
  }

  async function ensure(id, owner, explicit = false, selected) {
    const tab = await api.tabs.get(id)
    if (tab.pinned) throw new Error("Pinned tabs cannot show the YCoding control marker; unpin the tab first")
    if (typeof owner !== "string" || !owner || grants.get(id) !== owner) throw new Error("Tab control grant is missing")
    const groupID = tab.groupId ?? -1
    if (groupID === -1 && tab.active && !explicit) return
    let members = groupID === -1 ? [tab] : await api.tabs.query({ groupId: groupID })
    if (!members.length || members.some((member) => member.pinned || grants.get(member.id) !== owner))
      throw new Error("Every group member needs the same Session control grant")
    if (selected && (selected.length !== members.length || members.some((member) => !selected.includes(member.id))))
      throw new Error("Group membership changed")
    const existing = markers.get(groupID)
    if (existing) {
      if (!(await current(existing)).owned) throw new Error("Group marker ownership changed")
      return
    }
    if (groupID !== -1 && !explicit) throw new Error("Existing groups require an explicit all-member group-control grant")
    if (members.some((member) => member.active)) throw new Error("Group control requires inactive tabs")
    const original = members.map((member) => ({ ...member }))
    const created = groupID === -1
    const idOfGroup = created ? await api.tabs.group({ tabIds: [id] }) : groupID
    const group = await api.tabGroups.get(idOfGroup)
    members = await api.tabs.query({ groupId: idOfGroup })
    if (!sameMembers(original, members)) throw new Error("Group membership changed")
    if (members.some((member) => member.active || member.pinned || grants.get(member.id) !== owner))
      throw new Error("Group control grant changed")
    const entry = { id: idOfGroup, owner, created, members: members.map((member) => ({ ...member })), appearance: appearance(group) }
    await api.tabGroups.update(idOfGroup, { color: "green" })
    markers.set(idOfGroup, entry)
    if (!(await current(entry)).owned) {
      markers.delete(idOfGroup)
      throw new Error("Group marker ownership changed")
    }
  }

  async function release(id) {
    const entry = [...markers.values()].find((marker) => marker.members.some((member) => member.id === id))
    if (!entry) { grants.delete(id); return [] }
    const state = await current(entry).catch(() => undefined)
    markers.delete(entry.id)
    for (const member of entry.members) grants.delete(member.id)
    if (state?.owned && state.members.every((member) => !member.active)) {
      try {
        if (entry.created) await api.tabs.ungroup(entry.members.map((member) => member.id))
        else await api.tabGroups.update(entry.id, entry.appearance)
      } catch {
        console.warn("Native group marker restoration failed; no retry attempted")
      }
    }
    return entry.members.map((member) => member.id).filter((member) => member !== id)
  }

  async function prepareGroup(ids) {
    for (const id of ids) {
      const tab = await api.tabs.get(id)
      if (tab.active || tab.pinned) throw new Error("Only inactive unpinned tabs can be grouped")
      if ((tab.groupId ?? -1) === -1) continue
      const entry = markers.get(tab.groupId)
      if (!entry?.created || !(await current(entry)).owned) throw new Error("Only ungrouped tabs can be grouped")
    }
    for (const id of ids) {
      const entry = [...markers.values()].find((marker) => marker.members.some((member) => member.id === id))
      if (!entry?.created) continue
      const state = await current(entry)
      if (!state.owned || state.members.some((member) => member.active)) throw new Error("Group marker ownership changed")
      markers.delete(entry.id)
      await api.tabs.ungroup([id])
    }
  }

  async function prepareUngroup(ids) {
    const entry = [...markers.values()].find((marker) => marker.members.some((member) => ids.includes(member.id)))
    if (!entry) return
    if (!(await current(entry)).owned || entry.members.length !== ids.length || entry.members.some((member) => !ids.includes(member.id)))
      throw new Error("Group marker ownership changed")
    markers.delete(entry.id)
  }

  return { setGrants, ensure, validate, release, prepareGroup, prepareUngroup }
}
