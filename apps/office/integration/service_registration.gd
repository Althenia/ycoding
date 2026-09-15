## Where the CLI writes the local service registration, and how to read it.
##
## The contract lives in `packages/client/src/effect/service.ts`: the file sits
## under the STATE directory, not the config directory, and its schema is
## `{ url, pid, password?, id?, version? }`. Reading the config directory would
## never find it, so the path search is pinned here rather than duplicated.
##
## Attaching is read-only. Nothing here starts, stops or signals a daemon: a
## client that killed a shared service on exit would be taking ownership it was
## never given.
class_name ServiceRegistration
extends RefCounted

## Every place the registration may live, in precedence order. Empty inputs are
## skipped rather than joined, because an unset variable would otherwise produce
## a relative path such as "/ycoding/service.json" that silently never matches.
static func candidates(override: String, state_home: String, home: String) -> Array[String]:
	var paths: Array[String] = []
	if not override.strip_edges().is_empty():
		paths.append(override.strip_edges())
	if not state_home.strip_edges().is_empty():
		paths.append("%s/ycoding/service.json" % state_home.strip_edges())
	if not home.strip_edges().is_empty():
		paths.append("%s/.local/state/ycoding/service.json" % home.strip_edges())
	return paths


## Whether a parsed registration is usable: it must carry a URL, since the URL is
## the whole point of discovery. A file without one is treated as absent.
static func is_usable(parsed: Variant) -> bool:
	if not parsed is Dictionary:
		return false
	return not str(parsed.get("url", "")).strip_edges().is_empty()
