const files = [
  "array-core-test262",
  "array-callbacks-test262",
  "callbacks",
  "codemode",
  "date-test262",
  "enumeration",
  "groupby-test262",
  "lexical-test262",
  "parity",
  "promise",
  "promise-test262",
  "regexp-math-test262",
  "set-methods-test262",
  "stdlib",
  "string-regexp-test262",
  "string-search-test262",
]
for (const file of [...files.map((file) => `${file}.test.ts`), "LICENSE.test262"]) {
  const result = Bun.spawnSync(["git", "show", `main:packages/codemode/test/${file}`])
  if (result.exitCode !== 0) throw new Error(`Cannot read committed corpus ${file}`)
  await Bun.write(new URL(`code-mode-corpora/${file}`, import.meta.url), result.stdout)
}
