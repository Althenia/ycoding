import { describe, expect, test } from "bun:test"
import { scanBrandResiduals } from "./ycoding-residuals"

describe("YCoding brand residual scanner", () => {
  test("reports active OpenCode branding and ignores documented legacy references", () => {
    const findings = scanBrandResiduals([
      { path: "packages/tui/src/app.tsx", content: 'const title = "OpenCode TUI"' },
      {
        path: "patches/example.patch",
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
      {
        path: "NOTICE",
        content: "YCoding is derived from OpenCode.\n\nMIT License\n\nCopyright (c) 2025 opencode",
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

  test("preserves the web external-provider mark while rejecting product branding beside it", () => {
    expect(
      scanBrandResiduals([
        { path: "apps/web/src/assets/providers/opencode.svg", content: "<svg><title>opencode</title></svg>" },
        { path: "apps/web/src/assets/branding/opencode.svg", content: "<svg><title>OpenCode</title></svg>" },
        { path: "apps/web/src/remote/ui/provider-logo.tsx", content: 'const title = "OpenCode App"' },
      ]),
    ).toEqual([
      {
        path: "apps/web/src/assets/branding/opencode.svg",
        line: 0,
        value: "apps/web/src/assets/branding/opencode.svg",
        disposition: "replace",
      },
      { path: "apps/web/src/assets/branding/opencode.svg", line: 1, value: "OpenCode", disposition: "replace" },
      { path: "apps/web/src/remote/ui/provider-logo.tsx", line: 1, value: "OpenCode App", disposition: "replace" },
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

  test("reports OpenCode references in the removed office client path", () => {
    expect(
      scanBrandResiduals([
        {
          path: "apps/office/core/model_catalog.gd",
          content: 'const PROVIDER_LABELS := {\n\t"opencode": "OpenCode",\n\t"anthropic": "Anthropic",\n}',
        },
      ]),
    ).toEqual([
      {
        path: "apps/office/core/model_catalog.gd",
        line: 2,
        value: "OpenCode",
        disposition: "replace",
      },
    ])
  })
})
