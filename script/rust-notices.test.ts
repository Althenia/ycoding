import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildNotice,
  detectLicenses,
  expressionSatisfied,
  generate,
  parseTree,
  prefixOf,
  shippedPackages,
  spliceNotice,
  treeArguments,
  type Data,
  type Input,
  type Package,
} from "./rust-notices"

const root = path.resolve(import.meta.dirname, "..")
const scratch = await mkdtemp(path.join(os.tmpdir(), "rust-notices-"))
afterAll(() => rm(scratch, { recursive: true, force: true }))

const mit = (holder: string) =>
  `MIT License\n\nCopyright (c) ${holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software, to deal in the Software without restriction.\n\nThe above copyright notice and this permission notice shall be included in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS".\n`
const apache = "Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/\n\nTERMS AND CONDITIONS\n"
const sqliteSource = [
  "/*",
  "** The author disclaims copyright to this source code.  In place of",
  "** a legal notice, here is a blessing:",
  "**",
  "**    May you do good and not evil.",
  "**    May you find forgiveness for yourself and forgive others.",
  "**    May you share freely, never taking more than you give.",
  "*/",
  "int x;",
].join("\n")

type Spec = {
  name: string
  version?: string
  license?: string | null
  files?: Record<string, string>
  source?: string | null
  targets?: string[]
}

let counter = 0
const triples = ["aarch64-apple-darwin", "x86_64-pc-windows-msvc"] as const

async function build(specs: Spec[], patch: (data: Data) => void = () => {}, options: { current?: string; workspace?: boolean } = {}) {
  const base = path.join(scratch, `case-${counter++}`)
  const dataDirectory = path.join(base, "data")
  await mkdir(path.join(dataDirectory, "texts"), { recursive: true })
  const all: Spec[] = [
    { name: "libduckdb-sys", version: "1.0.0", license: "MIT", files: { LICENSE: mit("DuckDB") } },
    { name: "libsqlite3-sys", version: "2.0.0", license: "MIT", files: { LICENSE: mit("rusqlite"), "sqlite3/sqlite3.c": sqliteSource } },
    ...specs,
  ]
  const packages: Package[] = []
  for (const spec of all) {
    const directory = path.join(base, "registry", `${spec.name}-${spec.version ?? "1.0.0"}`)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, "Cargo.toml"), "")
    for (const [file, text] of Object.entries(spec.files ?? {})) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await writeFile(path.join(directory, file), text)
    }
    packages.push({
      id: `${spec.name} ${spec.version ?? "1.0.0"}`,
      name: spec.name,
      version: spec.version ?? "1.0.0",
      source: spec.source === undefined ? "registry+https://github.com/rust-lang/crates.io-index" : spec.source,
      license: spec.license === undefined ? "MIT" : spec.license,
      manifest_path: path.join(directory, "Cargo.toml"),
      authors: [],
      repository: null,
    })
  }
  const duck = path.join(base, "registry", "libduckdb-sys-1.0.0")
  await mkdir(path.join(duck, "src/duckdb/third_party/fmt"), { recursive: true })
  await writeFile(path.join(duck, "src/duckdb/third_party/fmt/a.h"), "")
  const archive = Bun.spawnSync(["tar", "-czf", path.join(duck, "duckdb.tar.gz"), "-C", path.join(duck, "src"), "duckdb"])
  expect(archive.exitCode).toBe(0)
  const fmt = "fmt license text\n"
  await writeFile(path.join(dataDirectory, "texts/fmt.txt"), fmt)
  const workspace: Package = {
    id: "workspace",
    name: "ycoding-runtime",
    version: "0.1.0",
    source: null,
    license: "AGPL-3.0-only",
    manifest_path: path.join(base, "ws/Cargo.toml"),
    authors: [],
    repository: null,
  }
  const data: Data = {
    package: "ycoding-runtime",
    targets: triples.map((triple) => ({ artifact: triple, triple })),
    nested: [],
    supplements: [],
    elections: [],
    corrections: [],
    headers: [],
    native: {
      duckdb: {
        crate: "libduckdb-sys",
        version: "1.0.0",
        archive: "duckdb.tar.gz",
        source: "https://example.test/duckdb",
        revision: "0123456789abcdef",
        licenses: [
          {
            directory: "fmt",
            path: "third_party/fmt/LICENSE",
            url: "https://example.test/fmt",
            file: "texts/fmt.txt",
            sha256: createHash("sha256").update(fmt).digest("hex"),
          },
        ],
      },
      sqlite: { crate: "libsqlite3-sys", version: "2.0.0", file: "sqlite3/sqlite3.c" },
    },
    embedded: [],
    models: { component: "model catalog", url: "https://example.test/models", file: "texts/models.txt", sha256: "" },
  }
  const models = "model catalog license\n"
  await writeFile(path.join(dataDirectory, "texts/models.txt"), models)
  data.models.sha256 = createHash("sha256").update(models).digest("hex")
  patch(data)
  const shipped = (triple: string) =>
    ["libduckdb-sys 1.0.0", "libsqlite3-sys 2.0.0", ...specs.filter((spec) => spec.targets === undefined || spec.targets.includes(triple)).map((spec) => `${spec.name} ${spec.version ?? "1.0.0"}`)]
  const trees = Object.fromEntries(
    triples.map((triple) => [
      triple,
      ["0ycoding-runtime v0.1.0 (/ws)", ...shipped(triple).map((entry) => `1${entry.replace(" ", " v")}`)].join("\n") + "\n",
    ]),
  )
  const input: Input = {
    root: base,
    dataDirectory,
    data,
    packages: [workspace, ...packages],
    workspaceMembers: ["workspace"],
    trees,
  }
  return { input, base, current: options.current ?? "Upstream notice.\n" }
}

