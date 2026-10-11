import { plugin } from "bun"
import solidPlugin from "vite-plugin-solid"

const transform = solidPlugin({ solid: { generate: "ssr", hydratable: false }, hot: false }).transform
if (typeof transform !== "function") throw new Error("The Solid compiler must provide a transform hook")
const compile: OmitThisParameter<typeof transform> = transform

plugin({
  name: "web-solid-tests",
  setup(build) {
    build.onLoad({ filter: /^(?!.*[/\\]node_modules[/\\]).*\.[jt]sx$/ }, async (args) => {
      const result = await compile(await Bun.file(args.path).text(), args.path)
      if (!result || typeof result === "string" || !result.code) throw new Error(`Solid did not compile ${args.path}`)
      return { contents: result.code, loader: "ts" }
    })
  },
})
