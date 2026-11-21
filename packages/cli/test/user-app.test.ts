import { expect, expectTypeOf, test } from "bun:test"
import path from "node:path"
import type { V5Client } from "@ycoding-ai/client/v5"
import type { openUserApp, run, UserApp } from "../src/server-process"

expectTypeOf<UserApp["api"]>().toEqualTypeOf<Omit<V5Client, "transport">>()
expectTypeOf<typeof openUserApp>().toEqualTypeOf<typeof import("../src/user-app-api").openUserApp>()
expectTypeOf<typeof run>().toEqualTypeOf<typeof import("../src/user-app-api").run>()

const fixture = path.join(import.meta.dirname, "fixture/user-app.ts")
const cases = [
  "managed",
  "external",
  "private",
  "managed-race",
  "managed-version",
  "managed-failed",
  "managed-wait-cancel",
  "external-url",
  "external-auth",
  "external-version",
  "health-contract",
  "private-start",
  "private-pid",
  "private-ready",
  "health-epoch",
  "wire-contract",
  "opening-cancel",
  "socket-opening-cancel",
  "pre-cancel",
  "unbound",
  "location-relative",
  "location-missing",
  "signal-invalid",
  "signal-getter",
  "signal-detach-failure",
  "socket-headers",
  "socket-auth",
  "event-return",
  "event-signal",
  "close-subscription",
  "unsent",
  "sent",
  "domain",
  "resync",
  "deferred-socket",
  "deferred-private",
  "socket-close-failure",
  "private-close-failure",
  "private-exit-failure",
  "forced-termination",
  "run",
]

test.each(cases)(
  "ordinary main producer boundary: %s",
  async (scenario) => {
    const child = Bun.spawn([process.execPath, fixture, scenario], {
      cwd: path.join(import.meta.dirname, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const result = JSON.parse(stdout)
    expect(result).toEqual({ scenario, passed: true })
  },
  15_000,
)
