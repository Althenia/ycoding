import { expect, test } from "bun:test"

const sessionRoute = await Bun.file(new URL("../src/routes/session/index.tsx", import.meta.url)).text()

test("session transcript does not render the redundant top header slot", () => {
  expect(sessionRoute).not.toContain('name="session.header"')
})
