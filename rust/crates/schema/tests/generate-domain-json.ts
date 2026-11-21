import { fileURLToPath } from "node:url"

const directory = fileURLToPath(new URL("./fixtures/", import.meta.url))
const inputs = [
  "null",
  "true",
  "false",
  "[]",
  "{}",
  "-0",
  "0.0",
  "9007199254740991",
  "9007199254740992",
  "9007199254740993",
  "1e21",
  "1e20",
  "1e-6",
  "1e-7",
  "5e-324",
  "2.2250738585072014e-308",
  "1.7976931348623157e308",
  "1e400",
  "-1e400",
  "1e-400",
  '"\\ud800"',
  '"\\udc00"',
  '"\\ud83d\\ude00"',
  '"A\\ud800b\\udc00"',
  '"\\ud800\\ud83d\\ude00\\udc00"',
  '"\\\\ud800"',
  '"\\u0000\\b\\t\\n\\f\\r\\\\\\\"/"',
  '"é😀\u2028\u2029"',
  '{"b":1,"10":2,"2":3,"01":4,"4294967294":5,"4294967295":6,"0":7,"-0":8,"a":9}',
  '{"b":1,"a":2,"b":3,"1":4,"1":5}',
  '{"\\ud800":1,"\\udc00":2,"\\ud83d\\ude00":3,"A\\ud800b\\udc00":4,"\\ud800":5}',
  '{"__proto__":1,"constructor":2,"toString":3,"__proto__":4}',
  ' { "a" : [ null, false, -0, "\\ud800", { "2": 1, "1": 2 } ] }\r\n',
]
let seed = 0x6d2b79f5
function next() {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return seed >>> 0
}
const buffer = new DataView(new ArrayBuffer(8))
for (let index = 0; index < 30000; index++) {
  buffer.setUint32(0, next())
  buffer.setUint32(4, next())
  const number = buffer.getFloat64(0)
  if (Number.isFinite(number)) inputs.push(number.toExponential(20))
  inputs.push(`${next() % 2 ? "-" : ""}${next()}.${next().toString().padStart(10, "0")}e${(next() % 700) - 350}`)
}
for (let exponent = -324; exponent <= 308; exponent++) {
  for (const coefficient of ["1", "1.0000000000000001", "1.2345678901234567", "2.5", "9.999999999999999"]) {
    inputs.push(`${coefficient}e${exponent}`)
  }
}
for (let index = 0; index < 512; index++) {
  const units = Array.from({ length: next() % 24 }, () => next() % 65536)
  const text = String.fromCharCode(...units)
  inputs.push(JSON.stringify(text))
  const entries = [text, "10", "2", "01", "4294967295", "0", text].map(
    (key, position) => `${JSON.stringify(key)}:${position}`,
  )
  inputs.push(`{${entries.join(",")}}`)
}
const expected = inputs.map((input) => JSON.stringify(JSON.parse(input)))
await Bun.write(`${directory}domain-json-inputs.json`, `${JSON.stringify(inputs)}\n`)
await Bun.write(`${directory}domain-json-expected.json`, `${JSON.stringify(expected)}\n`)
console.log(JSON.stringify({ bun: Bun.version, vectors: inputs.length, keyOrder: JSON.parse(expected[28]) }))
