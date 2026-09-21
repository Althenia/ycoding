import { defineConfig, mergeConfig, type Plugin } from "vite"
import base from "../vite.config"

function matchedSiteContent(): Plugin {
  return {
    name: "verify-matched-site-content",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "../content/site" && importer?.endsWith("/src/ui/site.tsx")) return "\0verify-matched-site-content"
      if (source === "../content/docs/registry" && (importer?.endsWith("/src/ui/docs.tsx") || importer?.endsWith("/src/ui/changelog.tsx")))
        return "\0verify-matched-docs-registry"
      if (source === "../content/changelog" && importer?.endsWith("/src/ui/changelog.tsx")) return "\0verify-matched-changelog"
      return null
    },
    load(id) {
      if (id === "\0verify-matched-site-content")
        return `export { SITE } from ${JSON.stringify(new URL("./matched-content/site.ts", import.meta.url).pathname)}`
      if (id === "\0verify-matched-docs-registry")
        return `export * from ${JSON.stringify(new URL("./matched-content/docs-registry.ts", import.meta.url).pathname)}`
      if (id === "\0verify-matched-changelog")
        return `export * from ${JSON.stringify(new URL("./matched-content/changelog.ts", import.meta.url).pathname)}`
      return null
    },
  }
}

export default mergeConfig(
  base,
  defineConfig({
    plugins: [matchedSiteContent()],
  }),
)
