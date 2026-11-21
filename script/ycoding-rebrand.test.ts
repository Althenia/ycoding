import { describe, expect, test } from "bun:test"
import { classifyLegacyReference, rewriteBrandPath, rewriteBrandText } from "./ycoding-rebrand"

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

    expect(rewriteBrandText("NOTICE", "MIT License\n\nCopyright (c) 2025 opencode")).toBe(
      "MIT License\n\nCopyright (c) 2025 opencode",
    )

    expect(
      rewriteBrandText(
        "packages/core/src/plugin/provider/opencode.ts",
        'export const OpencodePlugin = "OpenCode provider"\nconst provider = "opencode-go"\nconst key = process.env.OPENCODE_API_KEY\nconst label = "OpenCode Console account"',
      ),
    ).toBe(
      'export const OpencodePlugin = "OpenCode provider"\nconst provider = "opencode-go"\nconst key = process.env.OPENCODE_API_KEY\nconst label = "OpenCode Console account"',
    )
  })

  test("preserves the exact web external-provider asset path and its source identity", () => {
    const asset = "apps/web/src/assets/providers/opencode.svg"
    const content = "<svg><title>opencode</title></svg>"
    expect(classifyLegacyReference(asset, content)).toBe("external")
    expect(rewriteBrandText(asset, content)).toBe(content)
    expect(rewriteBrandPath(asset)).toBe(asset)
    expect(rewriteBrandPath("apps/web/src/assets/branding/opencode.svg")).toBe(
      "apps/web/src/assets/branding/ycoding.svg",
    )
  })

  test("preserves native external OpenCode provider modules and exact external IDs", () => {
    const module = "rust/crates/core/src/resources/auth/opencode.rs"
    const tests = "rust/crates/core/tests/auth_opencode.rs"
    const refresh = "rust/crates/core/tests/session_runner_auth_refresh.rs"
    const source = [
      'f.write_str("OpenCodeConsole([redacted])")',
      'json!({"client_id":"opencode-cli"})',
      'integration: "opencode".into(),',
      'label: "OpenCode Console account".into(),',
    ].join("\n")
    for (const file of [module, tests, refresh]) {
      expect(rewriteBrandText(file, source)).toBe(source)
      expect(rewriteBrandPath(file)).toBe(file)
      expect(classifyLegacyReference(file, file)).toBe("external")
    }
    expect(classifyLegacyReference("rust/crates/core/src/resources/auth/mod.rs", "pub mod opencode;")).toBe("external")
    expect(
      classifyLegacyReference("rust/crates/core/src/resources/auth/mod.rs", "            let console = opencode::Console::new("),
    ).toBe("external")
    expect(
      classifyLegacyReference("rust/crates/core/src/resources/auth/builtin.rs", "            super::opencode::Console::new("),
    ).toBe("external")
    expect(
      classifyLegacyReference("rust/crates/core/src/extension/capabilities.rs", '    "opencode.provider.opencode",'),
    ).toBe("external")
    expect(
      classifyLegacyReference(
        "rust/crates/runtime/tests/plugin_context.rs",
        '            envOnly: await context.integration.connection.active("opencode"),',
      ),
    ).toBe("external")
  })

  test("still rejects native active product and config references and lookalike paths", () => {
    const module = "rust/crates/core/src/resources/auth/opencode.rs"
    expect(classifyLegacyReference(module, 'let dir = home.join(".opencode");')).toBe("replace")
    expect(classifyLegacyReference(module, 'std::env::var("OPENCODE_CONFIG")')).toBe("replace")
    expect(classifyLegacyReference(module, 'title("OpenCode TUI")')).toBe("replace")
    expect(classifyLegacyReference(module, 'env("OPENCODE_CONFIG"); label("OpenCode Console")')).toBe("replace")
    expect(classifyLegacyReference(module, 'title("OpenCode TUI"); label("OpenCode Console account")')).toBe("replace")
    expect(
      classifyLegacyReference(
        "rust/crates/core/tests/auth_opencode.rs",
        'dir.join(".opencode"); // OpenCode Console',
      ),
    ).toBe("replace")
    expect(classifyLegacyReference("rust/crates/core/src/resources/auth/opencode_extra.rs", "fn main() {}")).toBe(
      "replace",
    )
    expect(classifyLegacyReference("rust/crates/core/src/config/opencode.rs", "rust/crates/core/src/config/opencode.rs")).toBe(
      "replace",
    )
    expect(classifyLegacyReference("rust/crates/core/src/config/mod.rs", "pub mod opencode;")).toBe("replace")
    expect(classifyLegacyReference("rust/crates/core/src/config/mod.rs", 'dir.join(".opencode")')).toBe("replace")
    expect(classifyLegacyReference("rust/crates/core/src/lib.rs", 'let id = "opencode.provider.other";')).toBe("replace")
    expect(classifyLegacyReference("rust/crates/core/src/lib.rs", 'active("opencode")')).toBe("replace")
  })

  test("classifies active, upstream, compatibility, and external references", () => {
    expect(classifyLegacyReference("packages/tui/src/app.tsx", "OpenCode TUI")).toBe("replace")
    expect(classifyLegacyReference("patches/example.patch", "https://github.com/anomalyco/opencode")).toBe("upstream")
    expect(classifyLegacyReference("plans/session-generate.md", "OpenCode TUI")).toBe("replace")
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
    expect(
      classifyLegacyReference("packages/core/package.json", '    "cursor-opencode-provider": "0.7.4",'),
    ).toBe("external")
    expect(rewriteBrandText("packages/core/src/aisdk.ts", 'const CURSOR_PACKAGE = "cursor-opencode-provider"')).toBe(
      'const CURSOR_PACKAGE = "cursor-opencode-provider"',
    )
  })
})
