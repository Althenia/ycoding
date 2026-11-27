import { expect, test } from "bun:test"
import { V5ClientError } from "@ycoding-ai/client/v5"
import { errorToast } from "../src/ui/toast"

test("a connection loss that left a request unsent is a transient warning", () => {
  expect(errorToast(new V5ClientError("unsent", "session.todo.list", undefined, true))).toMatchObject({
    variant: "warning",
    title: "Connection",
    message: expect.stringContaining("Request session.todo.list was not sent"),
  })
})

test("a request that cannot be resent and other failures stay errors", () => {
  expect(errorToast(new V5ClientError("unsent", "session.prompt", "Input cannot be represented by v5"))).toMatchObject({
    variant: "error",
    message: expect.stringContaining("Your message was not sent"),
  })
  expect(errorToast(new Error("boom"))).toEqual({ variant: "error", message: "boom" })
})
