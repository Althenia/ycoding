import { expect, test } from "bun:test"
import { create } from "@bufbuild/protobuf"
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt"
import { codecNameCollisions, rustTypeName, validateCodecNames } from "../src/v5/codec-names.js"
import { descriptorSet } from "./descriptor-set.js"

test("prost type-name normalization retains case boundaries, acronym and digit semantics", () => {
  for (const [source, expected] of [
    ["browser_action_Result", "BrowserActionResult"],
    ["Browser_ActionResult", "BrowserActionResult"],
    ["FuzzBuster", "FuzzBuster"],
    ["FOO_BAR", "FooBar"],
    ["self", "Self_"],
    ["foo2BAR", "Foo2Bar"],
  ])
    expect(rustTypeName(source)).toBe(expected)
})

test("codec collision gate rejects message/enum and nested Buf flattened names", () => {
  const set = create(FileDescriptorSetSchema, {
    file: [
      {
        name: "ycoding/v5/test.proto",
        package: "ycoding.v5",
        messageType: [
          { name: "FooBar" },
          { name: "Parent", nestedType: [{ name: "Child" }] },
          { name: "Parent_Child" },
        ],
        enumType: [{ name: "foo_bar" }],
      },
    ],
  })
  const collisions = codecNameCollisions(set)
  expect(collisions.some((item) => item.includes("Rust") && item.includes("FooBar") && item.includes("foo_bar"))).toBe(
    true,
  )
  expect(
    collisions.some(
      (item) => item.includes("TypeScript") && item.includes("Parent_Child") && item.includes("Parent.Child"),
    ),
  ).toBe(true)
  expect(() => validateCodecNames(set)).toThrow("codec name collision")
})

test("canonical v5 descriptor names have no codec collisions", async () => {
  expect(codecNameCollisions(descriptorSet())).toEqual([])
})
