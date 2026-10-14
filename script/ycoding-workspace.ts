import path from "node:path"
import { readdir } from "node:fs/promises"
import ts from "typescript"

export const approvedPackageNames = new Set([
  "@ycoding-ai/ai",
  "@ycoding-ai/cli",
  "@ycoding-ai/client",
  "@ycoding-ai/codemode",
  "@ycoding-ai/core",
  "@ycoding-ai/effect-drizzle-sqlite",
  "@ycoding-ai/effect-sqlite-node",
  "@ycoding-ai/http-recorder",
  "@ycoding-ai/httpapi-codegen",
  "@ycoding-ai/meeting",
  "@ycoding-ai/plugin",
  "@ycoding-ai/protocol",
  "@ycoding-ai/remote",
  "@ycoding-ai/schema",
  "@ycoding-ai/script",
  "@ycoding-ai/server",
  "@ycoding-ai/simulation",
  "@ycoding-ai/tui",
  "@ycoding-ai/web",
])

export async function discoverPackageNames(root: string): Promise<string[]> {
  const names: string[] = []

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 2) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(target, depth + 1)
        continue
      }
      if (entry.name !== "package.json") continue
      const manifest = (await Bun.file(target).json()) as { name?: unknown }
      if (typeof manifest.name === "string") names.push(manifest.name)
    }
  }

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name === "packages" || entry.name === "apps" || entry.name === "extensions"))
      await visit(path.join(root, entry.name), 0)
  }
  return names.sort()
}

export async function checkWorkspace(root: string): Promise<string[]> {
  const discovered = await discoverPackageNames(root)
  return discovered.filter((name) => !approvedPackageNames.has(name))
}

const forbiddenOwners = new Set(
  ["core", "server", "ai", "store", "codemode", "effect-drizzle-sqlite", "effect-sqlite-node"].map(
    (name) => `@ycoding-ai/${name}`,
  ),
)

type Loader = { file: string; function: string; reason: string }
type SqliteReader = { file: string; module: string; reason: string }
type Violation = { frontend: string; file: string; line: number; specifier: string; owner: string; kind: string }

export const boundaryDeclarations: readonly (Loader | SqliteReader)[] = [
  {
    file: "packages/tui/src/plugin/context.tsx",
    function: "loadPlugin",
    reason: "Loads user-configured presentation plugins outside the shipped production graph",
  },
  {
    file: "packages/tui/src/editor-zed-sqlite.bun.ts",
    module: "packages/tui/src/editor-zed.ts",
    reason: "Reads Zed's own editor-context database, not the YCoding store",
  },
  {
    file: "packages/tui/src/editor-zed-sqlite.node.ts",
    module: "packages/tui/src/editor-zed.ts",
    reason: "Reads Zed's own editor-context database, not the YCoding store",
  },
]

