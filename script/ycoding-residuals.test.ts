import { describe, expect, test } from "bun:test"
import { scanBrandResiduals } from "./ycoding-residuals"

describe("YCoding brand residual scanner", () => {
  test("reports active OpenCode branding and ignores documented legacy references", () => {
    const findings = scanBrandResiduals([
      { path: "packages/tui/src/app.tsx", content: 'const title = "OpenCode TUI"' },
      {
        path: "docs/upstream-differences.md",
        content: "Upstream: https://github.com/anomalyco/opencode",
      },
      {
        path: "docs/ycoding-migration.md",
        content: "YCODING_CONFIG takes precedence over legacy OPENCODE_CONFIG.",
      },
      {
        path: "packages/core/src/plugin/provider/opencode.ts",
        content: 'const integrationID = "opencode" // external OpenCode Console integration',
      },
    ])

    expect(findings).toEqual([
      {
        path: "packages/tui/src/app.tsx",
        line: 1,
        value: "OpenCode TUI",
        disposition: "replace",
      },
    ])
  })

  test("reports active legacy names in filenames", () => {
    expect(scanBrandResiduals([{ path: "packages/cli/bin/opencode.cjs", content: "" }])).toEqual([
      {
        path: "packages/cli/bin/opencode.cjs",
        line: 0,
        value: "packages/cli/bin/opencode.cjs",
        disposition: "replace",
      },
    ])
  })
})
