import { expect, test } from "bun:test"
import path from "node:path"

test("the shipped native runtime notice includes DuckDB's copyright", async () => {
  expect(await Bun.file(path.join(import.meta.dir, "../../../NOTICE")).text()).toContain(
    "Copyright 2021-2026 Stichting DuckDB Foundation",
  )
})