export async function checkFrontendBoundary(
  root: string,
  options: { frontends?: string[]; loaders?: readonly Loader[]; sqliteReaders?: readonly SqliteReader[] } = {},
) {
  root = path.resolve(root)
  const packages = await Promise.all(
    (await Array.fromAsync(new Bun.Glob("{packages,apps,extensions}/*/package.json").scan({ cwd: root })))
      .sort()
      .map(async (file) => ({
        file,
        directory: path.resolve(root, path.dirname(file)),
        manifest: (await Bun.file(path.join(root, file)).json()) as {
          name: string
          exports?: unknown
          imports?: Record<string, unknown>
          main?: string
          dependencies?: Record<string, string>
          optionalDependencies?: Record<string, string>
        },
      })),
  )
  const frontends = [
    "packages/tui",
    "packages/cli",
    "apps/web",
    "packages/client",
    "packages/sdk",
    ...(await Array.fromAsync(new Bun.Glob("extensions/*").scan({ cwd: root, onlyFiles: false }))),
  ].filter(
    (frontend) =>
      !options.frontends || options.frontends.includes(frontend) || options.frontends.includes(path.basename(frontend)),
  )
  const violations: Violation[] = []
  const loaders: string[] = []
  const declarations = options.loaders ?? boundaryDeclarations.filter((entry): entry is Loader => "function" in entry)
  const readers =
    options.sqliteReaders ?? boundaryDeclarations.filter((entry): entry is SqliteReader => "module" in entry)
  const matched = new Set<Loader>()
  const matchedReaders = new Set<SqliteReader>()
  const readerOwners = new Set<SqliteReader>()
  const configs = new Map<string, ts.CompilerOptions>()
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/")
  const owner = (file: string) =>
    packages
      .filter((entry) => file.startsWith(entry.directory + path.sep))
      .sort((a, b) => b.directory.length - a.directory.length)[0]
  const forbidden = (specifier: string) =>
    [...forbiddenOwners].find((name) => specifier === name || specifier.startsWith(name + "/"))

  function compilerOptions(file: string) {
    const config = ts.findConfigFile(path.dirname(file), (file) => ts.sys.fileExists(file))
    if (!config || !config.startsWith(root + path.sep))
      return { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true }
    const cached = configs.get(config)
    if (cached) return cached
    const parsed = ts.readConfigFile(config, (file) => ts.sys.readFile(file))
    if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"))
    const result = ts.parseJsonConfigFileContent(
      parsed.config,
      { ...ts.sys, readDirectory: () => [] },
      path.dirname(config),
    ).options
    configs.set(config, result)
    return result
  }

  function resolve(specifier: string, file: string): string[] {
    const pkg = packages.find(
      (entry) => specifier === entry.manifest.name || specifier.startsWith(entry.manifest.name + "/"),
    )
    if (pkg) {
      const key = specifier === pkg.manifest.name ? "." : "." + specifier.slice(pkg.manifest.name.length)
      const exports = pkg.manifest.exports
      const targets = exportTargets(exports, key)
      if (!targets.length && exports === undefined) targets.push(key === "." ? (pkg.manifest.main ?? "./index") : key)
      return targets.flatMap((target) => resolveFile(path.resolve(pkg.directory, target), file))
    }
    const imports = owner(file)?.manifest.imports
    if (specifier.startsWith("#") && imports) {
      return exportTargets(imports, specifier).flatMap((target) =>
        target.startsWith(".")
          ? resolveFile(path.resolve(owner(file)!.directory, target), file)
          : resolve(target, file),
      )
    }
    const result = ts.resolveModuleName(specifier, file, compilerOptions(file), ts.sys).resolvedModule?.resolvedFileName
    const runtime = specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : undefined
    return [
      ...new Set(
        [result, runtime && ts.sys.fileExists(runtime) ? runtime : undefined].filter(
          (target): target is string =>
            !!target && target.startsWith(root + path.sep) && !target.includes(`${path.sep}node_modules${path.sep}`),
        ),
      ),
    ]
  }

  function resolveFile(target: string, file: string) {
    const result = ts.resolveModuleName(
      target,
      file,
      { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true },
      ts.sys,
    ).resolvedModule?.resolvedFileName
    return [
      ...new Set([result, ts.sys.fileExists(target) ? target : undefined].filter((file): file is string => !!file)),
    ]
  }

  for (const frontend of frontends) {
    const pkg = packages.find((entry) => relative(entry.directory) === frontend)
    if (pkg) {
      const text = await Bun.file(path.join(root, pkg.file)).text()
      const source = ts.parseJsonText(pkg.file, text)
      for (const field of ["dependencies", "optionalDependencies"] as const) {
        for (const specifier of Object.keys(pkg.manifest[field] ?? {})) {
          const resolvedOwner = forbidden(specifier)
          if (!resolvedOwner) continue
          const positions: number[] = []
          function visit(node: ts.Node) {
            if (
              ts.isPropertyAssignment(node) &&
              node.name.getText(source) === JSON.stringify(field) &&
              ts.isObjectLiteralExpression(node.initializer)
            ) {
              for (const property of node.initializer.properties)
                if (
                  ts.isPropertyAssignment(property) &&
                  ts.isStringLiteral(property.name) &&
                  property.name.text === specifier
                )
                  positions.push(property.name.getStart(source))
            }
            ts.forEachChild(node, visit)
          }
          visit(source)
          violations.push({
            frontend,
            file: pkg.file,
            line: source.getLineAndCharacterOfPosition(positions[0] ?? 0).line + 1,
            specifier,
            owner: resolvedOwner,
            kind: "manifest",
          })
        }
      }
    }
    const entries = await Array.fromAsync(
      new Bun.Glob("**/*.{ts,tsx,js,mjs,cjs}").scan({
        cwd: path.join(root, frontend),
        onlyFiles: true,
        throwErrorOnBrokenSymlink: false,
      }),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    const roots = entries.filter(
      (entry) =>
        !testOnly(entry) &&
        (frontend.startsWith("extensions/")
          ? !entry.includes("/") || entry.startsWith("view/") || entry.startsWith("src/")
          : entry.startsWith("src/")),
    )
    const visited = new Set<string>()
    async function visit(file: string): Promise<void> {
      if (visited.has(file)) return
      visited.add(file)
      const source = ts.createSourceFile(file, await Bun.file(file).text(), ts.ScriptTarget.Latest, true)
      const edges: { node: ts.Node; argument: ts.Node; dynamic: boolean }[] = []
      function scan(node: ts.Node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
          edges.push({ node, argument: node.moduleSpecifier, dynamic: false })
        if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference) &&
          node.moduleReference.expression
        )
          edges.push({ node, argument: node.moduleReference.expression, dynamic: false })
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
          edges.push({ node, argument: node.argument.literal, dynamic: false })
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
          node.arguments[0]
        )
          edges.push({ node, argument: node.arguments[0], dynamic: true })
        ts.forEachChild(node, scan)
      }
      scan(source)
      for (const edge of edges) {
        const line = source.getLineAndCharacterOfPosition(edge.argument.getStart(source)).line + 1
        if (!ts.isStringLiteralLike(edge.argument)) {
          const declaration = declarations.find(
            (entry) => entry.file === relative(file) && entry.function === enclosingFunction(edge.node),
          )
          if (
            edge.dynamic &&
            ts.isCallExpression(edge.node) &&
            edge.node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            declaration
          ) {
            matched.add(declaration)
            loaders.push(`${relative(file)}:${line} ${declaration.function}: ${declaration.reason}`)
            continue
          }
          violations.push({
            frontend,
            file: relative(file),
            line,
            specifier: edge.argument.getText(source),
            owner: "unresolved",
            kind: "nonliteral",
          })
          continue
        }
        const specifier = edge.argument.text
        for (const reader of readers)
          if (reader.file === relative(file) && /^(?:bun|node):sqlite$/.test(specifier)) matchedReaders.add(reader)
        const direct = forbidden(specifier)
        if (direct) {
          violations.push({ frontend, file: relative(file), line, specifier, owner: direct, kind: "source" })
          continue
        }
        const targets = resolve(specifier, file)
        for (const target of targets) {
          for (const reader of readers)
            if (reader.module === relative(file) && reader.file === relative(target)) readerOwners.add(reader)
          const resolvedOwner =
            owner(target)?.manifest.name ?? relative(target).replace(/^packages\/([^/]+)\/.*$/, "@ycoding-ai/$1")
          if (forbiddenOwners.has(resolvedOwner)) {
            violations.push({ frontend, file: relative(file), line, specifier, owner: resolvedOwner, kind: "source" })
            continue
          }
          if (/\.(?:[cm]?js|tsx?)$/.test(target)) await visit(target)
        }
        if (
          !targets.length &&
          (packages.some(
            (entry) => specifier === entry.manifest.name || specifier.startsWith(entry.manifest.name + "/"),
          ) ||
            specifier.startsWith("#"))
        )
          violations.push({
            frontend,
            file: relative(file),
            line,
            specifier,
            owner: "unresolved workspace module",
            kind: "resolution",
          })
      }
    }
    for (const entry of roots.sort()) await visit(path.join(root, frontend, entry))
  }
  for (const declaration of declarations) {
    const frontend = frontends.find((entry) => declaration.file.startsWith(entry + "/"))
    if (!matched.has(declaration))
      loaders.push(
        `${declaration.file}:1 ${declaration.function}: ${declaration.reason} (${frontend ? "stale" : "outside selected roots"})`,
      )
    if (!frontend || matched.has(declaration)) continue
    violations.push({
      frontend,
      file: declaration.file,
      line: 1,
      specifier: declaration.function,
      owner: "stale extension loader declaration",
      kind: "stale-loader",
    })
  }
  for (const reader of readers) {
    const frontend = frontends.find((entry) => reader.file.startsWith(entry + "/"))
    const valid = matchedReaders.has(reader) && readerOwners.has(reader)
    loaders.push(
      `${reader.file}:1 ${reader.module}: ${reader.reason} (${valid ? "declared SQLite reader" : frontend ? "stale SQLite reader" : "outside selected roots"})`,
    )
    if (frontend && !valid)
      violations.push({
        frontend,
        file: reader.file,
        line: 1,
        specifier: reader.module,
        owner: "stale SQLite reader declaration",
        kind: "stale-reader",
      })
  }
  return {
    violations: [...new Map(violations.map((entry) => [JSON.stringify(entry), entry])).values()].sort(
      (a, b) => a.frontend.localeCompare(b.frontend) || a.file.localeCompare(b.file) || a.line - b.line,
    ),
    loaders: [...new Set(loaders)].sort(),
  }
}

