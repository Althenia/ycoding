## Shell and file-change detail from the runtime.
##
## Two things the office showed nothing about, or showed less honestly than the wire allows:
##
## SHELL - the runtime emits `session.shell.started` and `session.shell.ended` carrying
## `Shell.Info`, and exposes `shell.list`, `shell.get` and a PAGEABLE `shell.output`
## (packages/schema/src/shell.ts, packages/protocol/src/groups/shell.ts). A session that ran
## commands therefore showed nothing at all about them.
##
## The clause that shapes this reader is "do not substitute a fake terminal". What it holds is
## READ-ONLY detail about a command the runtime already ran - its command, its working
## directory, its status and its captured output - and `is_read_only` states that so a view
## cannot quietly grow an input box and start pretending to be a terminal.
##
## FILE CHANGE - a patch is an EXCERPT, so it is bounded and the cut is marked. Presenting a
## bounded patch as the whole change would misrepresent what changed, and the counts alone do
## not tell a reader that the text they see is incomplete.
class_name ShellView
extends RefCounted

## The durable events the runtime reports a shell with.
const SHELL_STARTED := "session.shell.started"
const SHELL_ENDED := "session.shell.ended"

## The statuses the schema declares. A shell that is `running` is NOT settled, and a status
## this build does not know is never treated as finished: claiming a command ended when the
## runtime did not say so is the same untruth as an invented success.
const RUNNING := "running"
const SETTLED_STATUSES := ["exited", "timeout", "memory-limit", "killed"]

## How much of a patch a row carries. A patch can be enormous, and a row that carries all of it
## is unusable; the cut is MARKED, because the patch is an excerpt by nature.
const PATCH_LIMIT := 4000
const TRUNCATION_MARK := "…"


## Whether the runtime reported this shell as finished.
##
## An unknown or absent status is NOT settled, so a new runtime status cannot silently read as
## a completed command.
static func is_settled(row: Dictionary) -> bool:
	var status := str(row.get("status", ""))
	if status.is_empty():
		return false
	return SETTLED_STATUSES.has(status)


## A row's captured output, in the shape the output route returns: the text, the cursor after
## it, the total size, and whether the capture was truncated.
static func output_of(row: Dictionary) -> Dictionary:
	var output: Variant = row.get("output", {})
	if output is Dictionary:
		return output
	return {}


## Whether more output remains to be read. The runtime supplies `cursor` and `size` for exactly
## this, so a reader never presents one page as the whole output.
static func has_more(output: Dictionary) -> bool:
	var cursor := int(output.get("cursor", 0))
	var size := int(output.get("size", 0))
	return cursor < size


## Whether the runtime reported the capture as truncated. Truncated output is NOT the whole of
## what the command produced, and a reader must not treat it as the whole.
static func is_truncated(output: Dictionary) -> bool:
	return bool(output.get("truncated", false))


## Whether a shell row is read-only detail rather than something to interact with.
##
## The row states this itself, so a view cannot grow an input box and still pass: anything that
## accepted input would have to stop claiming to be read-only. A row that does not claim it is
## NOT treated as read-only.
static func is_read_only(row: Dictionary) -> bool:
	return bool(row.get("read_only", false))


## Bound a patch excerpt, marking the cut. A silent cut would present a partial change as the
## whole of it.
static func bound_patch(patch: String) -> String:
	if patch.length() <= PATCH_LIMIT:
		return patch
	return patch.substr(0, PATCH_LIMIT) + TRUNCATION_MARK
