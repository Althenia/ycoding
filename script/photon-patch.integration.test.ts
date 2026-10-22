import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-photon-patch-"))
const fixture = path.join(import.meta.dir, "fixture/photon-patch")

afterAll(() => fs.rm(directory, { recursive: true, force: true }))

beforeAll(async () => {
  await fs.cp(fixture, directory, { recursive: true })
  await fs.mkdir(path.join(directory, "patches"))
  await fs.copyFile(
    path.join(import.meta.dir, "../patches/@silvia-odwyer%2Fphoton-node@0.3.4.patch"),
    path.join(directory, "patches/photon.patch"),
  )
  const lockfile = await Bun.file(path.join(directory, "bun.lock")).text()
  const install = Bun.spawn(
    [
      process.execPath,
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--registry",
      "https://registry.npmjs.org",
      "--cache-dir",
      path.join(directory, "cache"),
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  )
  const [status, output, error] = await Promise.all([
    install.exited,
    new Response(install.stdout).text(),
    new Response(install.stderr).text(),
  ])
  expect(status, output + error).toBe(0)
  expect(await Bun.file(path.join(directory, "bun.lock")).text()).toBe(lockfile)
}, 60_000)

test("a cold frozen Photon install keeps its default WASM path and image exports", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const photon = require("@silvia-odwyer/photon-node")
const image = new photon.PhotonImage(Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1)
try {
  const decoded = photon.PhotonImage.new_from_byteslice(image.get_bytes())
  try {
    console.log(JSON.stringify({
      width: decoded.get_width(),
      height: decoded.get_height(),
      pixels: Array.from(decoded.get_raw_pixels()),
    }))
  } finally { decoded.free() }
} finally { image.free() }`,
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  )
  const [status, output, error] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ])
  expect(status, error).toBe(0)
  expect(JSON.parse(output)).toEqual({
    width: 2,
    height: 1,
    pixels: [255, 0, 0, 255, 0, 0, 255, 255],
  })
})

test("a compiled Photon build loads embedded WASM and resizes images away from its source", async () => {
  await fs.mkdir(path.join(directory, "runtime"))
  await Bun.write(
    path.join(directory, "embedded.ts"),
    `import wasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
;(globalThis as typeof globalThis & { __YCODING_PHOTON_WASM_PATH?: string }).__YCODING_PHOTON_WASM_PATH = wasm
const photon = await import("@silvia-odwyer/photon-node")
const image = new photon.PhotonImage(Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1)
try {
  const resized = photon.resize(image, 1, 1, photon.SamplingFilter.Nearest)
  try {
    console.log(JSON.stringify({ width: resized.get_width(), height: resized.get_height(), png: Array.from(resized.get_bytes().slice(0, 8)) }))
  } finally { resized.free() }
} finally { image.free() }
`,
  )
  const executable = path.join(directory, "runtime/photon")
  const build = Bun.spawn([process.execPath, "build", "--compile", "embedded.ts", "--outfile", executable], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, output, error] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ])
  expect(status, output + error).toBe(0)
  const run = Bun.spawn([executable], {
    cwd: path.join(directory, "runtime"),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, result, failure] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ])
  expect(exit, failure).toBe(0)
  expect(JSON.parse(result)).toEqual({ width: 1, height: 1, png: [137, 80, 78, 71, 13, 10, 26, 10] })
}, 60_000)
