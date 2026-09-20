## Recent and pinned projects.
##
## A project entry remembers a folder the user opened so they can return to it. The
## kit's model is `DesktopProjectEntry(local_entry_id, canonical_directory,
## resolved_project_id, resolved_location, display_name, pin_order, last_opened)`, and
## three of its rules are correctness rather than presentation:
##
##   * the CANONICAL DIRECTORY is the identity, so the same folder reached by two
##     routes is one entry and renaming never moves anything on disk;
##   * RENAME changes the display label only;
##   * REMOVE takes the entry out of the list and deletes NOTHING else -- no file, no
##     credential, no history.
##
## Canonicalization is delegated to `FolderTarget`, which owns those rules, so a
## symlink dedupes here for the same reason it does there.
##
## Counts and attention are DERIVED from the live projection rather than stored: a
## stored count would be stale the moment a session started.
class_name ProjectLedger
extends RefCounted

## ConfigFile section holding the entries, and the persisted path.
const SECTION := "projects"
const DEFAULT_PATH := "user://projects.cfg"

var file_path: String = DEFAULT_PATH

## A pin order of zero means "not pinned". Higher pin orders sort later, so pinning
## puts an entry above every recent without needing to renumber.
const UNPINNED := 0

var _entries: Array[Dictionary] = []
var _last_error: String = ""
var _next_sequence: int = 1


## Add a folder, or update the entry that already holds it.
##
## Deduplication is on the RESOLVED directory, so opening the same folder twice -- or
## through a symlink to it -- updates one entry rather than growing the list. Returns
## the entry, or an empty dictionary with a reason when the folder cannot be used.
func add(path: String, resolved_location: String = "", display_name: String = "") -> Dictionary:
	_last_error = ""
	var target := FolderTarget.new()
	var directory := target.resolve(path)
	if directory.is_empty():
		_last_error = target.last_error()
		return {}

	var existing := _index_of(directory)
	var label := display_name if not display_name.is_empty() else directory.get_file()
	var now := Time.get_unix_time_from_system()
	if existing >= 0:
		_entries[existing]["display_name"] = label
		if not resolved_location.is_empty():
			_entries[existing]["resolved_location"] = resolved_location
		_entries[existing]["last_opened"] = now
		return _entries[existing]

	var entry := {
		# An opaque local id, not a path: a path would change when the folder is
		# renamed on disk and would leak the filesystem into stored preferences.
		"local_entry_id": "prj_%d_%d" % [int(now), _next_sequence],
		"canonical_directory": directory,
		"resolved_project_id": "",
		"resolved_location": resolved_location,
		"display_name": label,
		"pin_order": UNPINNED,
		"last_opened": now,
	}
	_next_sequence += 1
	_entries.append(entry)
	return entry


## The entry holding a directory, or an empty dictionary. Matched on the canonical
## path, so a symlinked route finds the same entry.
func find_by_directory(directory: String) -> Dictionary:
	var index := _index_of(directory)
	return _entries[index] if index >= 0 else {}


## The entry with a local id, or an empty dictionary.
func find(local_entry_id: String) -> Dictionary:
	for entry in _entries:
		if str(entry["local_entry_id"]) == local_entry_id:
			return entry
	return {}


## Rename an entry's DISPLAY LABEL. Returns whether an entry was found.
##
## Nothing on disk is touched and the canonical directory is unchanged: the label is
## the user's name for the project, not the folder's name.
func rename(local_entry_id: String, display_name: String) -> bool:
	var entry := find(local_entry_id)
	if entry.is_empty() or display_name.strip_edges().is_empty():
		return false
	entry["display_name"] = display_name.strip_edges()
	return true


## Take an entry out of the list. Deletes the entry and NOTHING else.
##
## No file, directory, credential or history is removed: a project disappearing from
## a convenience list must never destroy the work inside it.
func remove(local_entry_id: String) -> bool:
	for index in _entries.size():
		if str(_entries[index]["local_entry_id"]) == local_entry_id:
			_entries.remove_at(index)
			return true
	return false


## Pin an entry at an order. A pin order above zero sorts it ahead of every recent.
func pin(local_entry_id: String, order: int = 1) -> bool:
	var entry := find(local_entry_id)
	if entry.is_empty() or order <= UNPINNED:
		return false
	entry["pin_order"] = order
	return true


## Return an entry to the recents. It stays in the list.
func unpin(local_entry_id: String) -> bool:
	var entry := find(local_entry_id)
	if entry.is_empty():
		return false
	entry["pin_order"] = UNPINNED
	return true


