import { expect, test } from "bun:test"
import { renderToString } from "solid-js/web"
import { Collapsible } from "./collapsible"

test("a closed Collapsible renders an inert, hidden shell and does not mount its children", () => {
  const html = renderToString(() => (
    <Collapsible open={false} id="panel" class="extra">
      <p>BODY</p>
    </Collapsible>
  ))
  expect(html).toContain('class="collapsible extra"')
  expect(html).toContain('id="panel"')
  expect(html).toContain("inert")
  expect(html).toContain('aria-hidden="true"')
  expect(html).toContain('<div class="collapsible__inner">')
  expect(html).not.toContain("data-open")
  expect(html).not.toContain("BODY")
})

test("an open Collapsible marks data-open, drops inert and aria-hidden, and mounts its children", () => {
  const html = renderToString(() => (
    <Collapsible open={true} id="panel">
      <p>BODY</p>
    </Collapsible>
  ))
  expect(html).toContain('class="collapsible"')
  expect(html).toContain('data-open=""')
  expect(html).not.toContain("inert")
  expect(html).not.toContain("aria-hidden")
  expect(html).toContain('<div class="collapsible__inner"><p>BODY</p></div>')
})
