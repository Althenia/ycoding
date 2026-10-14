import { describe, expect, test } from "bun:test"
import type { IntegrationInfo } from "@ycoding-ai/client"
import {
  connectionSummary,
  connectMethods,
  credentialConnections,
  integrationOptions,
  profileFallback,
} from "../../../../src/component/dialog-integration"

const integration = (value: Partial<IntegrationInfo> & Pick<IntegrationInfo, "id" | "name">): IntegrationInfo => ({
  methods: [],
  connections: [],
  ...value,
})

describe("integrationOptions", () => {
  test("keeps popular integrations first and sorts the rest alphabetically", () => {
    expect(
      integrationOptions([
        integration({ id: "minimax", name: "MiniMax" }),
        integration({ id: "openai", name: "OpenAI" }),
        integration({ id: "custom-z", name: "Zebra" }),
        integration({ id: "anthropic", name: "Anthropic" }),
      ]).map((item) => item.id),
    ).toEqual(["openai", "anthropic", "minimax", "custom-z"])
  })

  test("keeps backend lists authoritative without privileging dropped provider IDs", () => {
    expect(
      integrationOptions([
        integration({ id: "google", name: "Google" }),
        integration({ id: "github-copilot", name: "GitHub Copilot" }),
        integration({ id: "opencode-go", name: "OpenCode Go" }),
        integration({ id: "ycoding", name: "YCoding Go" }),
        integration({ id: "cursor", name: "Cursor" }),
        integration({ id: "anthropic", name: "Anthropic" }),
        integration({ id: "openai", name: "OpenAI" }),
      ]).map((item) => item.id),
    ).toEqual(["openai", "anthropic", "cursor", "github-copilot", "google", "opencode-go", "ycoding"])
  })
})

describe("connectMethods", () => {
  test("offers key and OAuth methods but not environment discovery", () => {
    expect(
      connectMethods(
        integration({
          id: "example",
          name: "Example",
          methods: [
            { type: "env", names: ["EXAMPLE_KEY"] },
            { type: "key", label: "API key" },
            { type: "oauth", id: "account", label: "Account" },
          ],
        }),
      ).map((method) => method.type),
    ).toEqual(["oauth", "key"])
  })
})

describe("credentialConnections", () => {
  test("returns removable credential connections only", () => {
    expect(
      credentialConnections(
        integration({
          id: "example",
          name: "Example",
          connections: [
            { type: "env", name: "EXAMPLE_KEY" },
            { type: "credential", id: "cred_1", label: "Work", active: true },
          ],
        }),
      ),
    ).toEqual([{ type: "credential", id: "cred_1", label: "Work", active: true }])
  })
})

describe("connectionSummary", () => {
  test("shows credential labels and environment variables", () => {
    expect(
      connectionSummary(
        integration({
          id: "example",
          name: "Example",
          connections: [
            { type: "credential", id: "cred_1", label: "Work", active: true },
            { type: "env", name: "EXAMPLE_KEY" },
          ],
        }),
      ),
    ).toBe("Work, $EXAMPLE_KEY")
  })
})

describe("profileFallback", () => {
  test("offers the historical default name first and avoids one already in use", () => {
    expect(profileFallback(integration({ id: "openai", name: "OpenAI" }))).toBe("default")
    expect(
      profileFallback(
        integration({
          id: "openai",
          name: "OpenAI",
          connections: [
            { type: "credential", id: "cred_1", label: "default", active: true },
            { type: "credential", id: "cred_2", label: "profile-2", active: false },
          ],
        }),
      ),
    ).toBe("profile-3")
  })
})
