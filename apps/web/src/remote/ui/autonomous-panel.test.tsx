import { expect, test } from "bun:test"
import { renderToString } from "solid-js/web"
import type { SessionAutonomyView } from "../projection"
import { AutonomousPanel } from "./autonomous-panel"

const idle = { permissions: "manual", guardrails: "manual", answers: "manual", inherited: {}, asleep: false, guardrailsEnabled: true } as const
const autonomy = (change: Partial<SessionAutonomyView> = {}): SessionAutonomyView => ({
  mode: "normal",
  permissions: "manual",
  guardrails: "manual",
  answers: "manual",
  effective: idle,
  ...change,
})

const render = (props: Partial<Parameters<typeof AutonomousPanel>[0]> = {}) => renderToString(() => (
  <AutonomousPanel autonomy={autonomy()} selected={0} busy={false} reachable onIntent={() => undefined} {...props} />
))

const tag = (html: string, id: string) => html.match(new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>`))?.[0] ?? ""

test("lists Permissions, Guardrails, and Answers as one selectable list with the first row selected", () => {
  const html = render()
  expect(html).toContain('role="listbox"')
  expect(html).toContain('aria-label="Autonomous settings"')
  for (const category of ["permissions", "guardrails", "answers"]) expect(tag(html, `autonomous-row-${category}`)).toContain('role="option"')
  expect(tag(html, "autonomous-row-permissions")).toContain('aria-selected="true"')
  expect(tag(html, "autonomous-row-guardrails")).toContain('aria-selected="false"')
  expect(html).toContain('aria-activedescendant="autonomous-row-permissions"')
  expect(html.indexOf("Permissions")).toBeLessThan(html.indexOf("Guardrails"))
  expect(html.indexOf("Guardrails")).toBeLessThan(html.indexOf("Answers"))
  expect(render({ selected: 2 })).toContain('aria-activedescendant="autonomous-row-answers"')
})

test("each row offers previous and next arrows named for its category and shows its effective mode word", () => {
  const html = render({ autonomy: autonomy({ permissions: "auto", guardrails: "yolo", effective: { ...idle, permissions: "auto", guardrails: "yolo" } }) })
  for (const title of ["Permissions", "Guardrails", "Answers"]) {
    expect(html).toContain(`aria-label="Previous ${title} mode"`)
    expect(html).toContain(`aria-label="Next ${title} mode"`)
  }
  expect(tag(html, "autonomous-row-permissions")).toContain('aria-label="Permissions: Auto"')
  expect(tag(html, "autonomous-row-guardrails")).toContain('aria-label="Guardrails: YOLO"')
  expect(tag(html, "autonomous-row-answers")).toContain('aria-label="Answers: Manual"')
})

test("set-all offers Manual, YOLO, and Auto with the 1, 2, and 3 shortcuts", () => {
  const html = render()
  expect(html).toContain('aria-label="Set all categories"')
  const buttons = [...html.matchAll(/<button[^>]*aria-keyshortcuts="([123])"[^>]*>/g)].map((match) => match[1])
  expect(buttons).toEqual(["1", "2", "3"])
  expect(html.indexOf("Manual")).toBeLessThan(html.lastIndexOf("YOLO"))
  expect(html).toContain("Set all to Manual")
  expect(html).toContain("Set all to YOLO")
  expect(html).toContain("Set all to Auto")
})

test("an inherited mode shows the effective word and its source, never Manual", () => {
  const html = render({ autonomy: autonomy({ effective: { ...idle, permissions: "auto", answers: "yolo", inherited: { permissions: "ses_parent", answers: "ses_root" } } }) })
  const permissions = tag(html, "autonomous-row-permissions")
  expect(permissions).toContain('aria-label="Permissions: Auto, inherited from ses_parent"')
  expect(tag(html, "autonomous-row-answers")).toContain('aria-label="Answers: YOLO, inherited from ses_root"')
  expect(tag(html, "autonomous-row-guardrails")).toContain('aria-label="Guardrails: Manual"')
  expect(html).toContain("Inherited from ses_parent")
  expect(html).toContain("Inherited from ses_root")
  expect(html).toContain("This Session: Manual")
  expect(html.match(/Inherited from/g)).toHaveLength(2)
})

test("a row names who decides for its effective mode", () => {
  const html = render({ autonomy: autonomy({ effective: { ...idle, permissions: "auto", guardrails: "yolo", answers: "manual", asleep: true } }) })
  expect(html).toContain("Rules approve permission asks; denies still block")
  expect(html).toContain("YOLO evaluates reviews; hard reviews still need your approval")
  expect(html).toContain("Review box holds each question")
})

test("always states that denies, ceilings, and hard or custom-rule reviews stay with you", () => {
  const html = render()
  expect(html).toContain("Denies and permission ceilings always apply")
  expect(html).toContain("hard and custom-rule reviews always need you")
})

test("a busy request disables every arrow and set-all button and announces the wait", () => {
  const html = render({ busy: true })
  const buttons = html.match(/<button[^>]*>/g) ?? []
  expect(buttons.length).toBeGreaterThanOrEqual(9)
  for (const button of buttons) expect(button).toContain("disabled")
  expect(html).toContain('aria-busy="true"')
  expect(render()).not.toContain('aria-busy="true"')
})

test("an unreachable connection disables the controls and says why", () => {
  const html = render({ reachable: false })
  for (const button of html.match(/<button[^>]*>/g) ?? []) expect(button).toContain("disabled")
  expect(html).toContain("Reconnect to change autonomy")
  expect(render()).not.toContain("Reconnect to change autonomy")
})

test("a failed or unconfirmed change stays as an alert beside the controls", () => {
  const html = render({ failure: "Outcome unknown: Request timed out. Check the modes above before changing them again." })
  expect(html).toContain('role="alert"')
  expect(html).toContain("Outcome unknown: Request timed out. Check the modes above before changing them again.")
  expect(render()).not.toContain('role="alert"')
})

test("the announcement lives in a polite status region", () => {
  const html = render({ announcement: "Permissions set to Auto" })
  expect(html).toMatch(/<[a-z]+[^>]*role="status"[^>]*>[^<]*Permissions set to Auto/)
})