## Record that an entry was opened, so it leads the recents.
func touch(local_entry_id: String) -> bool:
	var entry := find(local_entry_id)
	if entry.is_empty():
		return false
	entry["last_opened"] = Time.get_unix_time_from_system()
	return true


## The entries in display order: pinned first by their own order, then recents by
## most-recently-opened. Deterministic, so the list does not reshuffle by accident.
func entries() -> Array[Dictionary]:
	var sorted := _entries.duplicate()
	sorted.sort_custom(func(a: Dictionary, b: Dictionary) -> bool:
		var pin_a := int(a["pin_order"])
		var pin_b := int(b["pin_order"])
		if pin_a != pin_b:
			# Pinned entries lead. An unpinned entry is order zero, so a positive
			# pin order must sort FIRST rather than by numeric ascending.
			if pin_a == UNPINNED:
				return false
			if pin_b == UNPINNED:
				return true
			return pin_a < pin_b
		return int(a["last_opened"]) > int(b["last_opened"])
	)
	return sorted


## Per-project counts for the sidebar, DERIVED from the projection at call time.
##
## A folder with nothing in it reports zeroes rather than being omitted, so the rail
## never has to decide what an absent key means.
func summary_for(directory: String, store: OfficeStore) -> Dictionary:
	var sessions := 0
	var running := 0
	var attention := 0
	# The projection carries the directory exactly as the service reported it, while an
	# entry is keyed by its CANONICAL path. Comparing the raw strings would therefore
	# miss every folder reached through a link -- on macOS that is every path under
	# /tmp, because /tmp is itself a symlink -- and the counts would silently read zero.
	# Both sides are canonicalized before they are compared.
	var wanted := _canonical(directory)
	for actor in store.actor_list():
		if _canonical(actor.location_directory) != wanted:
			continue
		sessions += 1
		if Presence.is_working(actor.work_state):
			running += 1
		if actor.attention_required:
			attention += 1
	return {"sessions": sessions, "running": running, "attention": attention}


func last_error() -> String:
	return _last_error


## Read the persisted list. A missing, unreadable or corrupt store falls back to an
## empty list rather than failing: losing a convenience list must not stop the office.
func load() -> void:
	_last_error = ""
	_entries = []
	var config := ConfigFile.new()
	var error := config.load(file_path)
	if error != OK:
		# A file that is simply absent is the normal first run, not a fault.
		if error != ERR_FILE_NOT_FOUND:
			_last_error = "The project list could not be read."
		return
	if not config.has_section(SECTION):
		return
	var raw: Variant = config.get_value(SECTION, "entries", null)
	if not (raw is Array):
		_last_error = "The project list was not in a readable form."
		return
	for value in (raw as Array):
		var entry := _sanitize(value)
		if not entry.is_empty():
			_entries.append(entry)
	_next_sequence = _entries.size() + 1


## Persist the list. Returns the write error so a caller can report it.
func save() -> Error:
	var config := ConfigFile.new()
	config.set_value(SECTION, "entries", _entries)
	return config.save(file_path)


## A stored row is only accepted when it still describes a real, canonical folder.
##
## A row whose folder has moved or been deleted on disk is DROPPED rather than kept
## as a broken entry, and the path is re-canonicalized so a stored symlink route is
## normalized rather than trusted.
static func _sanitize(value: Variant) -> Dictionary:
	if not (value is Dictionary):
		return {}
	var row: Dictionary = value
	var directory := str(row.get("canonical_directory", ""))
	if directory.is_empty() or not DirAccess.dir_exists_absolute(directory):
		return {}
	return {
		"local_entry_id": str(row.get("local_entry_id", "")) if not str(row.get("local_entry_id", "")).is_empty() else "prj_restored",
		"canonical_directory": directory,
		"resolved_project_id": str(row.get("resolved_project_id", "")),
		"resolved_location": str(row.get("resolved_location", "")),
		"display_name": str(row.get("display_name", directory.get_file())),
		"pin_order": int(row.get("pin_order", UNPINNED)),
		"last_opened": int(row.get("last_opened", 0)),
	}


## A directory in the form entries are keyed by. Falls back to the input when it
## cannot be resolved, so an unreachable path still compares as itself.
static func _canonical(directory: String) -> String:
	if directory.is_empty():
		return ""
	var target := FolderTarget.new()
	var canonical := target.resolve(directory)
	return canonical if not canonical.is_empty() else directory


## The index of the entry holding a directory, comparing CANONICAL paths.
func _index_of(directory: String) -> int:
	var wanted := _canonical(directory)
	for index in _entries.size():
		if str(_entries[index]["canonical_directory"]) == wanted:
			return index
	return -1