function testOnly(file: string) {
  return /(^|\/)(?:node_modules|dist|test|tests|test-integration|fixtures|__tests__|verify|script)(\/|$)|\.(?:test|spec)\.|(^|\/)build[-.]/.test(
    file,
  )
}

function exportTargets(value: unknown, key: string): string[] {
  if (typeof value === "string") return key === "." ? [value] : []
  if (Array.isArray(value)) return value.flatMap((entry: unknown) => exportTargets(entry, key))
  if (!value || typeof value !== "object") return []
  const entries = Object.entries(value)
  if (!entries.some(([name]) => name.startsWith(".") || name.startsWith("#")))
    return entries.flatMap(([, target]) => exportTargets(target, key))
  const exact = entries.find(([name]) => name === key)
  if (exact) return exportTargets(exact[1], ".")
  const wildcard = entries
    .filter(([name]) => name.includes("*"))
    .sort(([a], [b]) => b.length - a.length)
    .find(([name]) => key.startsWith(name.split("*")[0]) && key.endsWith(name.split("*")[1]))
  if (!wildcard) return []
  const [prefix, suffix] = wildcard[0].split("*")
  return exportTargets(wildcard[1], ".").map((target) =>
    target.replaceAll("*", key.slice(prefix.length, suffix ? -suffix.length : undefined)),
  )
}

