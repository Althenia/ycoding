## What the location header must contain (R5-07 finding).
##
## The server reads the location from `x-ycoding-directory` and runs `decodeURIComponent`
## on it (packages/server/src/location.ts). The client was sending the RAW path, so:
##   * a path containing `%` was CORRUPTED, because the server decoded an escape the client
##     never wrote - `/tmp/100%-folder` arrived as `/tmp/100-folder`;
##   * a path containing non-ASCII characters was refused with HTTP 500.
##
## This prints candidate encodings and what the server's own decode does to each, so the
## encoding is chosen from evidence rather than assumed.
##
## Kit-local; no repository source depends on it.
##
## Run:
##   godot --headless --path apps/office --script res://r5_07_encode_tmp.gd
extends SceneTree


func _initialize() -> void:
	var samples := [
		"/Users/viadz/Workspace/Project/ycoding",
		"/tmp/ycoding-r507-spaced folder",
		"/tmp/ycoding-r507-ünïcodé—folder",
		"/tmp/ycoding-r507-100%-folder",
	]
	for path in samples:
		var encoded: String = path.uri_encode()
		print("R507E path=", path)
		print("R507E   uri_encode()=", encoded)
		print("R507E   uri_decode(uri_encode()) roundtrips=", str(encoded.uri_decode() == path))
		print("R507E   contains_only_ascii=", str(encoded.to_utf8_buffer().size() == encoded.length()))
	quit(0)
