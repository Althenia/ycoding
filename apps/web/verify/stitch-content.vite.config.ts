import { defineConfig, mergeConfig, type Plugin } from "vite"
import base from "../vite.config"

function stitchContent(): Plugin {
  return {
    name: "verify-stitch-public-content",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "../content/site" && importer?.endsWith("/src/ui/site.tsx")) return "\0verify-stitch-site"
      if (source === "../content/docs/registry" && (importer?.endsWith("/src/ui/docs.tsx") || importer?.endsWith("/src/ui/changelog.tsx"))) return "\0verify-stitch-registry"
      if (source === "../content/changelog" && importer?.endsWith("/src/ui/changelog.tsx")) return "\0verify-stitch-changelog"
      if (source === "../content/docs/search" && importer?.endsWith("/src/ui/docs.tsx")) return "\0verify-stitch-search"
      return null
    },
    load(id) {
      if (id === "\0verify-stitch-site") return `export { SITE } from ${JSON.stringify(new URL("./stitch-content/site.ts", import.meta.url).pathname)}`
      if (id === "\0verify-stitch-registry") return `export * from ${JSON.stringify(new URL("./stitch-content/docs-registry.ts", import.meta.url).pathname)}`
      if (id === "\0verify-stitch-changelog") return `export * from ${JSON.stringify(new URL("./stitch-content/changelog.ts", import.meta.url).pathname)}`
      // P12, export-adaptation/p12.html: the search board has state-specific display titles.
      if (id === "\0verify-stitch-search") return `export function searchDocs(query, limit = 12) { if (query.trim().toLowerCase() !== "getting started") return []; return [{ page: { slug: "quickstart", title: "Quickstart Guide & Environment Initialization", group: "Get started", description: "Follow these step-by-step instructions for getting started with remote workspace provisioning and container agents.", sections: [] }, matchedHeading: "Core Setup", score: 100 }, { page: { slug: "installation", title: "CLI Installation & System Prerequisites", group: "Get started", description: "Prerequisites and fast bootstrap packages for getting started in headless Linux runtime environments.", sections: [] }, matchedHeading: "CLI", score: 90 }, { page: { slug: "configuration/agents", title: "Agent Lifecycle: First Execution Run", group: "Configuration", description: "Understanding agent state machines when getting started with asynchronous AST transformation workflows.", sections: [] }, matchedHeading: "Configuration", score: 80 }].slice(0, limit) }`
      return null
    },
  }
}

export default mergeConfig(base, defineConfig({ plugins: [stitchContent()] }))
