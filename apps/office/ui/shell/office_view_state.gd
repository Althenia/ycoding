## Disposable per-project desktop view state.
##
## What the user was looking at in a project: the selected session and both actor
## identities, the unsent draft, the surface route, and where the camera and the
## walkable avatar were. It exists so returning to a project resumes the work rather
## than restarting the session.
##
## This is DESKTOP data, not runtime authority. Losing it costs the user a click; it
## never changes what the service runs, what a prompt targets, or what a session owns.
## The durable record stays server-owned.
##
## Three guarantees are structural rather than conventional:
##
##   * ONLY THE DECLARED FIELDS are ever copied, so a credential cannot reach the file
##     even when a caller hands one over;
##   * the file is SCHEMA-VERSIONED, and a version this build does not know is not
##     adopted - guessing at an unknown shape is how a preference store reads nonsense
##     as state;
##   * the write is ATOMIC through a temporary file in the same directory, so a write
##     that fails cannot leave a half-written preference where the good one was.
##
## Saved positions are not trusted: `safe_position` validates one against the CURRENT
## map and recovers to an unblocked spawn, because the map may have changed since the
## state was written and an avatar inside a wall is not a state worth restoring.
##
## Lives beside `OfficeRoute` because the route vocabulary is what it persists, and
## `ui/shell` already reads the map's own constants for its layout.
class_name OfficeViewState
extends RefCounted

## ConfigFile section holding everything this store owns.
const SECTION := "view"
## The schema version this build writes, and the only one it reads.
const SCHEMA_VERSION := 1
const VERSION_KEY := "version"
const STATES_KEY := "states"
const LAST_ENTRY_KEY := "last_entry_id"

## The default settings path under `user://`, per Godot's own persistence idiom.
const DEFAULT_PATH := "user://view_state.cfg"
## Suffix for the in-flight write. It sits beside the target so the rename that
## publishes it stays on one filesystem and is therefore atomic.
const TEMP_SUFFIX := ".tmp"

## The fields a project's state may carry, other than its own entry id which is the key.
## Exactly this list is copied, so an undeclared field - including a credential - is
## dropped at the boundary rather than trusted to stay out later.
const STORED_FIELDS := [
	"selected_session_id",
	"selected_actor_id",
	"unsent_draft",
	"view_route",
	"camera_state",
	"player_position",
	"settings_page",
]

## The file this store reads and writes when a caller names no path. Held on the instance
## so a caller can point one at its own file: a test must never write over the preference
## a person is actually using.
var file_path := DEFAULT_PATH

var _states: Dictionary = {}
var _last_entry_id := ""
var _last_error := ""


func last_error() -> String:
	return _last_error


## The project that was in front of the user when the state was last written.
func last_entry_id() -> String:
	return _last_entry_id


func set_last_entry_id(entry_id: String) -> void:
	_last_entry_id = entry_id


## The saved state for a project, or {} when nothing was saved for it. A project with no
## state has none rather than another project's.
func state_for(entry_id: String) -> Dictionary:
	var state: Variant = _states.get(entry_id, null)
	if state is Dictionary:
		return (state as Dictionary).duplicate(true)
	return {}


## Remember a project's state. The value is sanitized on the way in, so the store never
## holds a field it would refuse to write.
func remember(entry_id: String, state: Dictionary) -> void:
	if entry_id.is_empty():
		return
	_states[entry_id] = sanitize(state)


func forget(entry_id: String) -> void:
	_states.erase(entry_id)
	if _last_entry_id == entry_id:
		_last_entry_id = ""


## The temporary path a write goes through. Exposed so the atomicity of the write can be
## observed rather than assumed.
static func temp_path(path: String) -> String:
	return path + TEMP_SUFFIX


## Read the persisted state. Never fails: a file that is absent is the normal first run,
## and a file that cannot be read leaves an empty store with a readable reason.
func load(path: String = "") -> void:
	var target := path if not path.is_empty() else file_path
	_last_error = ""
	_states = {}
	_last_entry_id = ""
	var config := ConfigFile.new()
	var error := config.load(target)
	if error != OK:
		if error != ERR_FILE_NOT_FOUND:
			_last_error = "The saved view state could not be read."
		return
	var version := int(config.get_value(SECTION, VERSION_KEY, 0))
	if version != SCHEMA_VERSION:
		# The shape is unknown, so nothing in it is adopted. Reporting the version gap
		# is what keeps this from silently discarding a newer build's state.
		_last_error = "The saved view state is version %d, which this build does not read." % version
		return
	var raw: Variant = config.get_value(SECTION, STATES_KEY, null)
	if not (raw is Dictionary):
		if raw != null:
			_last_error = "The saved view state was not in a readable form."
		return
	for key in (raw as Dictionary):
		_states[str(key)] = sanitize((raw as Dictionary)[key])
	_last_entry_id = str(config.get_value(SECTION, LAST_ENTRY_KEY, ""))


