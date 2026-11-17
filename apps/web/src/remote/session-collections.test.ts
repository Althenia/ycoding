import { expect, test } from "bun:test"
import { readSessionInfoList, readSnapshot } from "./projection"
import { readSessionCandidates } from "./coordination"
import { readSessionInfo } from "./store"

const root = { id: "ses_owner", title: "Compaction planning", agent: "god", location: { directory: "/work/web" }, time: { updated: 1 } }
const helper = { ...root, id: "ses_compaction_0123456789abcdef01234567", title: "Renamed helper", parentID: root.id, agent: "compaction", origin: null }
const roleHelper = { ...helper, id: "ses_internal" }
const child = { ...root, id: "ses_child", parentID: root.id, agent: "occam" }
const btw = { ...child, id: "ses_btw", agent: "btw" }
const fork = { ...root, id: "ses_fork", title: "Fork" }

test("ordinary collection projection excludes helpers by role or identity, not title", () => {
  expect(readSessionInfoList({ data: [root, helper, roleHelper, { ...helper, agent: undefined, parentID: undefined }, { ...roleHelper, parentID: undefined }, fork] }))
    .toEqual([root, fork])
})

test("root collections exclude child rows without changing direct Session or snapshot projection", () => {
  expect(readSessionInfoList({ data: [root, child, btw, fork] })).toEqual([root, fork])
  for (const session of [helper, child, btw, fork]) {
    expect(readSessionInfo(session)).toMatchObject({ id: session.id, agent: session.agent })
    expect(readSnapshot({ session, messages: [], watermark: { aggregateID: session.id, seq: 0 } }))
      .toMatchObject({ sessionID: session.id, agent: session.agent })
  }
})

test("Project root candidates use the ordinary collection policy and retain legitimate named roots", () => {
  const candidates = readSessionCandidates({ data: [root, { ...helper, parentID: undefined }, { ...roleHelper, parentID: undefined }, child, btw, fork] })
  expect(candidates.map(row => row.id)).toEqual([root.id, fork.id])
})
