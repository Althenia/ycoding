import { describe, expect, test } from "bun:test"
import { classifyLegacyReference, rewriteBrandText } from "./ycoding-rebrand"

describe("YCoding rebrand policy", () => {
  test("rewrites canonical product, package, environment, config, and protocol identifiers", () => {
    const input = [
      "OpenCode TUI",
      "@opencode-ai/core",
      "OPENCODE_CONFIG",
      ".opencode/opencode.jsonc",
      "x-opencode-directory",
      "opencode --continue",
    ].join("\n")

    expect(rewriteBrandText("packages/cli/src/example.ts", input)).toBe(
      [
        "YCoding TUI",
        "@ycoding-ai/core",
        "YCODING_CONFIG",
        ".ycoding/ycoding.jsonc",
        "x-ycoding-directory",
        "ycoding --continue",
      ].join("\n"),
    )
  })

  test("preserves explicit upstream attribution and genuine external OpenCode provider identity", () => {
    expect(
      rewriteBrandText(
        "patches/example.patch",
        "Upstream source: https://github.com/anomalyco/opencode and https://opencode.ai/docs",
      ),
    ).toBe("Upstream source: https://github.com/anomalyco/opencode and https://opencode.ai/docs")

    expect(
      rewriteBrandText(
        "packages/core/src/plugin/provider/opencode.ts",
        'export const OpencodePlugin = "OpenCode provider"\nconst provider = "opencode-go"\nconst key = process.env.OPENCODE_API_KEY\nconst label = "OpenCode Console account"',
      ),
    ).toBe(
      'export const OpencodePlugin = "OpenCode provider"\nconst provider = "opencode-go"\nconst key = process.env.OPENCODE_API_KEY\nconst label = "OpenCode Console account"',
    )
  })

  test("classifies active, upstream, compatibility, and external references", () => {
    expect(classifyLegacyReference("packages/tui/src/app.tsx", "OpenCode TUI")).toBe("replace")
    expect(classifyLegacyReference("patches/example.patch", "https://github.com/anomalyco/opencode")).toBe("upstream")
    expect(classifyLegacyReference("docs/ycoding-migration.md", "legacy OPENCODE_CONFIG fallback")).toBe(
      "compatibility",
    )
    expect(
      classifyLegacyReference("script/ycoding-rebrand.ts", '.replace(/\\bOPENCODE_([A-Z0-9_]+)\\b/g, "YCODING_$1")'),
    ).toBe("compatibility")
    expect(
      classifyLegacyReference("packages/core/src/plugin/provider/opencode.ts", 'Integration.ID.make("opencode")'),
    ).toBe("external")
    expect(
      classifyLegacyReference(
        "packages/core/src/plugin/provider.ts",
        'import { OpencodePlugin } from "./provider/opencode"',
      ),
    ).toBe("external")
    expect(
      classifyLegacyReference(
        "packages/tui/src/component/dialog-retry-action.tsx",
        'const GO_URL = "https://opencode.ai/go"',
      ),
    ).toBe("external")
    expect(
      classifyLegacyReference(
        "packages/tui/test/mini/footer.view.test.tsx",
        'currentModel: { providerID: "opencode", modelID: "gpt-5" }',
      ),
    ).toBe("external")
    expect(classifyLegacyReference("CONTRIBUTING.md", "OpenCode Zen is an external provider")).toBe("external")
    expect(classifyLegacyReference("packages/core/src/plugin/provider.ts", "OpencodePlugin,")).toBe("external")
    expect(classifyLegacyReference(".ycoding/command/commit.md", "model: opencode/kimi-k2.5")).toBe("external")
  })
})
