import { expect, test } from "bun:test"
import { saveCustomEndpoint } from "../src/custom-endpoint-save"

test("M3 configures the backend before credential connection and read-model refresh", async () => {
  const order: string[] = []
  const result = await saveCustomEndpoint(
    { baseURL: "https://example.test/v1", api: "responses", models: [], apiKey: "synthetic-secret", profile: " work " },
    {
      async configure(input) {
        expect(JSON.stringify(input)).not.toContain("synthetic-secret")
        order.push("configure")
        return {
          providerID: "backend-selected",
          target: { scope: "global", path: "/backend/config/ycoding.json" },
          registered: true,
        }
      },
      async connectKey(input) {
        expect(input).toEqual({ integrationID: "backend-selected", key: "synthetic-secret", label: "work" })
        order.push("connect")
      },
      async activate() {
        throw new Error("unexpected activation")
      },
      async refresh() {
        order.push("refresh")
      },
    },
  )
  expect(order).toEqual(["configure", "connect", "refresh"])
  expect(result).toEqual({ providerID: "backend-selected", credentialConnected: true })
})

test("M3 activates an existing credential only after backend configuration", async () => {
  const order: string[] = []
  await saveCustomEndpoint(
    { baseURL: "https://example.test", api: "chat", models: [], credentialID: "profile" },
    {
      async configure() {
        order.push("configure")
        return {
          providerID: "custom",
          target: { scope: "global", path: "/backend/config/ycoding.json" },
          registered: true,
        }
      },
      async connectKey() {
        throw new Error("unexpected connection")
      },
      async activate(id) {
        expect(id).toBe("profile")
        order.push("activate")
      },
      async refresh() {
        order.push("refresh")
      },
    },
  )
  expect(order).toEqual(["configure", "activate", "refresh"])
})

test("M3 backend failures and unregistered results never start credential work", async () => {
  for (const failure of ["failed", "unregistered"] as const) {
    const effects: string[] = []
    await expect(
      saveCustomEndpoint(
        { baseURL: "https://example.test", api: "chat", models: [], apiKey: "synthetic-secret" },
        {
          async configure() {
            if (failure === "failed") throw new Error("configuration rejected")
            return {
              providerID: "custom",
              target: { scope: "global", path: "/backend/config/ycoding.json" },
              registered: false,
            }
          },
          async connectKey() {
            effects.push("connect")
          },
          async activate() {
            effects.push("activate")
          },
          async refresh() {
            effects.push("refresh")
          },
        },
      ),
    ).rejects.toThrow(failure === "failed" ? "configuration rejected" : "integration did not register")
    expect(effects).toEqual([])
  }
})

test("M3 refreshes config-only saves and reports sanitized partial credential failures", async () => {
  const services = {
    async configure() {
      return {
        providerID: "custom",
        target: { scope: "global" as const, path: "/backend/config/ycoding.json" },
        registered: true,
      }
    },
    async connectKey() {
      throw new Error("synthetic-secret")
    },
    async activate() {},
    async refresh() {},
  }
  expect(await saveCustomEndpoint({ baseURL: "https://example.test", api: "chat", models: [] }, services)).toEqual({
    providerID: "custom",
    credentialConnected: false,
  })
  await expect(
    saveCustomEndpoint(
      { baseURL: "https://example.test", api: "chat", models: [], apiKey: "synthetic-secret" },
      services,
    ),
  ).rejects.toThrow("Endpoint config saved, but credential profile connection failed.")
  await expect(
    saveCustomEndpoint(
      { baseURL: "https://example.test", api: "chat", models: [] },
      {
        ...services,
        async refresh() {
          throw new Error("provider refresh failed")
        },
      },
    ),
  ).rejects.toThrow("provider read-model refresh failed")
})
