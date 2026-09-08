#!/usr/bin/env bun

import path from "node:path"
import { buildPages } from "./pages"

const root = path.resolve(import.meta.dirname, "..")
const outdir =
  process.argv.at(2) === "--outdir" && process.argv.at(3)
    ? path.resolve(process.argv[3])
    : path.join(root, "dist", "pages")

await buildPages({ root, outdir })
