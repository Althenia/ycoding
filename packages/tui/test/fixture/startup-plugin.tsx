import { Plugin } from "@ycoding-ai/plugin/tui"

export function startupPluginFixture() {
  const fixture = {
    entered: Promise.withResolvers<void>(),
    gate: Promise.withResolvers<void>(),
    navigate: false,
    cleanups: 0,
    context: undefined as Plugin.Context | undefined,
  }
  current = fixture
  return fixture
}

let current: ReturnType<typeof startupPluginFixture>

export default Plugin.define({
  id: "fixture.startup",
  async setup(context) {
    const fixture = current
    fixture.context = context
    context.ui.router.register({ name: "startup", render: () => <text>Fixture extension page</text> })
    if (fixture.navigate) context.ui.router.navigate({ type: "plugin", name: "startup" })
    fixture.entered.resolve()
    await fixture.gate.promise
    return () => {
      fixture.cleanups++
    }
  },
})
