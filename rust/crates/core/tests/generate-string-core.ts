const original = Bun.spawnSync(["git", "show", "main:packages/codemode/test/string-core-test262.test.ts"])
if (original.exitCode !== 0) throw new Error("Cannot read the committed String Core corpus")
const source = original.stdout.toString()
const boundary = source.indexOf('describe("Test262-adapted core String behavior"')
if (boundary < 0) throw new Error("The String Core corpus must declare its vector loop")
const fixtureSource =
  source.slice(0, boundary).replace(/^import .*$/gm, "") +
  `
export const generated = JSON.stringify(vectors.map(vector => {
  const results = vector.assertions.map(item => {
    const args = (item.args ?? []).map(literal).join(", ")
    const expression = vector.static ? "String." + vector.method + "(" + args + ")" : JSON.stringify(item.input) + "." + vector.method + "(" + args + ")"
    const observed = vector.static && vector.method === "fromCharCode" && typeof item.expected === "number" ? expression + ".charCodeAt(0)" : expression
    const checked = item.outcome === "undefined" ? observed + " === undefined" : item.outcome === "length" ? observed + ".length" : item.outcome === "RangeError" ? "(() => { try { " + observed + "; return false } catch (error) { return error instanceof RangeError } })()" : observed
    return "{ label: " + JSON.stringify(item.label) + ", value: " + checked + " }"
  })
  return {path: vector.path, code: "return [" + results.join(",") + "]", expected: vector.assertions.map(item => ({label: item.label, value: item.outcome === undefined || item.outcome === "length" ? item.expected : true}))}
}), null, 2)
`
const loaded: unknown = await import(
  "data:text/javascript;base64," +
    Buffer.from(new Bun.Transpiler({ loader: "ts" }).transformSync(fixtureSource)).toString("base64")
)
if (typeof loaded !== "object" || loaded === null || !("generated" in loaded))
  throw new Error("The String Core specification must export its generated vectors")
const generated = loaded.generated
if (typeof generated !== "string") throw new Error("The String Core specification must produce JSON vectors")
await Bun.write(new URL("string-core-corpus.json", import.meta.url), generated + "\n")