describe("closure", () => {
  test("keeps normal dependencies and prunes subtrees below procedural macros", () => {
    const output = [
      "0ycoding-runtime v0.1.0 (/ws)",
      "1serde v1.0.0",
      "2serde_derive v1.0.0 (proc-macro)",
      "3syn v2.0.0",
      "3quote v1.0.0",
      "1tokio v1.0.0 (*)",
      "2syn v2.0.0",
    ].join("\n")
    const names = parseTree(output).map((entry) => entry.name)
    expect(names).toEqual(["ycoding-runtime", "serde", "tokio", "syn"])
    expect(names).not.toContain("serde_derive")
    expect(names).not.toContain("quote")
  })

  test("asks cargo for locked offline normal edges of the runtime per target without deduplication", () => {
    const args = treeArguments({ package: "ycoding-runtime" } as Data, "x86_64-unknown-linux-gnu")
    expect(args).toEqual(expect.arrayContaining(["--offline", "--locked", "-p", "ycoding-runtime", "--no-dedupe"]))
    expect(args.join(" ")).toContain("-e normal")
    expect(args.join(" ")).toContain("--target x86_64-unknown-linux-gnu")
  })

  test("includes a crate shipped on any target, excludes packages absent from every tree, and drops workspace members", async () => {
    const { input } = await build([
      { name: "everywhere", files: { LICENSE: mit("A") } },
      { name: "windows-only", targets: ["x86_64-pc-windows-msvc"], files: { LICENSE: mit("B") } },
    ])
    input.packages.push({
      id: "dev-only",
      name: "dev-only",
      version: "1.0.0",
      source: "registry+https://github.com/rust-lang/crates.io-index",
      license: "MIT",
      manifest_path: path.join(scratch, "dev-only", "Cargo.toml"),
      authors: [],
      repository: null,
    })
    const names = shippedPackages(input).map((item) => item.name)
    expect(names).toContain("everywhere")
    expect(names).toContain("windows-only")
    expect(names).not.toContain("dev-only")
    expect(names).not.toContain("ycoding-runtime")
  })

  test("fails closed for unknown packages, foreign sources, outside path dependencies, and missing trees", async () => {
    const unknown = await build([{ name: "a", files: { LICENSE: mit("A") } }])
    const tree = unknown.input.trees[triples[0]]
    if (tree === undefined) throw new Error("fixture has no tree")
    unknown.input.trees[triples[0]] = `${tree}1ghost v9.9.9\n`
    expect(() => shippedPackages(unknown.input)).toThrow(/ghost 9\.9\.9/)
    const git = await build([{ name: "a", source: "git+https://example.test/a#abc", files: { LICENSE: mit("A") } }])
    expect(() => shippedPackages(git.input)).toThrow(/unsupported source/)
    const path_ = await build([{ name: "a", source: null, files: { LICENSE: mit("A") } }])
    expect(() => shippedPackages(path_.input)).toThrow(/outside the workspace/)
    const missing = await build([])
    delete missing.input.trees[triples[1]]
    expect(() => shippedPackages(missing.input)).toThrow(/missing cargo tree/)
  })
})

