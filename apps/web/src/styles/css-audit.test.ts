import { describe, expect, test } from "bun:test"
import { cssAuditExitCode, validateRawCssAudit, type CssAuditFinding, type RawCssAudit } from "./css-audit"
import { parseStylesheet, stylesheetImports } from "./css-rules"
import { loadCssAuditSources } from "../../verify/css-audit"

const finding = (level: CssAuditFinding["level"], code: string): CssAuditFinding => ({ level, code, file: "synthetic.css", line: 1, message: code })
const raw = (findings: readonly CssAuditFinding[]): RawCssAudit => ({ files: 13, error: findings.filter(item => item.level === "error").length, warning: findings.filter(item => item.level === "warning").length, info: findings.filter(item => item.level === "info").length, findings })

describe("raw CSS audit", () => {
  test("passes only when raw errors and warnings are zero", () => {
    expect(cssAuditExitCode(raw([]))).toBe(0)
    expect(cssAuditExitCode(raw([finding("info", "costly-animation")]))).toBe(0)
    expect(cssAuditExitCode(raw([finding("error", "unknown")]))).toBe(1)
  })

  for (const code of ["breakpoint-drift", "scrollbar-unowned", "scrollbar-conditional", "native-control", "glass-unguarded", "raw-duration", "unknown"]) {
    test(`retains ${code} warnings without an exception`, () => {
      const result = Object.freeze(raw(Object.freeze([Object.freeze(finding("warning", code))])))
      const before = JSON.stringify(result)
      expect(cssAuditExitCode(result)).toBe(1)
      expect(JSON.stringify(result)).toBe(before)
    })
  }

  test("rejects inconsistent counters and malformed results", () => {
    expect(() => cssAuditExitCode({ ...raw([]), error: 1 })).toThrow("count does not match findings")
    expect(() => validateRawCssAudit({ ...raw([]), findings: [{ ...finding("warning", "unknown"), level: "unknown" }] })).toThrow("Invalid CSS audit finding")
    expect(() => validateRawCssAudit({ ...raw([]), files: -1 })).toThrow("Invalid CSS audit file count")
  })

  test("locates live rules through comments, nested media and quoted braces", () => {
    const sheet = parseStylesheet("synthetic.css", '/* hidden { }\n comment */\n@media (max-width: 1279px) {\n.team-control { content:"}"; position:fixed; }\n}')
    expect(sheet.rules[0]).toMatchObject({ header: ".team-control", line: 4, endLine: 4, conditionLines: [3], conditions: ["@media (max-width: 1279px)"] })
  })

  test("keeps rules after CSS imports unconditional and at their original lines", () => {
    const source = '@import "../ui/button.css";\n@import "../ui/modal.css";\n.composer__upload progress { appearance:none; border:0; }'
    expect(stylesheetImports(source)).toEqual(["../ui/button.css", "../ui/modal.css"])
    expect(parseStylesheet("synthetic.css", source).rules[0]).toMatchObject({ header: ".composer__upload progress", line: 3, conditions: [], conditionLines: [] })
  })

  test("preserves quoted semicolons in selectors", () => {
    expect(parseStylesheet("synthetic.css", '[data-value=";"] { color:var(--yc-text); }').rules[0]?.header).toBe('[data-value=";"]')
  })

  test("loads all thirteen audited owners from the actual application entry", async () => {
    const sources = await loadCssAuditSources()
    for (const file of ["styles/tokens.css", "styles/base.css", "styles/site.css", "styles/remote.css", "styles/docs.css", "remote/ui/composer.css", "remote/ui/projects.css", "remote/ui/team-view.css", "remote/ui/command-palette.css", "remote/ui/device-alias.css", "ui/custom-select.css", "ui/modal.css", "remote/ui/file-change-card.css"]) expect(sources[`apps/web/src/${file}`]?.length).toBeGreaterThan(0)
  })
})