function enclosingFunction(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node))
    return node.name?.getText()
  if (ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent)) return node.parent.name.getText()
  return node.parent ? enclosingFunction(node.parent) : undefined
}

export type BundleGraph = {
  frontend: string
  outputs: { file: string; modules: string[]; imports: string[]; edges?: { file: string; specifier: string }[] }[]
}

export function checkBundleGraph(
  graph: BundleGraph,
  readers = boundaryDeclarations.filter((entry): entry is SqliteReader => "module" in entry),
): Violation[] {
  if (!graph.outputs.length || !graph.outputs.some((output) => output.modules.length))
    throw new Error("Empty shipped graph")
  const modules = graph.outputs.flatMap((output) => output.modules)
  const declared = (file: string) =>
    readers.some(
      (reader) => file.endsWith("/" + reader.file) && modules.some((module) => module.endsWith("/" + reader.module)),
    )
  const violations = graph.outputs.flatMap((output) =>
    [...output.modules, ...output.imports].flatMap((specifier) => {
      const owner =
        [...forbiddenOwners].find(
          (name) =>
            specifier === name ||
            specifier.startsWith(name + "/") ||
            specifier.includes(`/packages/${name.slice("@ycoding-ai/".length)}/`) ||
            specifier.includes(`/node_modules/${name}/`),
        ) ??
        (/(^|[/@])(?:node-pty|node-pty-[^/]+)(?:\/|$)/.test(specifier) ? "node-pty" : undefined) ??
        (/(?:^|[/@:-])(?:sqlite(?:3)?|better-sqlite3|sql-sqlite-[^/]+|drizzle(?:-orm|-kit)?)(?:[/.:-]|$)/.test(
          specifier,
        )
          ? "sqlite"
          : undefined)
      if (owner === "sqlite" && declared(specifier)) return []
      if (owner === "sqlite" && /^(?:bun|node):sqlite$/.test(specifier)) {
        const edges = output.edges?.filter((edge) => edge.specifier === specifier) ?? []
        if (edges.length && edges.every((edge) => declared(edge.file))) return []
      }
      return owner ? [{ frontend: graph.frontend, file: output.file, line: 1, specifier, owner, kind: "bundle" }] : []
    }),
  )
  return [...new Map(violations.map((entry) => [JSON.stringify(entry), entry])).values()]
}

if (import.meta.main) {
  const root = path.resolve(
    process.argv.find((arg) => arg.startsWith("--root="))?.slice(7) ?? path.resolve(import.meta.dirname, ".."),
  )
  const unexpected = await checkWorkspace(root)
  const boundary = await checkFrontendBoundary(root, {
    frontends: process.argv.filter((arg) => arg.startsWith("--frontend=")).map((arg) => arg.slice(11)).length
      ? process.argv.filter((arg) => arg.startsWith("--frontend=")).map((arg) => arg.slice(11))
      : undefined,
  })
  for (const loader of boundary.loaders) console.log(`Declared boundary site: ${loader}`)
  for (const file of process.argv.filter((arg) => arg.startsWith("--bundle-graph=")).map((arg) => arg.slice(15))) {
    const graph = (await Bun.file(file).json()) as BundleGraph
    boundary.violations.push(...checkBundleGraph(graph))
  }
  if (unexpected.length) {
    console.error("Unexpected workspace packages:")
    for (const name of unexpected) console.error(`- ${name}`)
  }
  for (const entry of boundary.violations)
    console.error(
      `[${entry.frontend}] ${entry.file}:${entry.line} ${JSON.stringify(entry.specifier)} -> ${entry.owner} (${entry.kind})`,
    )
  if (unexpected.length || boundary.violations.length) process.exit(1)
  console.log(`YCoding workspace boundary passed: ${approvedPackageNames.size} packages`)
}