describe("license evidence", () => {
  test("lists crates sharing identical text under one body and keeps differing copyright holders apart", async () => {
    const { input, current } = await build([
      { name: "a", files: { LICENSE: mit("Same") } },
      { name: "b", files: { "LICENSE-MIT": mit("Same").replace(/\n/g, "\r\n") } },
      { name: "c", files: { LICENSE: mit("Other") } },
    ])
    const notice = await buildNotice(current, input)
    expect(notice.split("Copyright (c) Same").length - 1).toBe(1)
    expect(notice.split("Copyright (c) Other").length - 1).toBe(1)
    expect(notice).not.toContain("Source:\n\n")
    const group = notice.slice(notice.indexOf("  a 1.0.0 (LICENSE)"))
    expect(group.slice(0, group.indexOf("Copyright"))).toContain("  b 1.0.0 (LICENSE-MIT)")
  })

  test("produces identical bytes for repeated runs and any input ordering", async () => {
    const specs: Spec[] = [
      { name: "a", files: { LICENSE: mit("A") } },
      { name: "b", files: { LICENSE: mit("B"), "LICENSE-APACHE": apache }, license: "MIT OR Apache-2.0" },
      { name: "c", files: { LICENSE: mit("C") } },
    ]
    const first = await build(specs)
    const second = await build([...specs].reverse())
    second.input.packages.reverse()
    const one = await buildNotice(first.current, first.input)
    expect(await buildNotice(first.current, first.input)).toBe(one)
    expect((await buildNotice(second.current, second.input)).replaceAll(second.base, first.base)).toBe(one)
  })

  test("rejects a crate with no license text", async () => {
    const { input, current } = await build([{ name: "bare", files: { "README.md": "readme" } }])
    await expect(buildNotice(current, input)).rejects.toThrow(/bare 1\.0\.0 has no license text/)
  })

  test("rejects a declared license that its texts do not evidence", async () => {
    const { input, current } = await build([{ name: "mismatch", license: "Apache-2.0", files: { LICENSE: mit("A") } }])
    await expect(buildNotice(current, input)).rejects.toThrow(/mismatch 1\.0\.0 declares Apache-2\.0/)
  })

  test("evaluates license expressions with OR, AND, slash alternatives, and exceptions", () => {
    const only = new Set(["MIT"])
    expect(expressionSatisfied("MIT OR Apache-2.0", only)).toBe(true)
    expect(expressionSatisfied("MIT/Apache-2.0", only)).toBe(true)
    expect(expressionSatisfied("MIT AND Apache-2.0", only)).toBe(false)
    expect(expressionSatisfied("(MIT OR Apache-2.0) AND Unicode-3.0", new Set(["MIT", "Unicode-3.0"]))).toBe(true)
    expect(expressionSatisfied("Apache-2.0 WITH LLVM-exception OR MIT", only)).toBe(true)
    expect(() => expressionSatisfied("Made-Up-1.0", only)).toThrow(/no text signature/)
    expect(() => expressionSatisfied("MIT AND", only)).toThrow(/malformed/)
  })

  test("evidences a WITH exception only when its text and base license are both present", () => {
    const base = new Set(["Apache-2.0"])
    const withException = new Set(["Apache-2.0", "Apache-2.0 WITH LLVM-exception"])
    expect(expressionSatisfied("Apache-2.0 WITH LLVM-exception", base)).toBe(false)
    expect(expressionSatisfied("Apache-2.0 WITH LLVM-exception", withException)).toBe(true)
    expect(expressionSatisfied("Apache-2.0 WITH LLVM-exception OR MIT", base)).toBe(false)
    expect(detectLicenses(`${apache}\n--- LLVM Exceptions to the Apache 2.0 License ----\nAs an exception, if you embed`)).toContain(
      "Apache-2.0 WITH LLVM-exception",
    )
    expect(detectLicenses(apache)).not.toContain("Apache-2.0 WITH LLVM-exception")
  })

  test("rejects exceptions it cannot verify even when another alternative is satisfied", () => {
    const only = new Set(["MIT"])
    expect(() => expressionSatisfied("MIT OR Apache-2.0 WITH Classpath-exception-2.0", only)).toThrow(/unsupported license exception/)
    expect(() => expressionSatisfied("MIT WITH LLVM-exception", only)).toThrow(/unsupported license exception/)
    expect(() => expressionSatisfied("Apache-2.0 WITH", only)).toThrow(/malformed/)
  })

  test("recognises license text wrapped in source comment markers", () => {
    const text =
      '// Permission to use, copy, modify, and/or distribute this software for any\n// purpose with or without fee is hereby granted, provided that the above\n// copyright notice and this permission notice appear in all copies.\n'
    expect(detectLicenses(text)).toContain("ISC")
  })

  test("reads files inside a LICENSES directory", async () => {
    const { input, current } = await build([{ name: "reuse", files: { "LICENSES/MIT.txt": mit("Reuse") } }])
    expect(await buildNotice(current, input)).toContain("reuse 1.0.0 (LICENSES/MIT.txt)")
  })
})

