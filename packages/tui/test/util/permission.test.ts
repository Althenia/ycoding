import { expect, test } from "bun:test"
import { permissionPresentation } from "../../src/util/permission"

test("preserves permission roots and self-contained metadata", () => {
  expect(permissionPresentation({ action: "external_directory", resources: ["/*"] }).title).toBe(
    "Access external directory /",
  )
  expect(permissionPresentation({ action: "external_directory", resources: ["C:/*"] }).title).toBe(
    "Access external directory C:/",
  )
  expect(permissionPresentation({ action: "webfetch", resources: [], metadata: { url: "https://example.com" } })).toMatchObject({
    title: "WebFetch https://example.com",
    lines: ["URL: https://example.com"],
  })
  expect(permissionPresentation({ action: "websearch", resources: [], metadata: { query: "releases" } })).toMatchObject({
    title: 'Web Search "releases"',
    lines: ["Query: releases"],
  })
})

test("warns before granting selected Chrome site actions that can trigger downloads", () => {
  const view = permissionPresentation({
    action: "browser_interact",
    resources: ["https://example.test/form"],
    metadata: { mode: "selected", incidentalDownloads: true, site: "https://example.test" },
  })
  expect(view.title).toContain("example.test")
  expect(view.lines.join(" ")).toMatch(/click.*download|download.*click/i)
})
