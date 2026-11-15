import { expect, test } from "bun:test"
import { saveSessionExport } from "../src/export-file"

const exported = { filename: "session-synthetic.json", content: '{"info":{"id":"ses_synthetic"},"messages":[]}\n' }

test("native transcript export writes the canonical content only to the chosen folder without overwrite", async () => {
  const writes: unknown[] = []
  const result = await saveSessionExport(exported, () => true, { pickDirectory: async () => "/synthetic/exports", writeFile: async (...args) => { writes.push(args) } })
  expect(result).toEqual({ saved: true, path: "/synthetic/exports/session-synthetic.json" })
  expect(writes).toEqual([["/synthetic/exports/session-synthetic.json", exported.content, { flag: "wx", encoding: "utf8" }]])
})

test("cancelled folder selection and changed connection ownership write nothing", async () => {
  const writes: unknown[] = []
  const picker = Promise.withResolvers<string | null>()
  let current = true
  const writeFile = async (...args: unknown[]) => { writes.push(args) }
  expect(await saveSessionExport(exported, () => true, { pickDirectory: async () => null, writeFile })).toEqual({ saved: false })
  const pending = saveSessionExport(exported, () => current, { pickDirectory: () => picker.promise, writeFile })
  current = false
  picker.resolve("/synthetic/exports")
  await expect(pending).rejects.toThrow("connection changed")
  expect(writes).toEqual([])
})

test("invalid export names and stale connections cannot open a destination picker", async () => {
  let picked = 0
  let written = 0
  const port = { pickDirectory: async () => { picked++; return "/synthetic/exports" }, writeFile: async () => { written++ } }
  for (const filename of ["", ".", "..", "../session.md", "sub/session.md", "sub\\session.json", "session\n.json", "session.sh", `${"a".repeat(256)}.json`]) await expect(saveSessionExport({ ...exported, filename }, () => true, port)).rejects.toThrow("filename")
  await expect(saveSessionExport(exported, () => false, port)).rejects.toThrow("connection changed")
  expect(picked).toBe(0)
  expect(written).toBe(0)
})

test("an existing export is reported without an overwrite retry", async () => {
  let written = 0
  await expect(saveSessionExport(exported, () => true, { pickDirectory: async () => "/synthetic/exports", writeFile: async (_path, _content, options) => { expect(options.flag).toBe("wx"); written++; throw Object.assign(new Error("synthetic collision"), { code: "EEXIST" }) } })).rejects.toThrow("already exists")
  expect(written).toBe(1)
})