describe("supplements", () => {
  const supplementFor = async (base: string, text: string, crates: string[], extra: Partial<Data["supplements"][number]> = {}) => {
    await writeFile(path.join(base, "data/texts/s.txt"), text)
    return {
      source: "https://example.test/repo",
      revision: "0123456789abcdef0123",
      path: "LICENSE",
      url: "https://example.test/repo/LICENSE",
      file: "texts/s.txt",
      sha256: createHash("sha256").update(text).digest("hex"),
      crates,
      ...extra,
    }
  }

  test("supplies verified upstream text for a crate whose package ships none", async () => {
    const { input, base, current } = await build([{ name: "bare", files: {} }])
    input.data.supplements.push(await supplementFor(base, mit("Upstream"), ["bare 1.0.0"]))
    const notice = await buildNotice(current, input)
    expect(notice).toContain("Copyright (c) Upstream")
    expect(notice).toContain("https://example.test/repo/LICENSE")
  })

  test("rejects a supplement whose file digest differs from the recorded digest", async () => {
    const { input, base, current } = await build([{ name: "bare", files: {} }])
    input.data.supplements.push(await supplementFor(base, mit("Upstream"), ["bare 1.0.0"], { sha256: "0".repeat(64) }))
    await expect(buildNotice(current, input)).rejects.toThrow(/digest/)
  })

  test("rejects a supplement for a crate that already ships its text", async () => {
    const { input, base, current } = await build([{ name: "full", files: { LICENSE: mit("A") } }])
    input.data.supplements.push(await supplementFor(base, mit("Upstream"), ["full 1.0.0"]))
    await expect(buildNotice(current, input)).rejects.toThrow(/stale supplement/)
  })

  test("rejects two supplements for the same crate and path", async () => {
    const { input, base, current } = await build([{ name: "bare", files: {} }])
    const entry = await supplementFor(base, mit("Upstream"), ["bare 1.0.0"])
    input.data.supplements.push(entry, { ...entry, revision: "ffffffffffffffffffff" })
    await expect(buildNotice(current, input)).rejects.toThrow(/conflicting supplements/)
  })

  test("rejects a supplement naming a crate outside the shipped closure", async () => {
    const { input, base, current } = await build([{ name: "a", files: { LICENSE: mit("A") } }])
    input.data.supplements.push(await supplementFor(base, mit("Upstream"), ["ghost 1.0.0"]))
    await expect(buildNotice(current, input)).rejects.toThrow(/not in the shipped closure/)
  })
})

describe("nested license files", () => {
  const rule = (action: "include" | "exclude", file: string, crate = "vendor") => ({ crate, path: file, action, reason: "test" })

  test("includes classified vendored licenses and omits excluded ones", async () => {
    const { input, current } = await build(
      [{ name: "vendor", files: { LICENSE: mit("Top"), "third_party/x/LICENSE": mit("Vendored"), "tests/y/LICENSE": mit("Fixture") } }],
      (data) => data.nested.push(rule("include", "third_party/x/LICENSE"), rule("exclude", "tests/y/LICENSE")),
    )
    const notice = await buildNotice(current, input)
    expect(notice).toContain("Copyright (c) Vendored")
    expect(notice).not.toContain("Copyright (c) Fixture")
  })

  test("rejects an unclassified nested license file", async () => {
    const { input, current } = await build([{ name: "vendor", files: { LICENSE: mit("Top"), "deps/z/COPYING": mit("New") } }])
    await expect(buildNotice(current, input)).rejects.toThrow(/unclassified license file deps\/z\/COPYING/)
  })

  test("ignores hidden directories", async () => {
    const { input, current } = await build([{ name: "vendor", files: { LICENSE: mit("Top"), ".github/copyright.yml": "x" } }])
    await expect(buildNotice(current, input)).resolves.toContain("vendor 1.0.0")
  })

  test("rejects rules whose file or crate no longer exists", async () => {
    const stale = await build([{ name: "vendor", files: { LICENSE: mit("Top") } }], (data) => data.nested.push(rule("include", "gone/LICENSE")))
    await expect(buildNotice(stale.current, stale.input)).rejects.toThrow(/does not exist/)
    const orphan = await build([{ name: "vendor", files: { LICENSE: mit("Top") } }], (data) => data.nested.push(rule("exclude", "a/LICENSE", "ghost")))
    await expect(buildNotice(orphan.current, orphan.input)).rejects.toThrow(/ghost, which is not in the shipped closure/)
  })
})

