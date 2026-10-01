import { Plugin } from "@ycoding-ai/plugin/tui"

export const contexts: Plugin.Context[] = []

export default Plugin.define({
  id: "test:client-observer",
  setup(context) {
    contexts.push(context)
    return () => {
      contexts.splice(contexts.indexOf(context), 1)
    }
  },
})