## Persist the state atomically. Returns the write error so a caller can report it, and
## leaves an existing file untouched when the write cannot complete.
func save(path: String = "") -> Error:
	var target := path if not path.is_empty() else file_path
	var config := ConfigFile.new()
	config.set_value(SECTION, VERSION_KEY, SCHEMA_VERSION)
	config.set_value(SECTION, STATES_KEY, _states)
	if not _last_entry_id.is_empty():
		config.set_value(SECTION, LAST_ENTRY_KEY, _last_entry_id)
	var temp := temp_path(target)
	var error := config.save(temp)
	if error != OK:
		# A failed write must not leave a partial file where a preference is expected.
		if FileAccess.file_exists(temp):
			DirAccess.remove_absolute(temp)
		_last_error = "The view state could not be written."
		return error
	# The rename is what publishes it. Until this succeeds the previous file is still the
	# whole truth, which is why a failure here is recoverable and not a data loss.
	error = DirAccess.rename_absolute(temp, target)
	if error != OK:
		DirAccess.remove_absolute(temp)
		_last_error = "The view state could not be written."
		return error
	_last_error = ""
	return OK


## Keep only the declared fields, each in a shape the rest of the client can use.
##
## The map is deliberately NOT consulted here: this store persists, and validation
## against the live map happens at restore time through `safe_position` and
## `safe_camera`, because the map the state was written against may no longer exist.
static func sanitize(raw: Variant) -> Dictionary:
	var out := {}
	if not (raw is Dictionary):
		return out
	var source: Dictionary = raw
	for field in STORED_FIELDS:
		if not source.has(field):
			continue
		match field:
			"selected_session_id", "selected_actor_id", "unsent_draft":
				var text: Variant = source[field]
				if text is String:
					out[field] = text
			"view_route":
				var route := str(source[field])
				# A closed set: a route this build does not have falls back to the
				# default surface rather than restoring nothing at all.
				out[field] = route if OfficeRoute.ALL.has(route) else OfficeRoute.DEFAULT
			"settings_page":
				var page := str(source[field])
				# A closed set too: a page this build does not have is dropped rather
				# than restored, and the surface falls back to its default page.
				if SettingsGroup.is_page(page):
					out[field] = page
			"camera_state":
				var camera: Variant = source[field]
				if camera is Dictionary:
					out[field] = (camera as Dictionary).duplicate(true)
			"player_position":
				if _as_position(source[field]) != null:
					out[field] = _as_position(source[field])
	return out


## The cell a position stands on. Truncating matches the navigation's own rule, so a
## validated position and a routed position agree about which cell they are in.
static func cell_of(position: Vector2) -> Vector2i:
	return Vector2i(
		int(position.x / OfficeNavigation.TILE), int(position.y / OfficeNavigation.TILE)
	)


## A position that can be restored without the avatar ending up inside the geometry.
##
## A saved position is only usable when it is on the map AND standing on a cell the map
## does not block. Anything else - a wall, a desk, off the map, or not a position at all -
## recovers to the spawn, because the map may have changed since the state was written
## and an avatar inside a wall is not a state worth restoring.
static func safe_position(raw: Variant, navigation: OfficeNavigation) -> Vector2:
	if navigation == null:
		return Vector2.ZERO
	var position: Variant = _as_position(raw)
	if position != null and _is_usable(position, navigation):
		return position
	return recover_position(navigation)


## The first cell the map does not block, scanning in reading order. Deterministic, so
## recovery is reproducible, and always on the map.
static func recover_position(navigation: OfficeNavigation) -> Vector2:
	if navigation == null or navigation.width <= 0 or navigation.height <= 0:
		return Vector2.ZERO
	for y in navigation.height:
		for x in navigation.width:
			var cell := Vector2i(x, y)
			if not navigation.is_blocked(cell):
				return Vector2(cell) * OfficeNavigation.TILE + OfficeNavigation.CENTRE_OFFSET
	# A completely blocked map has no unblocked cell. The centre is returned rather than
	# a corner, so the caller is still inside the map it was given.
	return Vector2(navigation.width, navigation.height) * OfficeNavigation.TILE * 0.5


## A camera state this client can actually restore.
##
## The position is brought back inside the map, because a view parked off the map shows
## the user nothing. The ZOOM BOUND is deliberately left to the viewport: it owns that
## rule, so a zoom this store cannot vouch for is dropped and the viewport fits the world
## rather than the store guessing a bound it does not own.
static func safe_camera(raw: Variant, navigation: OfficeNavigation) -> Dictionary:
	var out := {}
	if not (raw is Dictionary) or navigation == null:
		return out
	var camera: Dictionary = raw
	var position: Variant = _as_position(camera.get("position", null))
	if position != null:
		var bounds := Vector2(navigation.width, navigation.height) * OfficeNavigation.TILE
		out["position"] = (position as Vector2).clamp(Vector2.ZERO, bounds)
	var zoom: Variant = camera.get("zoom", null)
	if (zoom is float or zoom is int) and is_finite(float(zoom)) and float(zoom) > 0.0:
		out["zoom"] = float(zoom)
	return out


## A position, or null when the value is not one. Never coerced: a number is not a place.
static func _as_position(raw: Variant) -> Variant:
	if raw is Vector2:
		return raw
	if raw is Vector2i:
		return Vector2(raw)
	return null


static func _is_usable(position: Vector2, navigation: OfficeNavigation) -> bool:
	if not is_finite(position.x) or not is_finite(position.y):
		return false
	var bounds := Vector2(navigation.width, navigation.height) * OfficeNavigation.TILE
	if position.x < 0.0 or position.y < 0.0:
		return false
	if position.x >= bounds.x or position.y >= bounds.y:
		return false
	return not navigation.is_blocked(cell_of(position))