describe("bundled native and embedded code", () => {
  test("reproduces DuckDB third-party licenses and the SQLite dedication", async () => {
    const { input, current } = await build([])
    const notice = await buildNotice(current, input)
    expect(notice).toContain("fmt license text")
    expect(notice).toContain("DuckDB third_party/fmt/LICENSE")
    expect(notice).toContain("May you share freely, never taking more than you give.")
    expect(notice).not.toContain("**")
  })

  test("rejects a DuckDB archive directory without license evidence and stale evidence", async () => {
    const extra = await build([], (data) => (data.native.duckdb.licenses = []))
    await expect(buildNotice(extra.current, extra.input)).rejects.toThrow(/unlicensed: fmt/)
    const stale = await build([], (data) => {
      const first = data.native.duckdb.licenses[0]
      if (!first) throw new Error("fixture has no DuckDB license entry")
      data.native.duckdb.licenses.push({ ...first, directory: "gone" })
    })
    await expect(buildNotice(stale.current, stale.input)).rejects.toThrow(/stale: gone/)
  })

  test("rejects native evidence pinned to another version or lacking the SQLite dedication", async () => {
    const pinned = await build([], (data) => (data.native.duckdb.version = "9.9.9"))
    await expect(buildNotice(pinned.current, pinned.input)).rejects.toThrow(/DuckDB native evidence pins/)
    const plain = await build([])
    const sqlite = plain.input.packages.find((item) => item.name === "libsqlite3-sys")!
    await writeFile(path.join(path.dirname(sqlite.manifest_path), "sqlite3/sqlite3.c"), "int x;\n")
    await expect(buildNotice(plain.current, plain.input)).rejects.toThrow(/public-domain dedication/)
  })

  test("includes repository-owned license files for ported code and rejects a missing one", async () => {
    const { input, base, current } = await build([], (data) => data.embedded.push({ component: "ported matcher", path: "src/MATCHER-LICENSE.txt" }))
    await mkdir(path.join(base, "src"), { recursive: true })
    await writeFile(path.join(base, "src/MATCHER-LICENSE.txt"), mit("Matcher"))
    expect(await buildNotice(current, input)).toContain("ported matcher (src/MATCHER-LICENSE.txt)")
    await rm(path.join(base, "src/MATCHER-LICENSE.txt"))
    await expect(buildNotice(current, input)).rejects.toThrow()
  })

  test("refers to a notice already reproduced in the preserved prefix instead of repeating it", async () => {
    const prefixText = `Upstream notice.\n\n${mit("Already").trimEnd()}\n`
    const { input, current, base } = await build([], (data) => data.embedded.push({ component: "cursor client", path: "src/LICENSE" }), { current: prefixText })
    await mkdir(path.join(base, "src"), { recursive: true })
    await writeFile(path.join(base, "src/LICENSE"), mit("Already"))
    const notice = await buildNotice(current, input)
    expect(notice.split("Copyright (c) Already").length - 1).toBe(1)
    expect(notice).toContain("reproduced in full earlier in this file")
  })

  test("rejects model catalog evidence whose digest differs", async () => {
    const { input, current } = await build([], (data) => (data.models.sha256 = "1".repeat(64)))
    await expect(buildNotice(current, input)).rejects.toThrow(/digest/)
  })
})

