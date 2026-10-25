import { expect, test } from "bun:test"
import { permissionAlwaysLines, permissionPresentation } from "../../src/util/permission"

test.each([
  ["tools.chatgpt.calendar.list_events", "ChatGPT · Calendar · List Events"],
  ["mcp__calendar__list_events", "Calendar · List Events"],
  ["calendar.list_events", "Calendar · List Events"],
  ["calendar.list-events", "Calendar · List Events"],
  ["calendar.read", "Calendar · Read"],
  ["calendar.\u001b[31mread\u202e", "Calendar · \\u001b[31mread\\u202e"],
])("formats the permission action %s without changing its identity", (action, label) => {
  const input = { action, resources: [] }
  expect(permissionPresentation(input)).toMatchObject({ title: `Call tool ${label}`, lines: [`Tool: ${label}`] })
  expect(input.action).toBe(action)
})

test("formats hashed connector actions with their tool metadata", () => {
  expect(permissionPresentation({
    action: "chatgpt_connector_42_list_events_012345abcdef",
    resources: ["connector-42"],
    metadata: { connector: "connector-42", connectorLabel: "Work Calendar", tool: "list_events" },
  })).toMatchObject({ title: "Call tool ChatGPT · Work Calendar · List Events" })
  expect(permissionPresentation({ action: "read", resources: ["src/index.ts"] }).title).toBe("Read src/index.ts")
})

test("escapes control characters in tool names and connector labels without hiding them", () => {
  const label = permissionPresentation({
    action: "chatgpt_connector_42_list_events_012345abcdef",
    resources: [],
    metadata: { connector: "connector-42", connectorLabel: "Calendar\u0000\u0007\t\n\u2028\u2029", tool: "list_events" },
  }).title
  expect(label).toBe("Call tool ChatGPT · Calendar\\u0000\\u0007\\u0009\\u000a\\u2028\\u2029 · List Events")
})

test("confirmation describes only the selected tool, patterns and current Session", () => {
  expect(permissionAlwaysLines({ action: "calendar.list_events", save: ["team/*"] })).toEqual([
    "Allow Calendar · List Events for these resource patterns in this Session:",
    "- team/*",
  ])
  expect(permissionAlwaysLines({ action: "calendar.list_events", save: ["*"] })).toEqual([
    "Allow Calendar · List Events for all resources in this Session.",
  ])
})

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
