import { defineConfig, type Plugin } from "vite"
import solidPlugin from "vite-plugin-solid"
import { markdownAssets } from "./src/seo/llms"
import { buildSitemap } from "./src/seo/sitemap"

// The verification fixture is an extra entry only for `YCODING_WEB_VERIFY=1`, so a
// production build never contains the synthetic transport or its sample data.
const verification = process.env.YCODING_WEB_VERIFY === "1"

/**
 * Emits sitemap.xml directly from the published documentation allowlist the
 * registry owns, so the crawler index cannot drift into a second URL list.
 */
function sitemapPlugin(): Plugin {
  return {
    name: "ycoding-sitemap",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: buildSitemap() })
    },
  }
}

/**
 * Emits `/llms.txt`, `/llms-full.txt`, and one `/docs/<slug>.md` per published
 * page from the same registry, so agents read the documentation as Markdown.
 */
function llmsPlugin(): Plugin {
  return {
    name: "ycoding-llms",
    apply: "build",
    generateBundle() {
      for (const asset of markdownAssets()) this.emitFile({ type: "asset", fileName: asset.fileName, source: asset.source })
    },
  }
}

export default defineConfig({
  plugins: [solidPlugin(), sitemapPlugin(), llmsPlugin()],
  server: { port: 3002 },
  build: {
    target: "esnext",
    rollupOptions: {
      // The service worker is a separate module entry so it can import the shared
      // offline policy instead of duplicating the cache rules as string literals.
      input: {
        index: "index.html",
        "service-worker": "src/service-worker.ts",
        ...(verification ? { "verify-remote": "verify/remote.html" } : {}),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "service-worker" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
})