describe("approved elections, corrections, and source headers", () => {
  const canonical = "https://www.apache.org/licenses/LICENSE-2.0.txt"
  const electionFor = async (base: string, overrides: Partial<Data["elections"][number]> = {}) => {
    await writeFile(path.join(base, "data/texts/apache.txt"), apache)
    return {
      crate: "bare",
      version: "1.0.0",
      license: "Apache-2.0",
      file: "texts/apache.txt",
      sha256: createHash("sha256").update(apache).digest("hex"),
      source: canonical,
      statement: { file: "README.md", text: "dual-licensed under Apache and MIT" },
      evidence: ["https://example.test/issues/11"],
      caveats: ["Later upstream copyright lines are not applied."],
      ...overrides,
    }
  }
  const bare = { name: "bare", license: "MIT OR Apache-2.0", files: { "README.md": "It is dual-licensed under Apache and MIT." } }

  test("reproduces the canonical text of an approved election for a crate that ships none and lists its evidence", async () => {
    const { input, base, current } = await build([bare])
    input.data.elections.push(await electionFor(base))
    const notice = await buildNotice(current, input)
    expect(notice).toContain("bare 1.0.0 (Apache-2.0 election; README.md)")
    expect(notice).toContain("TERMS AND CONDITIONS")
    expect(notice).toContain("Approved license determinations")
    expect(notice).toContain("https://example.test/issues/11")
    expect(notice).toContain("  Caveat: Later upstream copyright lines are not applied.")
    expect(notice).toContain(canonical)
  })

  test("rejects an election whose statement is absent from the package", async () => {
    const { input, base, current } = await build([{ ...bare, files: { "README.md": "unrelated" } }])
    input.data.elections.push(await electionFor(base))
    await expect(buildNotice(current, input)).rejects.toThrow(/statement .* is not present in README\.md/)
  })

  test("rejects an election of a license the package does not offer", async () => {
    const { input, base, current } = await build([{ ...bare, license: "MIT" }])
    input.data.elections.push(await electionFor(base))
    await expect(buildNotice(current, input)).rejects.toThrow(/does not offer Apache-2\.0/)
  })

  test("rejects an election once the package ships its own license text", async () => {
    const { input, base, current } = await build([{ ...bare, files: { ...bare.files, LICENSE: apache } }])
    input.data.elections.push(await electionFor(base))
    await expect(buildNotice(current, input)).rejects.toThrow(/stale election/)
  })

  test("rejects an election with a wrong digest, an unshipped crate, or a different version", async () => {
    const wrong = await build([bare])
    wrong.input.data.elections.push(await electionFor(wrong.base, { sha256: "2".repeat(64) }))
    await expect(buildNotice(wrong.current, wrong.input)).rejects.toThrow(/digest/)
    const ghost = await build([bare])
    ghost.input.data.elections.push(await electionFor(ghost.base, { crate: "ghost" }))
    await expect(buildNotice(ghost.current, ghost.input)).rejects.toThrow(/ghost 1\.0\.0, which is not in the shipped closure/)
    const version = await build([bare])
    version.input.data.elections.push(await electionFor(version.base, { version: "2.0.0" }))
    await expect(buildNotice(version.current, version.input)).rejects.toThrow(/not in the shipped closure/)
  })

  const correction = { crate: "mislabeled", version: "1.0.0", declared: "BSD-3-Clause", effective: "Apache-2.0", evidence: ["https://example.test/commit/abc"] }

  test("verifies a pinned metadata correction against the shipped text and lists it", async () => {
    const spec = { name: "mislabeled", license: "BSD-3-Clause", files: { LICENSE: apache } }
    const rejected = await build([spec])
    await expect(buildNotice(rejected.current, rejected.input)).rejects.toThrow(/declares BSD-3-Clause/)
    const { input, current } = await build([spec], (data) => data.corrections.push(correction))
    const notice = await buildNotice(current, input)
    expect(notice).toContain("mislabeled 1.0.0")
    expect(notice).toContain("declares BSD-3-Clause; evidenced license Apache-2.0")
    expect(notice).toContain("https://example.test/commit/abc")
  })

  test("rejects a correction whose declared metadata changed or whose crate is not shipped", async () => {
    const changed = await build([{ name: "mislabeled", license: "MIT", files: { LICENSE: apache } }], (data) => data.corrections.push(correction))
    await expect(buildNotice(changed.current, changed.input)).rejects.toThrow(/stale correction/)
    const ghost = await build([], (data) => data.corrections.push(correction))
    await expect(buildNotice(ghost.current, ghost.input)).rejects.toThrow(/mislabeled 1\.0\.0, which is not in the shipped closure/)
  })

  const header = { crate: "vendor", version: "1.0.0", component: "vendored btree", file: "lmdb/mdb.c", start: "This code is derived from btree.c", end: "PERFORMANCE OF THIS SOFTWARE." }
  const source = [
    "/* mdb.c",
    " *",
    " * This code is derived from btree.c written by Martin Hedenfalk.",
    " *",
    " * Copyright (c) 2009 Martin Hedenfalk",
    " *",
    " * Permission to use, copy, modify, and distribute this software for any",
    " * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.",
    " */",
    "int main;",
  ].join("\n")

  test("reproduces a pinned source-header notice without comment markers", async () => {
    const { input, current } = await build([{ name: "vendor", files: { LICENSE: mit("Top"), "lmdb/mdb.c": source } }], (data) => {
      data.headers.push(header)
    })
    const notice = await buildNotice(current, input)
    expect(notice).toContain("vendor 1.0.0 (lmdb/mdb.c header: vendored btree)")
    expect(notice).toContain("Copyright (c) 2009 Martin Hedenfalk")
    expect(notice).not.toContain(" * Copyright")
    expect(notice).not.toContain("int main;")
  })

  test("rejects a source header whose markers are missing or whose crate is not shipped", async () => {
    const missing = await build([{ name: "vendor", files: { LICENSE: mit("Top"), "lmdb/mdb.c": "int main;" } }], (data) => data.headers.push(header))
    await expect(buildNotice(missing.current, missing.input)).rejects.toThrow(/lmdb\/mdb\.c does not contain/)
    const ghost = await build([], (data) => data.headers.push(header))
    await expect(buildNotice(ghost.current, ghost.input)).rejects.toThrow(/vendor 1\.0\.0, which is not in the shipped closure/)
  })
})

