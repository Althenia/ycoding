import { resolve } from "node:path"
import { build, defineConfig, type Plugin } from "vite"
import solidPlugin from "vite-plugin-solid"
import { markdownAssets } from "./src/seo/llms"
import { buildSitemap } from "./src/seo/sitemap"
import { schemeStylesheet } from "./src/theme/schemes"

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

function schemesPlugin(): Plugin {
  return {
    name: "ycoding-schemes",
    transformIndexHtml: () => [{ tag: "style", attrs: { id: "yc-schemes" }, children: schemeStylesheet(), injectTo: "head" }],
  }
}

function routePrefetchPlugin(routes: readonly string[]): Plugin {
  let base = "/"
  let modules = new Set<string>()
  return {
    name: "ycoding-route-prefetch",
    apply: "build",
    configResolved(config) {
      base = config.base
      modules = new Set(routes.map((route) => resolve(config.root, route)))
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, { chunk, bundle }) {
        if (!chunk || !bundle) return []
        const reach = (names: readonly string[], seen = new Set<string>()) => {
          for (const name of names) {
            const target = bundle[name]
            if (seen.has(name) || target?.type !== "chunk") continue
            seen.add(name)
            reach(target.imports, seen)
          }
          return seen
        }
        const eager = reach([chunk.fileName])
        const entries = chunk.dynamicImports.filter((name) => {
          const target = bundle[name]
          return target?.type === "chunk" && target.facadeModuleId !== null && modules.has(target.facadeModuleId)
        })
        return [...reach(entries)]
          .filter((name) => !eager.has(name))
          .map((name) => ({ tag: "link", attrs: { rel: "prefetch", href: `${base}${name}`, crossorigin: true }, injectTo: "head" as const }))
      },
    },
  }
}

function serviceWorkerPlugin(): Plugin {
  let root = ""
  let outDir = ""
  return {
    name: "ycoding-service-worker",
    apply: "build",
    configResolved(config) {
      root = config.root
      outDir = resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      await build({
        configFile: false,
        root,
        logLevel: "warn",
        build: {
          target: "esnext",
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          rollupOptions: {
            input: "src/service-worker.ts",
            output: { entryFileNames: "sw.js" },
            treeshake: { moduleSideEffects: false },
          },
        },
      })
    },
  }
}

export default defineConfig({
  plugins: [solidPlugin(), sitemapPlugin(), llmsPlugin(), schemesPlugin(), routePrefetchPlugin(["src/ui/changelog.tsx"]), serviceWorkerPlugin()],
  server: { port: 3002 },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        index: "index.html",
        ...(verification ? { "verify-remote": "verify/remote.html" } : {}),
      },
      output: {
        manualChunks: (id) => (id.includes("/packages/protocol/") || id.includes("/node_modules/@bufbuild/") ? "protocol" : undefined),
      },
    },
  },
})
