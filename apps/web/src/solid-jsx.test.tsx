import { expect, test } from "bun:test"
import { Show } from "solid-js"
import { renderToString } from "solid-js/web"

test("Bun tests compile Solid JSX components, conditional children and escaped text", () => {
  const Notice = (props: { title: string; visible: boolean }) => (
    <section aria-label={props.title}>
      <Show when={props.visible} fallback={<span>Hidden</span>}>
        <strong>{props.title}</strong>
      </Show>
    </section>
  )
  expect(renderToString(() => <Notice title="Ready & waiting" visible />)).toBe(
    '<section aria-label="Ready &amp; waiting"><strong>Ready &amp; waiting</strong></section>',
  )
  expect(renderToString(() => <Notice title="Private" visible={false} />)).toBe(
    '<section aria-label="Private"><span>Hidden</span></section>',
  )
})