describe("data validation and preamble", () => {
  const rule = { crate: "vendor", path: "a/LICENSE", action: "include" as const, reason: "compiled in" }

  test("rejects nested rules with an unknown action or an empty reason", async () => {
    const action = await build([], (data) => data.nested.push({ ...rule, action: "ignore" as never }))
    await expect(buildNotice(action.current, action.input)).rejects.toThrow(/nested rule vendor a\/LICENSE has invalid action ignore/)
    const reason = await build([], (data) => data.nested.push({ ...rule, reason: "  " }))
    await expect(buildNotice(reason.current, reason.input)).rejects.toThrow(/nested rule vendor a\/LICENSE needs a reason/)
  })

  test("rejects duplicate nested rules, elections, corrections, and headers", async () => {
    const nested = await build([], (data) => data.nested.push(rule, { ...rule, action: "exclude" }))
    await expect(buildNotice(nested.current, nested.input)).rejects.toThrow(/duplicate nested rule for vendor a\/LICENSE/)
    const election = await build([], async (data) => {
      const entry = { crate: "c", version: "1.0.0", license: "Apache-2.0", file: "f", sha256: "", source: "s", statement: { file: "f", text: "t" }, evidence: [], caveats: [] }
      data.elections.push(entry, entry)
    })
    await expect(buildNotice(election.current, election.input)).rejects.toThrow(/duplicate election for c 1\.0\.0/)
    const correction = await build([], (data) => {
      const entry = { crate: "c", version: "1.0.0", declared: "MIT", effective: "Apache-2.0", evidence: [] }
      data.corrections.push(entry, entry)
    })
    await expect(buildNotice(correction.current, correction.input)).rejects.toThrow(/duplicate correction for c 1\.0\.0/)
    const header = await build([], (data) => {
      const entry = { crate: "c", version: "1.0.0", component: "x", file: "a.c", start: "s", end: "e" }
      data.headers.push(entry, entry)
    })
    await expect(buildNotice(header.current, header.input)).rejects.toThrow(/duplicate header for c 1\.0\.0 a\.c/)
  })

  test("describes how texts are sourced and normalized instead of claiming verbatim reproduction", async () => {
    const { input, current } = await build([])
    const notice = await buildNotice(current, input)
    for (const phrase of ["published package files", "pinned upstream revisions", "owner-approved", "comment markers", "line endings"])
      expect(notice).toContain(phrase)
    expect(notice).not.toContain("verbatim")
  })
})

describe("NOTICE splicing", () => {
  const section = (body: string) => `${"=".repeat(80)}\nBEGIN GENERATED RUST THIRD-PARTY NOTICES (script/rust-notices.ts)\n${"=".repeat(80)}\n${body}\nEND GENERATED RUST THIRD-PARTY NOTICES\n${"=".repeat(80)}\n`

  test("appends after the untouched prefix and is idempotent", () => {
    const prefix = "Upstream MIT notice.\nNo trailing newline"
    const once = spliceNotice(prefix, section("one"))
    expect(once.startsWith(prefix)).toBe(true)
    expect(prefixOf(once)).toBe(`${prefix}\n\n`)
    expect(spliceNotice(once, section("one"))).toBe(once)
  })

  test("replaces only the generated section and keeps text after it", () => {
    const current = `head\n\n${section("old")}tail\n`
    const next = spliceNotice(current, section("new"))
    expect(next).toBe(`head\n\n${section("new")}tail\n`)
  })

  test("rejects unmatched or repeated markers", () => {
    const whole = section("x")
    expect(() => spliceNotice(whole.slice(0, whole.indexOf("END GENERATED")), whole)).toThrow(/exactly one/)
    expect(() => spliceNotice(whole + whole, whole)).toThrow(/exactly one/)
  })
})

