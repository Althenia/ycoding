import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { projectOffice, shortText, maxOfficeActors } from './model'
import { defaultOfficePreferences, readOfficePreferences, hasReducedMotion } from './preferences'
import { createOfficeMailbox } from './bridge'
import { scenario } from './scenarios.test-helper'
const preferences = defaultOfficePreferences
const model = (kind = 'tool') => projectOffice(scenario(kind), preferences)
const selected = (kind: string) => model(kind).actors.find((actor) => actor.selected)!

test('signed-out input has no session data', () => assert.equal(model('signed-out').actors.length, 0))
test('missing selected device cannot display remembered sessions', () => assert.equal(projectOffice({ ...scenario('tool'), deviceID: undefined }, preferences).actors.length, 0))
test('empty is empty, never demo data', () => assert.deepEqual(model('empty').actors, []))
for (const [input, expected] of [['tool','tool'],['thinking','thinking'],['attention','attention'],['compacting','compacting'],['idle','idle'],['failed','failed'],['interrupted','interrupted'],['offline','offline'],['reconnecting','reconnecting']] as const) {
  test(`selected ${input} projects as ${expected}`, () => assert.equal(selected(input).status, expected))
}
test('the selected root without live detail uses its reported running state', () => assert.equal(projectOffice({ ...scenario('tool'), selected: undefined }, preferences).actors[0]!.status, 'working'))
test('the selected root can show its own last reported idle state', () => assert.equal(projectOffice({ ...scenario('tool'), activeSessionID: 'session-c', selected: undefined }, preferences).actors[0]!.bubble, 'Last reported: idle'))
test('stale view for another session is ignored', () => {
  const result = projectOffice({ ...scenario('attention'), selected: { ...scenario('attention').selected!, id: 'not-selected' } }, preferences)
  assert.equal(result.actors[0]!.source, 'summary')
  assert.notEqual(result.actors[0]!.status, 'attention')
})
test('a selected detail cannot affect an unselected session', () => {
  const result = projectOffice({ ...scenario('attention'), activeSessionID: 'session-b' }, preferences)
  assert.equal(result.actors.some((a) => a.sessionID === 'session-a'), false)
  assert.equal(result.actors[0]!.source, 'summary')
})
test('historical tool activity does not make an idle session busy', () => {
  const input = scenario('tool')
  assert.equal(projectOffice({ ...input, sessions: input.sessions.map((session) => session.id === 'session-a' ? { ...session, running: false } : session), selected: { ...input.selected!, status: 'idle' as const } }, preferences).actors[0]!.status, 'idle')
})
test('a reported running root overrides a lagging idle detail and retains thinking', () => {
  for (const [thinking, status, label] of [[false, 'working', 'Implementing'], [true, 'thinking', 'Thinking']] as const) {
    const input = scenario('idle')
    const root = projectOffice({ ...input, sessions: input.sessions.map((session) => session.id === 'session-a' ? { ...session, running: true } : session), selected: { ...input.selected!, thinking } }, preferences).actors[0]!
    assert.equal(root.status, status)
    assert.equal(root.statusText, label)
    assert.equal(root.bubble, label)
    assert.equal(root.homeRoom, 'developer')
  }
})
test('unknown mutation remains explicit', () => assert.equal(selected('unknown-outcome').unknownOutcome, true))
test('offline state cannot display an old transcript excerpt', () => {
  const input = { ...scenario('idle'), connection: 'offline' as const }
  assert.equal(projectOffice(input, { ...preferences, bubbles: 'excerpt' }).actors[0]!.bubble, 'Machine offline')
})
test('default bubbles do not expose completed text', () => assert.equal(selected('idle').bubble, 'Idle'))
test('completed text is explicit opt-in', () => assert.match(projectOffice(scenario('idle'), { ...preferences, bubbles: 'excerpt' }).actors[0]!.bubble!, /synthetic text/))
test('bubbles off suppresses status and text', () => assert.equal(projectOffice(scenario('idle'), { ...preferences, bubbles: 'off' }).actors[0]!.bubble, undefined))
test('bounded text preserves Unicode code points and removes controls', () => {
  assert.equal(shortText('😀😀😀😀', 3), '😀😀…')
  assert.equal(shortText('a\u202eb\nc', 20), 'a b c')
})
test('family actor bound counts only reported children and preserves selected child', () => {
  const base = scenario('tool')
  const members = Array.from({ length: 40 }, (_, index) => ({ sessionID: `session-${index}`, parentID: 'session-a', description: `Task ${index}`, state: 'running' as const }))
  const input = { ...base, activeSessionID: 'session-39', selected: undefined, team: { rootID: 'session-a', status: 'ready' as const, members, cues: [], more: false } }
  const output = projectOffice(input, preferences)
  assert.equal(output.actors.length, maxOfficeActors)
  assert.equal(output.overflow, 41 - maxOfficeActors)
  assert.ok(output.actors.some((actor) => actor.sessionID === 'session-39'))
  assert.ok(output.actors.some((actor) => actor.sessionID === 'session-a'))
})
test('duplicate listed Sessions never create extra family avatars', () => {
  const input = scenario('tool')
  assert.equal(projectOffice({ ...input, sessions: [...input.sessions, input.sessions[0]!] }, preferences).actors.length, 1)
})
test('archived unrelated Sessions stay outside the selected Office', () => {
  const input = scenario('tool')
  assert.deepEqual(projectOffice({ ...input, sessions: input.sessions.map((s) => ({ ...s, archived: true })) }, preferences).actors.map((actor) => actor.sessionID), ['session-a'])
})
test('owner or device changes have different scene scopes', () => {
  assert.notEqual(model().scope, projectOffice({ ...scenario('tool'), ownerID: 'other-owner' }, preferences).scope)
  assert.notEqual(model().scope, projectOffice({ ...scenario('tool'), deviceID: 'other-device' }, preferences).scope)
})
test('settings reject invalid versions and fields', () => {
  assert.deepEqual(readOfficePreferences(null), preferences)
  assert.deepEqual(readOfficePreferences({ version: 999, labels: false }), preferences)
  assert.equal(readOfficePreferences({ version: 1, labels: false, quality: 'ultra' }).labels, false)
  assert.equal(readOfficePreferences({ version: 1, quality: 'ultra' }).quality, 'standard')
})
test('system reduced motion cannot be overridden by full animation', () => {
  assert.ok(hasReducedMotion(preferences, true)); assert.ok(hasReducedMotion({ ...preferences, motion:'reduced' }, false))
  assert.equal(hasReducedMotion(preferences, false), false)
})
test('mailbox holds latest state, not an unbounded event queue', () => {
  const mailbox = createOfficeMailbox({ snapshot:model(),preferences,systemReduced:false })
  for(let i=0;i<10000;i++) mailbox.update({ snapshot:model('attention'), preferences,systemReduced:false })
  assert.equal(mailbox.revision(),10000); assert.equal(mailbox.read().snapshot.actors[0]!.status,'attention')
})
