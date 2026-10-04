import { expect, test } from "bun:test"
import { permissionAlwaysLines, permissionPresentation } from "../../src/util/permission"

test("preserves permission roots and self-contained metadata", () => {
  expect(permissionPresentation({ action: "external_directory", resources: ["/*"] }).title).toBe(
    "Access external directory /",
  )
  expect(permissionPresentation({ action: "external_directory", resources: ["C:/*"] }).title).toBe(
    "Access external directory C:/",
  )
  expect(
    permissionPresentation({ action: "webfetch", resources: [], metadata: { url: "https://example.com" } }),
  ).toMatchObject({
    title: "WebFetch https://example.com",
    lines: ["URL: https://example.com"],
  })
  expect(permissionPresentation({ action: "websearch", resources: [], metadata: { query: "releases" } })).toMatchObject(
    {
      title: 'Web Search "releases"',
      lines: ["Query: releases"],
    },
  )
})

test.each(["profile", "owned"])("warns before granting %s Chrome site actions that can trigger downloads", (mode) => {
  for (const action of ["browser_interact", "browser_navigate"]) {
    const view = permissionPresentation({
      action,
      resources: ["https://example.test/form"],
      metadata: { mode, incidentalDownloads: true, site: "https://example.test" },
    })
    expect(view.title).toContain("example.test")
    expect(view.lines.join(" ")).toMatch(/click.*download|download.*click/i)
    expect(
      permissionAlwaysLines({
        action,
        save: ["https://example.test"],
        metadata: { mode, incidentalDownloads: true },
      }).join(" "),
    ).toContain("without another prompt")
  }
})

test("does not invent an incidental Chrome download warning for unflagged browser actions", () => {
  const metadata = { operation: "navigate" }
  expect(
    permissionPresentation({ action: "browser_navigate", resources: ["https://example.test"], metadata }).lines.join(
      " ",
    ),
  ).not.toContain("download")
  expect(
    permissionAlwaysLines({ action: "browser_navigate", save: ["https://example.test"], metadata }).join(" "),
  ).not.toContain("download")
})
