#!/bin/sh
set -u
dir=.lane-logs/d3-batch-20261016
name=$1; shift
for s in command log exit inputs; do [ -e "$dir/$name.$s" ] && { echo "refusing to overwrite $dir/$name.$s"; exit 97; }; done
printf '%s\n' "$*" > "$dir/$name.command"
{ git rev-parse HEAD; git status --short packages protocol specs script | shasum -a 256; shasum -a 256 packages/protocol/test/*contract*.ts packages/protocol/test/wire-allocation.ts packages/protocol/test/usage-wire-contract.test.ts; } > "$dir/$name.inputs"
"$@" > "$dir/$name.log" 2>&1
echo $? > "$dir/$name.exit"