describe("repository data", () => {
  const data: Data = JSON.parse(readFileSync(path.join(root, "script/rust-notices/sources.json"), "utf8"))

  test("covers the native release targets", async () => {
    const workflow = await readFile(path.join(root, ".github/workflows/release.yml"), "utf8")
    const matrix = [...workflow.matchAll(/^\s+- target: (\S+)$/gm)].flatMap((match) => match[1] ?? []).sort()
    expect(data.targets.map((target) => target.artifact).sort()).toEqual(matrix)
  })

  test("records a matching digest for every committed license text", async () => {
    const entries = [
      ...data.supplements,
      ...data.native.duckdb.licenses,
      data.models,
    ]
    for (const entry of entries) {
      const bytes = await readFile(path.join(root, "script/rust-notices", entry.file))
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256)
    }
  })


  test("pins each approved determination by crate and version with canonical Apache evidence", async () => {
    expect(data.elections.map((entry) => `${entry.crate} ${entry.version}`).sort()).toEqual([
      "glidesort 0.1.2",
      "lmdb-master-sys 0.2.6",
      "objc2-core-foundation 0.3.2",
      "objc2-core-services 0.3.2",
    ])
    expect(data.corrections.map((entry) => `${entry.crate} ${entry.version} ${entry.declared} ${entry.effective}`)).toEqual([
      "nalgebra 0.30.1 BSD-3-Clause Apache-2.0",
    ])
    for (const entry of data.elections) {
      expect(entry.license).toBe("Apache-2.0")
      expect(entry.sha256).toBe("cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30")
      expect(entry.source).toBe("https://www.apache.org/licenses/LICENSE-2.0.txt")
    }
    expect(data.headers.map((entry) => `${entry.crate} ${entry.file}`)).toEqual([
      "lmdb-master-sys lmdb/libraries/liblmdb/lmdb.h",
      "lmdb-master-sys lmdb/libraries/liblmdb/mdb.c",
      "lmdb-master-sys lmdb/libraries/liblmdb/midl.c",
      "lmdb-master-sys lmdb/libraries/liblmdb/midl.h",
    ])
    for (const entry of data.elections.filter((item) => item.crate.startsWith("objc2-"))) {
      const caveats = entry.caveats.join(" ")
      expect(caveats).toContain("Copyright 2026 Mads Marquart")
      expect(caveats).toContain("Xcode")
    }
  })

  test("keeps the objc2 evidence files and their canonical Apache terms", async () => {
    const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
    const directory = path.join(root, "script/rust-notices/texts/evidence")
    const license = await readFile(path.join(directory, "objc2-LICENSE.md"))
    expect(sha(license)).toBe("7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54")
    const terms = (await readFile(path.join(directory, "objc2-LICENSE-APACHE.txt"), "utf8")).split("\n").slice(0, 176)
    const canonical = (await readFile(path.join(root, "script/rust-notices/texts/apache-2.0.txt"), "utf8")).split("\n").slice(0, 176)
    expect(terms).toEqual(canonical)
  })

  test("names an existing repository license file for every ported component", async () => {
    for (const entry of data.embedded) expect(await Bun.file(path.join(root, entry.path)).exists()).toBe(true)
  })
})

describe("repository NOTICE", () => {
  test("keeps the upstream and non-Rust notices before the generated section", async () => {
    const prefix = prefixOf(await readFile(path.join(root, "NOTICE"), "utf8"))
    for (const required of [
      "Copyright (c) 2025 opencode",
      "Copyright (c) 2026 Oleksiy Akimov",
      "The Geist Project Authors",
      "Copyright 2021-2026 Stichting DuckDB Foundation",
    ])
      expect(prefix).toContain(required)
  })

  test("matches the notice generated from the locked Rust closure", async () => {
    expect(await generate(root, "check")).toBe(true)
    const notice = await readFile(path.join(root, "NOTICE"), "utf8")
    for (const included of [
      "DuckDB third_party/fmt/LICENSE",
      "The author disclaims copyright to this source code",
      "JSONC scanner derived from node-jsonc-parser",
      "fuzzysort ranking port",
      "mime-db extension table",
      "minimatch glob port",
      "models.dev model catalog snapshot",
      "libgit2-sys 0.18.8+1.9.7 (libgit2/COPYING)",
      "aws-lc-sys 0.45.0 (aws-lc/LICENSE)",
      "lmdb-master-sys 0.2.6 (lmdb/libraries/liblmdb/LICENSE)",
    ])
      expect(notice).toContain(included)
    for (const excluded of ["serde_derive 1", "bindgen 0", "syn 2", "quinn 0", "libz-sys 1.1.29 (src/zlib-ng"])
      expect(notice).not.toContain(`  ${excluded}`)
  })
})
