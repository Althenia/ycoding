import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const fuzzysortRoot = process.argv[2]
if (!fuzzysortRoot || require(`${fuzzysortRoot}/package.json`).version !== "3.1.0")
  throw new Error("Supply the installed fuzzysort 3.1.0 package directory")
const fuzzysort = require(fuzzysortRoot)

const sources = ["packages/core/src/filesystem.ts", "packages/core/src/filesystem/search.ts"]
const listing = execFileSync("git", ["show", `main:${sources[0]}`], { encoding: "utf8" })
const search = execFileSync("git", ["show", `main:${sources[1]}`], { encoding: "utf8" })
if (!search.includes("input.query.trim()")) throw new Error("Committed search trim changed")
const comparator = listing.match(/\.sort\(\(a, b\) => (.*)\),/)?.[1]
if (!comparator?.includes("localeCompare")) throw new Error("Committed listing sort changed")
const compare = new Function("a", "b", `return ${comparator}`)
const names = [
  "Zebra",
  "äther",
  "eclair",
  "Éclair-accent",
  "apple",
  "Apple-tree",
  "_",
  "-",
  "!",
  "1",
  "10",
  "2",
  "ö",
  "Ω",
  "中",
  "😀",
]
const strings = [...names, "a", "A", "ö"]
const whitespace = [
  0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0x85, 0xa0, 0x1680, 0x180e, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x200b, 0x2028, 0x2029, 0x202f, 0x205f, 0x2060, 0x3000, 0xfeff,
]
const corpus = {
  sources: [sources[0], sources[1]].map((path) => ({
    path,
    sha256: createHash("sha256")
      .update(execFileSync("git", ["show", `main:${path}`]))
      .digest("hex"),
  })),
  locale: new Intl.Collator().resolvedOptions(),
  listing: {
    names,
    expected: names
      .map((path) => ({ path, type: "file" }))
      .sort(compare)
      .map((entry) => entry.path),
  },
  comparisons: strings.flatMap((a) => strings.map((b) => ({ a, b, result: Math.sign(a.localeCompare(b)) }))),
  trim: whitespace.map((unit) => {
    const input = String.fromCodePoint(unit) + "needle" + String.fromCodePoint(unit)
    return { input, expected: input.trim(), fuzzy: fuzzysort.go(input, ["needle"]).map((item) => item.target) }
  }),
}
await Bun.write(new URL("platform-parity.json", import.meta.url), JSON.stringify(corpus, null, 2) + "\n")
