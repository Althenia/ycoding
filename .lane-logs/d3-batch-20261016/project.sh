#!/bin/sh
# usage: project.sh <outdir> <files...>  (projects maintained contract sources to <outdir>)
set -eu
out=$1; shift
cd packages/protocol
cat > proj.tmp.ts <<'TS'
import path from "node:path"
const out = process.argv[2]!
const imp = (f: string) => import(path.join(process.cwd(), "test", f))
const names = process.argv.slice(3)
await Bun.$`mkdir -p ${out}`
if (names.includes("session")) await Bun.write(`${out}/session.proto`, (await imp("session-contract.ts")).sessionProto())
if (names.includes("resources")) await Bun.write(`${out}/resources.proto`, (await imp("resources-contract.ts")).resourceProto())
if (names.includes("shared") || names.includes("platform")) {
  const platform = await imp("platform-contract.ts")
  if (names.includes("shared")) await Bun.write(`${out}/shared.proto`, platform.sharedProto())
  if (names.includes("platform")) await Bun.write(`${out}/platform.proto`, platform.platformProto())
}
if (names.includes("events")) await Bun.write(`${out}/events.proto`, (await imp("public-event-contract.ts")).publicEventProto())
TS
status=0
bun proj.tmp.ts "$out" "$@" || status=$?
rm -f proj.tmp.ts
exit $status
