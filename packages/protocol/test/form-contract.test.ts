import { expect, test } from "bun:test"

test("form outputs share one field identity with numeric bounds for input controls", async () => {
  const generated = await Bun.file(new URL("../../client/src/promise/generated/types.ts", import.meta.url)).text()
  expect(generated.match(/^export type FormField\d* =/gm)).toEqual(["export type FormField ="])
  expect(generated.match(/^export type FormFields\d* =/gm)).toEqual(["export type FormFields ="])
  expect(generated).toContain("export type FormFields = [FormField, ...Array<FormField>]")
  expect(generated).toMatch(/export type FormInfo = [^\n]*fields: FormFields[ ;}]/)
  for (const name of ["FormIntegerField", "FormNumberField"]) {
    const field = generated.match(new RegExp(`export type ${name} = \\{[^}]+\\}`))?.[0]
    expect(field).toContain("minimum?: number\n")
    expect(field).toContain("maximum?: number\n")
    expect(field).not.toContain('"Infinity"')
  }
})
